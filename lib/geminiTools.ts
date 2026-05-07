/**
 * Tool catalog exposed to Gemini in the chat assistant.
 *
 * Two-layer design mirrors the one in the Anthropic agent docs:
 *   1. Each tool ships a `FunctionDeclaration` (the JSON-Schema-style
 *      contract Gemini reads to decide when + how to call it).
 *   2. Each tool ships an `execute(subjectEmail, args)` function the
 *      chat route invokes when Gemini emits a function call.
 *
 * Subject email is the signed-in user — every tool runs as them via
 * the existing SA + DWD impersonation. There's no privilege
 * escalation: the chat can only read what the user could read by
 * navigating the hub or opening their own Gmail / Drive.
 *
 * V1 catalog (read-only):
 *   • Hub resolvers: getTask, getProject, getCompanyContacts
 *   • Workspace reads: searchGmail, readGmailThread, searchDrive, readDoc
 *
 * Deferred for V1.5+:
 *   • Write tools (createTask, updateTask) — safer to ship after we
 *     have a confirmation-flow UX in the drawer.
 *   • Calendar (V2 — calendar.events.readonly already in DWD).
 *   • Sheet reads — most useful sheet data is already exposed via
 *     getTask / getProject; raw sheet access is a power-user escape
 *     hatch we can add when a real need surfaces.
 */

import { SchemaType, type FunctionDeclaration } from "@google-cloud/vertexai";
import { google } from "googleapis";
import { gmailReadClient, driveClient, getSAClient } from "@/lib/sa";

export type ToolExecutor = (
  subjectEmail: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type Tool = {
  declaration: FunctionDeclaration;
  execute: ToolExecutor;
};

// ── Arg helpers ──────────────────────────────────────────────────────

function requireString(
  args: Record<string, unknown>,
  key: string,
): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`tool argument '${key}' is required (got ${typeof v})`);
  }
  return v.trim();
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) return undefined;
  return v.trim();
}

function optionalInt(
  args: Record<string, unknown>,
  key: string,
  defaultVal: number,
  cap: number,
): number {
  const v = args[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(Math.floor(n), cap);
}

// ── Hub resolvers ────────────────────────────────────────────────────

const getTaskTool: Tool = {
  declaration: {
    name: "getTask",
    description:
      "Fetch a hub task (work item) by its id. Returns the task with " +
      "its title, description, status, assignees, dates, comments, and " +
      "linked Drive folder. Use when the user references a task or when " +
      "the page context indicates the user is on a task page (path " +
      "starts with /tasks/).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        id: {
          type: SchemaType.STRING,
          description:
            "Task id, formatted like 'T-abc123-xyz'. Visible in URLs " +
            "(/tasks/T-abc123-xyz) and in the page-context label.",
        },
      },
      required: ["id"],
    },
  },
  execute: async (email, args) => {
    const id = requireString(args, "id");
    const { tasksGetDirect } = await import("@/lib/tasksDirect");
    return tasksGetDirect(email, id);
  },
};

const getProjectTool: Tool = {
  declaration: {
    name: "getProject",
    description:
      "Look up a hub project by name. Returns the project's company, " +
      "Chat space URL, and full roster (media manager, account manager, " +
      "client emails, internal team, client-facing team). Use when the " +
      "user asks about a specific project or wants to know who's on it.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: "Project name as it appears in the hub.",
        },
      },
      required: ["name"],
    },
  },
  execute: async (email, args) => {
    const name = requireString(args, "name");
    const { getMyProjectsDirect } = await import("@/lib/projectsDirect");
    const data = await getMyProjectsDirect(email);
    const lc = name.toLowerCase().trim();
    const match = data.projects.find(
      (p) => p.name.toLowerCase().trim() === lc,
    );
    if (!match) {
      return {
        ok: false,
        error: `no project named '${name}' is visible to ${email}`,
      };
    }
    return { ok: true, project: match };
  },
};

const getCompanyContactsTool: Tool = {
  declaration: {
    name: "getCompanyContacts",
    description:
      "List the contacts (people + their emails + roles) associated " +
      "with a company across all projects under that company. Useful " +
      "for resolving a person's name to an email so other tools " +
      "(searchGmail, searchDrive) can be called with the right query. " +
      "Returns the union of every project's roster under that company.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        company: {
          type: SchemaType.STRING,
          description: "Company name as it appears in the hub.",
        },
      },
      required: ["company"],
    },
  },
  execute: async (email, args) => {
    const company = requireString(args, "company");
    const { getMyProjectsDirect } = await import("@/lib/projectsDirect");
    const data = await getMyProjectsDirect(email);
    const lc = company.toLowerCase().trim();
    const matches = data.projects.filter(
      (p) => (p.company || "").toLowerCase().trim() === lc,
    );
    if (matches.length === 0) {
      return { ok: false, error: `no projects found for company '${company}'` };
    }
    // Aggregate the rosters across every matching project.
    const clientEmails = new Set<string>();
    const internalNames = new Set<string>();
    const clientFacingNames = new Set<string>();
    const accountManagers = new Set<string>();
    const mediaManagers = new Set<string>();
    for (const p of matches) {
      for (const e of p.roster.clientEmails || []) clientEmails.add(e);
      for (const n of p.roster.internalOnly || []) internalNames.add(n);
      for (const n of p.roster.clientFacing || []) clientFacingNames.add(n);
      if (p.roster.projectManagerFull)
        accountManagers.add(p.roster.projectManagerFull);
      if (p.roster.mediaManager) mediaManagers.add(p.roster.mediaManager);
    }
    return {
      ok: true,
      company,
      projects: matches.map((p) => p.name),
      clientEmails: Array.from(clientEmails),
      accountManagers: Array.from(accountManagers),
      mediaManagers: Array.from(mediaManagers),
      internalTeam: Array.from(internalNames),
      clientFacingTeam: Array.from(clientFacingNames),
    };
  },
};

// ── Gmail read tools ────────────────────────────────────────────────

const searchGmailTool: Tool = {
  declaration: {
    name: "searchGmail",
    description:
      "Search the user's own Gmail. Pass a Gmail-style query (e.g. " +
      "'from:lora@example.com', 'subject:campaign Q3', " +
      "'has:attachment newer_than:7d'). Returns up to maxResults " +
      "thread summaries (subject, sender, snippet, threadId). Call " +
      "readGmailThread with a threadId to read the full thread.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            "Gmail search query in Gmail's standard syntax — same as " +
            "the search box in gmail.com.",
        },
        maxResults: {
          type: SchemaType.INTEGER,
          description: "Max threads to return (1-25, default 10).",
        },
      },
      required: ["query"],
    },
  },
  execute: async (email, args) => {
    const q = requireString(args, "query");
    const maxResults = optionalInt(args, "maxResults", 10, 25);
    const gmail = gmailReadClient(email);
    const list = await gmail.users.threads.list({
      userId: "me",
      q,
      maxResults,
    });
    const threads = list.data.threads || [];
    if (threads.length === 0) return { ok: true, threads: [] };
    // For each thread, pull the metadata of the LAST message (most
    // recent) to surface a useful summary without N round trips.
    // Vertex's tool-result size is generous but we still want compact
    // results — drop snippets > 250 chars.
    const summaries = await Promise.all(
      threads.map(async (t) => {
        try {
          const detail = await gmail.users.threads.get({
            userId: "me",
            id: t.id!,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          });
          const msgs = detail.data.messages || [];
          const last = msgs[msgs.length - 1];
          const headers = last?.payload?.headers || [];
          const get = (name: string) =>
            headers.find(
              (h) => (h.name || "").toLowerCase() === name.toLowerCase(),
            )?.value || "";
          const snippet = (last?.snippet || "").slice(0, 250);
          return {
            threadId: t.id,
            messageCount: msgs.length,
            subject: get("Subject"),
            from: get("From"),
            date: get("Date"),
            snippet,
          };
        } catch {
          return { threadId: t.id, error: "failed to load thread metadata" };
        }
      }),
    );
    return { ok: true, threads: summaries };
  },
};

const readGmailThreadTool: Tool = {
  declaration: {
    name: "readGmailThread",
    description:
      "Read the full body of every message in a Gmail thread. Returns " +
      "an ordered list of messages with sender, date, and body text. " +
      "Use after searchGmail returns a relevant threadId.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        threadId: {
          type: SchemaType.STRING,
          description: "Gmail thread id from searchGmail's result.",
        },
      },
      required: ["threadId"],
    },
  },
  execute: async (email, args) => {
    const threadId = requireString(args, "threadId");
    const gmail = gmailReadClient(email);
    const detail = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });
    const msgs = (detail.data.messages || []).map((m) => {
      const headers = m.payload?.headers || [];
      const get = (name: string) =>
        headers.find(
          (h) => (h.name || "").toLowerCase() === name.toLowerCase(),
        )?.value || "";
      const body = extractGmailBody(m.payload);
      return {
        id: m.id,
        from: get("From"),
        to: get("To"),
        date: get("Date"),
        subject: get("Subject"),
        body: body.slice(0, 5000), // cap per message
      };
    });
    return { ok: true, threadId, messageCount: msgs.length, messages: msgs };
  },
};

/** Walk a Gmail message payload tree to find the best plain-text body.
 *  Prefers text/plain; falls back to text/html with tags stripped.
 *  Returns "" when neither part exists. */
function extractGmailBody(
  payload: import("googleapis").gmail_v1.Schema$MessagePart | undefined,
): string {
  if (!payload) return "";
  // Direct body text on the part itself.
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, "base64").toString("utf8");
    if ((payload.mimeType || "").includes("text/html")) {
      return stripHtml(decoded);
    }
    return decoded;
  }
  // Recurse into multipart parts. Prefer text/plain.
  const parts = payload.parts || [];
  let plain = "";
  let html = "";
  for (const p of parts) {
    if ((p.mimeType || "") === "text/plain" && !plain) {
      plain = extractGmailBody(p);
    } else if ((p.mimeType || "") === "text/html" && !html) {
      html = extractGmailBody(p);
    } else if ((p.mimeType || "").startsWith("multipart/")) {
      const inner = extractGmailBody(p);
      if (!plain) plain = inner;
    }
  }
  return plain || html;
}

function stripHtml(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Drive read tools ────────────────────────────────────────────────

const searchDriveTool: Tool = {
  declaration: {
    name: "searchDrive",
    description:
      "Search the user's accessible Drive files (My Drive + Shared " +
      "drives the user is a member of). Returns id, name, mimeType, " +
      "modifiedTime, owner, and webViewLink. Call readDoc with a file " +
      "id to read the full text of a Google Doc.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            "Drive search query in Drive's API syntax — e.g. " +
            "\"name contains 'campaign'\", \"'lora@example.com' in owners\", " +
            "\"mimeType='application/vnd.google-apps.document'\". For a " +
            "free-text search, use \"fullText contains 'WORDS'\" — that " +
            "matches against the indexed text inside docs/sheets/PDFs.",
        },
        maxResults: {
          type: SchemaType.INTEGER,
          description: "Max files to return (1-25, default 10).",
        },
      },
      required: ["query"],
    },
  },
  execute: async (email, args) => {
    const q = requireString(args, "query");
    const maxResults = optionalInt(args, "maxResults", 10, 25);
    const drive = driveClient(email);
    const res = await drive.files.list({
      q,
      pageSize: maxResults,
      // Search across both My Drive and shared drives the user belongs
      // to. Without these flags the API only searches My Drive — which
      // would miss virtually every collaborative file in F&F.
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: "allDrives",
      fields:
        "files(id, name, mimeType, modifiedTime, owners(emailAddress, displayName), webViewLink, parents)",
    });
    return { ok: true, files: res.data.files || [] };
  },
};

const readDocTool: Tool = {
  declaration: {
    name: "readDoc",
    description:
      "Read the plain-text content of a Google Doc. Pass the file id " +
      "from searchDrive (the doc must have mimeType " +
      "'application/vnd.google-apps.document'). Returns up to ~30KB of " +
      "text — long docs are truncated.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        documentId: {
          type: SchemaType.STRING,
          description: "Drive file id of a Google Doc.",
        },
      },
      required: ["documentId"],
    },
  },
  execute: async (email, args) => {
    const documentId = requireString(args, "documentId");
    // Use Drive's `files.export` to get text/plain — avoids needing
    // the docs.readonly scope (we already have /auth/drive in DWD).
    // Returns a string body in res.data when alt=media.
    const drive = driveClient(email);
    const res = await drive.files.export(
      { fileId: documentId, mimeType: "text/plain" },
      { responseType: "text" },
    );
    const text = String(res.data || "");
    const cap = 30_000;
    return {
      ok: true,
      documentId,
      truncated: text.length > cap,
      text: text.length > cap ? text.slice(0, cap) + "\n…" : text,
    };
  },
};

// ── Catalog ──────────────────────────────────────────────────────────

export const TOOL_CATALOG: Tool[] = [
  getTaskTool,
  getProjectTool,
  getCompanyContactsTool,
  searchGmailTool,
  readGmailThreadTool,
  searchDriveTool,
  readDocTool,
];

export const TOOL_DECLARATIONS = TOOL_CATALOG.map((t) => t.declaration);

export function getTool(name: string): Tool | undefined {
  return TOOL_CATALOG.find((t) => t.declaration.name === name);
}

/** Suppress an "unused" lint complaint on `getSAClient` + `google` —
 *  re-exported here in case future tools need to construct a custom
 *  client. Currently unused but cheap to keep available. */
export const _internalAuthHelpers = { getSAClient, google };
