/**
 * /api/gemini/chat — streaming chat endpoint for the in-hub Gemini
 * assistant. Server-Sent Events:
 *
 *   event: text     data: { "text": "chunk" }
 *   event: tool     data: { "name": "...", "args": {...} }
 *   event: done     data: { "inputTokens": N, "outputTokens": N }
 *   event: error    data: { "error": "..." }
 *
 * Each user message triggers a fresh tool-execution loop. Internally
 * the loop may run several Gemini turns + several tool executions
 * before the model emits the final text — only the final text streams
 * back to the client (chunked as it's generated). The client doesn't
 * persist internal tool-call/tool-result turns; the next user message
 * starts a new loop with just the user/model text history.
 *
 * Staff-only. Client users (col-E roster only) get 403 — DWD doesn't
 * impersonate non-fandf users so the Workspace tools wouldn't work
 * anyway. Hidden in the UI for them too.
 */

import { auth } from "@/auth";
import { getEffectiveViewAs } from "@/lib/viewAsCookie";
import { getMyProjects } from "@/lib/appsScript";
import {
  streamGemini,
  type GeminiTurn,
  type GeminiFunctionCall,
} from "@/lib/gemini";
import { TOOL_DECLARATIONS, getTool } from "@/lib/geminiTools";
import {
  snapshotToSystemBlock,
  type PageContextSnapshot,
} from "@/lib/pageContextSnapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ClientMessage = { role: "user" | "model"; text: string };

type Body = {
  messages: ClientMessage[];
  pageContext?: PageContextSnapshot;
};

const SYSTEM_PERSONA = `
You are the F&F Hub assistant — a helpful Hebrew/English bilingual
assistant embedded in the team's internal hub. Users are F&F staff
(account managers, designers, copywriters, media managers, devs).

Your job:
- Answer questions about hub data (projects, tasks, comments, contacts)
  and Workspace data (the user's Gmail, Drive, Docs).
- Help find related context across both worlds — e.g. "what's the
  latest from Lora at Gindy?" should resolve Lora → email via
  getCompanyContacts, then search Gmail/Drive.
- Read the four hub/dashboard spreadsheets directly when a question
  needs raw data the structured tools don't expose (campaign metrics,
  archived snapshots, weekly trends, etc.) — see DATA SOURCES below.
- Explain how the hub itself works when asked — see HUB GUIDE below.
- Lean on the page context the user is currently looking at; if the
  user references "this task" / "this project", use the page-context
  label or path to disambiguate.

Style:
- Reply in the user's language. Hebrew users write Hebrew → respond in
  Hebrew. Mixed Hebrew/English → match the user's preference.
- Be concise. 2-4 sentences for simple answers, bullet lists for
  multi-item answers, no preamble.
- Don't write tasks, draft emails, or generate creative content in V1
  — those are coming later. If asked, politely defer.

Citations + links (REQUIRED — the UI renders these as clickable):
- Always cite sources when you used a tool. Use markdown link syntax
  '[label](url)' so the UI can render them as clickable anchors.
- Hub items use RELATIVE paths so the link stays in-app:
    [task title](/tasks/T-abc123)
    [project name](/projects/<exact-project-name>)
    [company name](/companies/<exact-company-name>)
- Gmail threads: link to https://mail.google.com/mail/u/0/#inbox/<threadId>
  using the threadId returned by searchGmail.
- Drive files: use the 'webViewLink' string searchDrive returned for
  that file. Don't construct Drive URLs by hand from the file id.
- Plain text URLs work too (auto-linkified) but prefer '[label](url)'
  with a meaningful label.
- For multi-item answers, link each item — e.g. a bullet list of tasks
  should be 5 separate '[title](/tasks/id)' links, not one paragraph
  ending with "see tasks 1/2/3/4/5".

Tool usage:
- Prefer hub resolvers (getTask, getProject, getCompanyContacts) before
  Workspace searches — the hub knows who's who.
- searchGmail / searchDrive accept query strings in their native syntax;
  use the same operators a power user would type into the search box
  (from:, has:attachment, fullText contains, etc.).
- After searchGmail returns thread summaries, only call readGmailThread
  for the thread the user actually cares about — don't fan out to all of
  them. Same with readDoc after searchDrive.

Privacy: only the signed-in user's data. Tools impersonate the user via
domain-wide delegation, so you can't see anyone else's Gmail/Drive. Keep
results to the user.

═════════════════════════════════════════════════════════════════════
DATA SOURCES — the four spreadsheets behind the hub + dashboard
═════════════════════════════════════════════════════════════════════

When a question needs raw spreadsheet data, use getSheetMetadata
first to pick the right tab + columns, then readSheetTab. Don't
guess column positions — always read headers first.

1. MAIN HUB SHEET    — id: 15GKqEy8OelYtGuuiHYkSAR2xNNL4icwo-Wgiq1suW0Y
   Contains:
     • 'ALL CLIENTS' — master cross-platform metrics, one row per
       (company, project, campaign). Live, refreshed by Supermetrics.
     • 'Keys' — project roster: company, project, mediaManager,
       projectManager, clientEmails (col E), internal team (col J),
       client-facing team (col K), Chat-space URL, etc.
     • Several per-platform feed tabs (GADS2, Facebook adsets, etc.)
     • Per-platform creative tabs.
   Use for: "who's on this project?", "which projects under גוהרי?",
   "what's the live spend on Q3 שלמי?"

2. COMMENTS SHEET   — id: 1ZpdfJhdYa6aD5iftTsGJuVMLTS9WlzHGZMevq5hrxGU
   Contains:
     • 'Comments' — every chat message + comment + task across the
       hub. Schema includes id, project, company, author_email,
       body, created_at, mentions, status, parent_id, etc. (this
       is where tasks live too — task type rows.)
     • 'names to emails' — F&F staff roster: full name, Hebrew
       name, email, role.
     • 'Form Schemas' — task-form schema overrides per kind.
     • 'Chat Spaces' — Google Chat space resource names per project.
   Use for: deep dive into a task's history, finding who-said-what,
   raw mention/notification data the hub UI doesn't surface.

3. ARCHIVE SHEET    — id: 1V3HTUk7NMm6mbHqZygHyXp-amkiclNkGkF3ipyt7i0Q
   Contains:
     • 'ALL_CLIENTS_ARCHIVE' — weekly snapshots of ALL CLIENTS so
       the dashboard supports historical time-travel.
     • Creative snapshot tabs (point-in-time creative metadata).
   Use for: "how did גוהרי do two months ago vs. now?", "show me
   the Aug 4th archive". Not for live data — the main sheet is
   always more current.

4. CREATIVE SHEET   — id: 1q-WFtFLDnltznwYKax2yZ1O-q_VToULWN8-sn-8xXuA
   Contains:
     • 'facebook-ads-metrics' — per-day × per-ad performance from
       FB (Date, Imp, Cost, Clicks, Leads, etc.).
     • 'facebook-ads-assets links' — point-in-time creative
       metadata per ad (image URL, body, title, status).
     • 'Facebook-adsets' — per-day × adset (project totalCost
       + totalLeads source-of-truth).
   Use for: detailed FB creative perf questions ("which creative
   has the best CPA?", "show me ads for גינדי last week").

═════════════════════════════════════════════════════════════════════
HUB GUIDE — how the F&F Hub is organized + how to operate it
═════════════════════════════════════════════════════════════════════

Use this when the user asks "how do I…" / "where is…" / "what
does X mean" — answer from this guide directly without calling
tools, unless the question is about specific data.

CONCEPTS
- Company → Project → Task hierarchy. A company (e.g. גוהרי) has
  multiple projects (e.g. "ג'ייד"). Each project has its own
  Drive folder, Chat space, roster, and task queue.
- Campaign (בריף) — an optional sub-grouping within a project,
  often used to bundle tasks that ship together.
- Task — the unit of work. Has a kind (sometimes), assignees,
  approver, requested date, status, comments thread, optional
  Drive folder + Google Tasks mirror per assignee.
- Umbrella + chain — an umbrella task collects child tasks under
  it. A chain umbrella additionally enforces a sequential order
  via blocked_by edges. Visually: 🪆 = umbrella, 🌂 = parallel
  child, 🔗 = chain child.
- Roles / departments: media (🎯), studio (🖼️), copy (✍️),
  account/PM (📊), client manager (🤝), dev (⚙️). Drives the
  emoji + chip you see on people throughout the UI.

KEY SURFACES
- /              — home grid: every project the user can see, with
                   per-project quick-links (Chat space, Drive
                   folder, dashboard report).
- /tasks         — portfolio task queue (lifecycle buckets, group-
                   by axis, drag-to-reorder, kanban + calendar
                   views, filters by company/project/assignee).
- /tasks/[id]    — task detail: comments, files, status history,
                   dependencies, side-rail metadata.
- /tasks/new     — create a task. People-pickers, multi-assignee
                   modes (joined / parallel umbrella / chain),
                   Drive Picker for files.
- /projects/[name] — project page: live metrics, recent activity,
                   roster, quick chat-feed, Clarity insights.
- /companies/[c] — company page: list of projects under that
                   company.
- /campaigns     — campaign overview surface.
- /notifications — mentions + assignments + status flips for the
                   signed-in user.
- /inbox         — client-tag triage queue (תיוגי לקוח).
- /admin/*       — admin-only configuration: Keys editor,
                   names-to-emails, chat-spaces, user-prefs,
                   task-form-schema. Reachable via the gear menu.

LIFECYCLE STATUSES
ממתין לטיפול → בעבודה → ממתין לאישור → בוצע
                        → ממתין לבירור (parked, blocked-for-info)
                        → בוטל (cancelled)
Statuses live in the per-row dropdown; flipping to "ממתין לאישור"
auto-emails the approver. Flipping to "בוצע" auto-completes any
mirrored Google Task on assignees' personal Tasks lists.

WORKFLOWS
- Add a task: /tasks/new (or "+ משימה חדשה" on /tasks). Pick
  company → project → kind → assignees → details.
- Reorder tasks: drag the ⋮⋮ handle on /tasks (under the default
  "סדר ידני" rank sort). Cross-bucket drops not supported under
  non-status group axes.
- See another person's queue: gear menu → "הצג כ" → enter their
  email. Banner at top of page shows you're acting as them.
- Snooze hub notifications: gear menu → השתק (1h, today, 7d).
- See archived done/cancelled tasks: gear menu → uncheck "הסתר
  משימות שבוצעו / בוטלו", or click the bucket pill to unfold.
- Dashboard for a project: home grid → project card → "🔗 דשבורד"
  link, or top-nav → דשבורד (jumps to the main one).

PEOPLE
- Hebrew name + role emoji on every person chip / avatar tooltip.
- Resolved via the 'names to emails' tab — has columns for full
  English name, Hebrew name, email, role.
- Clients: only see the project they're on, no /tasks portfolio
  surface. They see a slimmed home grid + chat thread.
`.trim();

function ssePack(event: string, data: unknown): Uint8Array {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return new TextEncoder().encode(payload);
}

export async function POST(req: Request) {
  const session = await auth();
  const myEmail = session?.user?.email;
  if (!myEmail) {
    return new Response(
      JSON.stringify({ error: "not authenticated" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  // Staff-only gate. Reuses the same projects-fetch the layout does to
  // determine isClientUser. Returns 403 (not 401) so the UI can
  // distinguish "needs login" from "you're not allowed here".
  let isStaff = false;
  try {
    const data = await getMyProjects();
    isStaff = !!(data.isAdmin || data.isStaff || data.isInternal);
  } catch {
    // Failure to determine staff status → deny conservatively.
    isStaff = false;
  }
  if (!isStaff) {
    return new Response(
      JSON.stringify({ error: "chat is staff-only" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid JSON body" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(
      JSON.stringify({ error: "messages[] is required" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // Honor the user's view-as cookie for the SUBJECT email passed to
  // tools. If a manager has switched into "view as Lora", their hub
  // experience already filters as Lora — the chat should answer as
  // Lora's perspective too. That email is what the SA will impersonate
  // for Workspace tool calls.
  const viewAs = await getEffectiveViewAs(myEmail).catch(() => "");
  const subjectEmail = viewAs || myEmail;

  // Build system prompt. Page context renders as a clearly-delimited
  // block at the end so the model treats it as data, not instructions.
  const systemParts = [SYSTEM_PERSONA];
  if (body.pageContext) {
    systemParts.push(snapshotToSystemBlock(body.pageContext));
  }
  const system = systemParts.join("\n\n");

  // Convert client messages → GeminiTurn[]. Client only sends user +
  // model text turns; internal tool turns stay server-side.
  const history: GeminiTurn[] = body.messages.map((m) =>
    m.role === "user"
      ? { role: "user" as const, text: m.text }
      : { role: "model" as const, text: m.text },
  );

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(ssePack(event, data));

      try {
        // Tool-execution loop. Bound at 8 iterations — generous enough
        // for "search Gmail then read thread then look up task" chains
        // without letting a runaway loop burn tokens.
        const MAX_ITERATIONS = 8;
        let totalInput = 0;
        let totalOutput = 0;

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
          let lastFunctionCalls: GeminiFunctionCall[] = [];
          let lastInputTokens = 0;
          let lastOutputTokens = 0;
          let textInThisTurn = "";

          for await (const chunk of streamGemini({
            system,
            history,
            tools: TOOL_DECLARATIONS,
          })) {
            if ("text" in chunk) {
              textInThisTurn += chunk.text;
              send("text", { text: chunk.text });
            } else {
              lastFunctionCalls = chunk.functionCalls;
              lastInputTokens = chunk.inputTokens;
              lastOutputTokens = chunk.outputTokens;
            }
          }

          totalInput += lastInputTokens;
          totalOutput += lastOutputTokens;

          if (lastFunctionCalls.length === 0) {
            // Model finished — terminate the loop.
            send("done", {
              inputTokens: totalInput,
              outputTokens: totalOutput,
            });
            controller.close();
            return;
          }

          // Append the model's function-call turn + execute each tool +
          // append a function-results turn. Then loop back to let the
          // model see the results and either call more tools or compose
          // the final answer.
          if (textInThisTurn) {
            // Some Gemini turns emit BOTH text and function calls.
            // Preserve the partial text in history alongside the calls.
            history.push({ role: "model", text: textInThisTurn });
          }
          history.push({ role: "model", functionCalls: lastFunctionCalls });

          const results = await Promise.all(
            lastFunctionCalls.map(async (fc) => {
              send("tool", { name: fc.name, args: fc.args });
              const tool = getTool(fc.name);
              if (!tool) {
                return {
                  name: fc.name,
                  response: { ok: false, error: `unknown tool: ${fc.name}` },
                };
              }
              try {
                const result = await tool.execute(subjectEmail, fc.args);
                return { name: fc.name, response: { ok: true, result } };
              } catch (e) {
                return {
                  name: fc.name,
                  response: {
                    ok: false,
                    error: e instanceof Error ? e.message : String(e),
                  },
                };
              }
            }),
          );
          history.push({ role: "function", results });
        }

        // Hit the iteration cap without a clean answer — surface that
        // to the user instead of silently truncating.
        send("error", {
          error: `tool-execution loop exceeded ${MAX_ITERATIONS} iterations`,
        });
        controller.close();
      } catch (e) {
        send("error", {
          error: e instanceof Error ? e.message : String(e),
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no", // disable any proxy buffering
    },
  });
}

