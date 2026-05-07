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

