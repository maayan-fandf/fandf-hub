/**
 * Direct-to-Google write path for the legacy comment / mention system.
 *
 * Mirrors the Apps Script `_hubApiHandle_` actions
 * `postReplyForUser_` / `resolveCommentForUser_` / `deleteCommentForUser_` /
 * `editCommentForUser_` / `createTaskForUser_` but runs entirely in Node
 * with `googleapis` + DWD impersonation. Cuts the cord with Apps Script
 * for comment writes — Apps Script keeps the scheduled triggers
 * (`pollTaskCompletions`, `sendOpenMentionsDigest`) since those just
 * read the same Sheet, but interactive comment writes now bypass it
 * entirely so we don't need the manifest-flip / clasp-deploy dance for
 * any comment-side change.
 *
 * Schema invariants preserved from Apps Script:
 * - Comments live in the same sheet as tasks; row_kind = '' (or absent)
 *   for plain comments / mentions, row_kind = 'task' for work tasks.
 * - Top-level rows have parent_id = '' and live as anchor='general'.
 * - Replies have parent_id = root.id and are flat (no reply-of-reply).
 * - mentions = comma-separated list of recipient emails on a top-level
 *   row that spawned Google Tasks.
 * - google_tasks JSON: flat array `[{ u, l, t, d, kind? }, ...]` —
 *   used to sync the per-assignee Google Tasks list when the comment
 *   resolves / edits / gets deleted. Legacy rows may store the cell as
 *   `{ email: ref }` (object); readers normalize both shapes to array.
 * - resolved is a boolean cell that drives row dimming + the badge
 *   counts. Setting resolved on a top-level comment cascades to the
 *   spawned Google Tasks (mark completed).
 * - edited_at is set on body edits; cleared otherwise.
 *
 * Authorization mirrors the Apps Script gates:
 * - postReply: caller must have project access.
 * - resolveComment: caller must have project access (any team member
 *   can mark resolved — that's the whole point of the system).
 * - deleteComment / editComment: author or admin only. editComment also
 *   rejects on resolved threads.
 * - createMention: caller must have project access.
 */

import { after } from "next/server";
import {
  sheetsClient,
  tasksApiClient,
  gmailClient,
  useFirestoreTasks,
  useFirestoreWrites,
  useChatCrossPost,
} from "@/lib/sa";
import { readKeysCached, findChatSpaceColumnIndex } from "@/lib/keys";

/**
 * Run `fn` after the response has been flushed to the user. Wraps Next 15's
 * `after()` so we can keep the call site readable and centralize error
 * handling — deferred work errors must never crash the route handler.
 *
 * Used for notification side-effects (Gmail, Chat webhooks) and best-effort
 * Google Tasks syncs that don't gate the user-visible response.
 */
function deferAfterResponse(fn: () => Promise<void>): void {
  after(async () => {
    try {
      await fn();
    } catch (e) {
      console.log("[commentsWriteDirect] deferred work failed:", e);
    }
  });
}

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const ADMIN_EMAILS = new Set([
  "maayan@fandf.co.il",
  "nadav@fandf.co.il",
  "felix@fandf.co.il",
]);

/* ── Utilities ─────────────────────────────────────────────────────── */

function nowIso(): string {
  return new Date().toISOString();
}

/** True for F&F team members. The single rule that decides who may
 *  author / read `scope:"internal"` discussion — identical to the
 *  project page's `isInternalUser` test, kept here so the write-side
 *  guard never depends on getAccessScope (which has no client flag). */
function isInternalEmail(email: string): boolean {
  return email.toLowerCase().trim().endsWith("@fandf.co.il");
}

/** Normalize an untrusted scope input to the two valid values. Anything
 *  that isn't the explicit string "internal" collapses to "shared" —
 *  the safe default (client-visible, = pre-scope behavior). */
function normalizeScope(v: unknown): "internal" | "shared" {
  return v === "internal" ? "internal" : "shared";
}

function genCommentId(): string {
  return (
    "c-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 6)
  );
}

function columnLetter(colNumber: number): string {
  let n = colNumber;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseAssignees(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((x) => String(x || "").trim().toLowerCase())
      .filter((s) => s.includes("@"));
  }
  return String(raw)
    .split(/[,;\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes("@"));
}

/* ── Keys access control (project membership) ──────────────────────── */

async function assertProjectAccess(
  subjectEmail: string,
  project: string,
): Promise<void> {
  // Delegate to the shared getAccessScope (lib/tasksDirect.ts) so the
  // write gate uses the same display-name resolution and @fandf.co.il
  // domain blanket the read paths use.
  const { getAccessScope } = await import("@/lib/tasksDirect");
  const scope = await getAccessScope(subjectEmail);
  if (scope.isAdmin) return;
  if (scope.accessibleProjects.has(project)) return;
  // Confirm the project actually exists before reporting access denial.
  const { headers, rows } = await readKeysCached(subjectEmail);
  const iProj = headers.indexOf("פרוייקט");
  const targetProject = project.toLowerCase().trim();
  for (const row of rows) {
    const p = String(row[iProj] ?? "").toLowerCase().trim();
    if (p === targetProject) {
      throw new Error("Access denied to project: " + project);
    }
  }
  throw new Error("Project not found: " + project);
}

/* ── Comments sheet read helper ────────────────────────────────────── */

type CommentsSheetRead = {
  rows: unknown[][];
  headers: string[];
  idx: Map<string, number>;
  /** Numeric Google Sheets sheetId for the Comments tab — needed for
   *  deleteDimension batch updates (different from the spreadsheet ID). */
  sheetId: number;
};

async function readCommentsSheet(subjectEmail: string): Promise<CommentsSheetRead> {
  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_COMMENTS");
  const [meta, valRes] = await Promise.all([
    sheets.spreadsheets.get({ spreadsheetId: ssId, fields: "sheets.properties" }),
    sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: "Comments",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    }),
  ]);
  const sheetProp = (meta.data.sheets ?? []).find(
    (s) => s.properties?.title === "Comments",
  );
  const sheetId = sheetProp?.properties?.sheetId ?? 0;
  const values = (valRes.data.values ?? []) as unknown[][];
  if (!values.length) return { rows: [], headers: [], idx: new Map(), sheetId };
  const headers = (values[0] as unknown[]).map((h) => String(h ?? "").trim());
  const idx = new Map<string, number>();
  headers.forEach((h, i) => {
    if (h) idx.set(h, i);
  });
  return { rows: values.slice(1), headers, idx, sheetId };
}

/**
 * Phase 4 — source the comment/task rows for a write. When
 * useFirestoreWrites() is on, the Comments sheet is no longer written
 * (it goes stale), so reconstruct the SAME `{ rows, headers, idx }`
 * shape from Firestore (the parity-proven inverse mapping) so every
 * find-parent / find-row / thread-walk below runs byte-identically.
 * `sheetId` is Sheets-only (deleteDimension) and unused under Phase 4.
 * Else: the legacy direct Sheets read.
 */
async function readCommentsForWrite(
  subjectEmail: string,
): Promise<CommentsSheetRead & { fsWrites: boolean }> {
  const fsWrites = useFirestoreWrites();
  if (fsWrites) {
    const { readCommentsShapeFromFirestore } = await import(
      "@/lib/firestoreRead"
    );
    const { headers, rows, headerIdx } =
      await readCommentsShapeFromFirestore();
    return { rows, headers, idx: headerIdx, sheetId: -1, fsWrites };
  }
  const r = await readCommentsSheet(subjectEmail);
  return { ...r, fsWrites };
}

function findRowByCommentId(
  rows: unknown[][],
  idx: Map<string, number>,
  commentId: string,
): number {
  const idCol = idx.get("id");
  if (idCol == null) return -1;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][idCol] ?? "").trim() === commentId) return i;
  }
  return -1;
}

/* ── Notification side effects ─────────────────────────────────────── */

async function filterByEmailPref(emails: string[]): Promise<string[]> {
  if (emails.length === 0) return [];
  const { getUserPrefs } = await import("@/lib/userPrefs");
  const out: string[] = [];
  for (const e of emails) {
    try {
      const p = await getUserPrefs(e);
      if (p.email_notifications) out.push(e);
    } catch {
      out.push(e);
    }
  }
  return out;
}

async function filterByGtasksPref(emails: string[]): Promise<string[]> {
  if (emails.length === 0) return [];
  const { getUserPrefs } = await import("@/lib/userPrefs");
  const out: string[] = [];
  for (const e of emails) {
    try {
      const p = await getUserPrefs(e);
      if (p.gtasks_sync) out.push(e);
    } catch {
      out.push(e);
    }
  }
  return out;
}

async function sendMimeMail(
  authorEmail: string,
  toEmail: string,
  subject: string,
  plainBody: string,
): Promise<void> {
  try {
    const gmail = gmailClient(authorEmail);
    const mime = [
      `From: ${authorEmail}`,
      `To: ${toEmail}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(plainBody, "utf-8").toString("base64"),
    ].join("\r\n");
    const raw = Buffer.from(mime, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  } catch (e) {
    console.log("[commentsWriteDirect] email send failed:", e);
  }
}

/**
 * Cross-stream signal — when a comment / reply / resolve happens on
 * the hub's client tab, drop a notice into the project's internal
 * Google Chat space. Internal team lives in Chat all day; without
 * this they'd miss client-side activity until they happened to load
 * the hub. The notice carries the author + body excerpt + a deeplink
 * back to the hub thread.
 *
 * Replaces the previous incoming-webhook-based postChatWebhook with
 * the OAuth Chat REST API (via lib/chat.ts). One implementation
 * change, two payoffs:
 *   1. Posts as a real Workspace user (impersonated through DWD), so
 *      the message can later be edited / deleted via the same auth
 *      path. Webhook-authored messages are immutable from our side.
 *   2. Same auth path the internal-tab read uses, so we don't carry
 *      two parallel Chat integrations.
 *
 * Posting identity is deliberately fixed to DRIVE_FOLDER_OWNER (the
 * team's bot identity, default `maayan@fandf.co.il`) rather than the
 * actual comment author:
 *   - Client authors aren't @fandf.co.il, so DWD can't impersonate
 *     them anyway — `effectiveSubject` would silently coerce to the
 *     same fallback.
 *   - Internal authors on the client tab still go through this path
 *     (their post is canonical client-facing copy); using a fixed
 *     identity makes "this is a hub forwarding card" obvious in
 *     Chat instead of looking like a duplicate post from them.
 *
 * Failure modes (Chat API not enabled, scope missing, no Chat
 * webhook configured, user not a space member) all silently drop
 * the notice. The hub comment write is the source of truth; the
 * Chat signal is best-effort enrichment.
 */
async function postChatWebhook(
  subjectEmail: string,
  project: string,
  kind: "reply" | "resolve" | "create",
  card: { authorName: string; body?: string; deepLink?: string },
): Promise<void> {
  // Path B (owner decision 2026-05-18): the hub no longer mirrors
  // activity into Chat spaces — team uses WhatsApp/email, hub
  // discussion lives in Firestore. Default-off kill switch; single
  // chokepoint neutralizes all callers (reply / resolve / create).
  // Revive by setting CHAT_CROSSPOST_ENABLED=1.
  if (!useChatCrossPost()) return;
  try {
    const { headers, rows } = await readKeysCached(subjectEmail);
    const iProj = headers.indexOf("פרוייקט");
    const iWebhook = findChatSpaceColumnIndex(headers);
    if (iProj < 0 || iWebhook < 0) return;
    const target = project.toLowerCase().trim();
    let webhookUrl = "";
    for (const row of rows) {
      if (String(row[iProj] ?? "").toLowerCase().trim() === target) {
        webhookUrl = String(row[iWebhook] ?? "").trim();
        break;
      }
    }
    if (!webhookUrl) return;
    const { parseSpaceId, postMessage } = await import("@/lib/chat");
    const { driveFolderOwner } = await import("@/lib/sa");
    const spaceId = parseSpaceId(webhookUrl);
    if (!spaceId) return;

    const verb =
      kind === "create"
        ? "פרסמ/ה הודעה ללקוח"
        : kind === "resolve"
          ? "סגר/ה שרשור"
          : "הגיב/ה לשרשור";
    const emoji = kind === "create" ? "💬" : kind === "resolve" ? "✅" : "↩️";
    // Chat's text field renders *bold* and auto-links bare URLs.
    // Wrap the body excerpt in »« quotes (Hebrew convention) so a
    // multi-line excerpt still reads as quoted speech.
    const lines: string[] = [];
    lines.push(`${emoji} *${card.authorName}* ${verb} בפרויקט *${project}*`);
    if (card.body) {
      const excerpt = card.body.replace(/\s+/g, " ").slice(0, 200);
      lines.push(`«${excerpt}»`);
    }
    if (card.deepLink) lines.push(`פתח בהאב → ${card.deepLink}`);
    const text = lines.join("\n");
    await postMessage(driveFolderOwner(), spaceId, text);
  } catch (e) {
    console.log("[commentsWriteDirect] cross-stream signal failed:", e);
  }
}

/* ── Google Tasks side effects ─────────────────────────────────────── */

import type { GTaskRef } from "@/lib/appsScript";

/** Read the cell as a flat array regardless of legacy shape. Old
 *  task-row writes used `{ email: ref }` (object); legacy comment-row
 *  writes used `[ref, ...]` (array). Both flatten to the same array. */
function readGTaskCell(raw: unknown): GTaskRef[] {
  if (raw == null || raw === "") return [];
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (Array.isArray(parsed)) return parsed as GTaskRef[];
  if (parsed && typeof parsed === "object") {
    return Object.values(parsed as Record<string, GTaskRef>);
  }
  return [];
}

async function syncGoogleTasksStatus(
  googleTasks: GTaskRef[],
  desired: "completed" | "needsAction",
): Promise<number> {
  const entries = googleTasks || [];
  if (entries.length === 0) return 0;
  let synced = 0;
  await Promise.all(
    entries.map(async (gt) => {
      try {
        const tasksApi = tasksApiClient(gt.u);
        await tasksApi.tasks.patch({
          tasklist: gt.l,
          task: gt.t,
          requestBody: { status: desired },
        });
        synced++;
      } catch (e) {
        console.log(
          `[commentsWriteDirect] Tasks patch (${desired}) failed for ${gt.u}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }),
  );
  return synced;
}

async function patchGoogleTaskNotes(
  googleTasks: GTaskRef[],
  newBody: string,
  project: string,
  deepLink: string,
): Promise<number> {
  const entries = googleTasks || [];
  if (entries.length === 0) return 0;
  const notes = newBody + (deepLink ? `\n\n${deepLink}` : "");
  let patched = 0;
  await Promise.all(
    entries.map(async (gt) => {
      try {
        const tasksApi = tasksApiClient(gt.u);
        await tasksApi.tasks.patch({
          tasklist: gt.l,
          task: gt.t,
          requestBody: {
            title: "💬 " + project + " — תגובה",
            notes,
          },
        });
        patched++;
      } catch (e) {
        console.log(
          `[commentsWriteDirect] Tasks notes patch failed for ${gt.u}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }),
  );
  return patched;
}

async function deleteGoogleTasks(
  googleTasks: GTaskRef[],
): Promise<number> {
  const entries = googleTasks || [];
  if (entries.length === 0) return 0;
  let deleted = 0;
  await Promise.all(
    entries.map(async (gt) => {
      try {
        const tasksApi = tasksApiClient(gt.u);
        await tasksApi.tasks.delete({ tasklist: gt.l, task: gt.t });
        deleted++;
      } catch (e) {
        console.log(
          `[commentsWriteDirect] Tasks delete failed for ${gt.u}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }),
  );
  return deleted;
}

/* ── Hub deep-link helper ──────────────────────────────────────────── */

function hubCommentUrl(project: string, commentId: string): string {
  const base = (process.env.AUTH_URL || "").replace(/\/+$/, "");
  if (!base) return "";
  return `${base}/projects/${encodeURIComponent(project)}/timeline#c=${encodeURIComponent(commentId)}`;
}

function hubTaskUrl(taskId: string): string {
  const base = (process.env.AUTH_URL || "").replace(/\/+$/, "");
  if (!base) return "";
  return `${base}/tasks/${encodeURIComponent(taskId)}`;
}

/** Pull `@<email>` patterns out of a comment body. The picker UI can
 *  insert these as visible tokens (e.g. when you tap a person from the
 *  autocomplete dropdown); raw typed `@maayan@fandf.co.il` also works.
 *  Returns lowercased, deduplicated emails. Doesn't validate against
 *  the project roster — that's the caller's job (notifyOnce drops
 *  self-mentions; per-project gating happens via existing access
 *  controls when the recipient opens the deep-link). */
function parseMentionsFromBody(body: string): string[] {
  const out = new Set<string>();
  const re = /@([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.add(m[1].toLowerCase());
  }
  return Array.from(out);
}

/* ── Public: postReplyDirect ───────────────────────────────────────── */

export type PostReplyResult = {
  ok: boolean;
  comment_id: string;
  parent_id: string;
  project: string;
  body: string;
  timestamp: string;
};

export async function postReplyDirect(
  subjectEmail: string,
  parentCommentId: string,
  body: string,
): Promise<PostReplyResult> {
  if (!parentCommentId || !parentCommentId.trim()) {
    throw new Error("parentCommentId required");
  }
  if (!body || !body.trim()) throw new Error("body required");

  const trimmedParentId = parentCommentId.trim();
  const { rows, headers, idx, fsWrites } =
    await readCommentsForWrite(subjectEmail);
  const parentRowIdx = findRowByCommentId(rows, idx, trimmedParentId);
  if (parentRowIdx < 0) {
    throw new Error("Parent comment not found: " + trimmedParentId);
  }
  const parentRow = rows[parentRowIdx];
  const parentProject = String(
    parentRow[idx.get("project") ?? -1] ?? "",
  ).trim();
  if (!parentProject) throw new Error("Parent comment has no project");
  await assertProjectAccess(subjectEmail, parentProject);

  // A reply ALWAYS inherits its thread's scope. Threads are flat
  // (parent_id === root.id), so the direct parent row carries the
  // canonical scope. This makes mixed-scope threads structurally
  // impossible — there is no way to slip a "shared" reply into an
  // "internal" thread (which would leak it to the client) or vice
  // versa. Legacy/sheet rows with no scope column → "shared".
  const threadScope = normalizeScope(
    String(parentRow[idx.get("scope") ?? -1] ?? ""),
  );
  // Defense in depth: only F&F may write into an internal thread.
  // The internal composer is never rendered for clients, but the
  // create/reply API is directly callable — refuse here too.
  if (threadScope === "internal" && !isInternalEmail(subjectEmail)) {
    throw new Error("Not authorized to post in an internal thread");
  }

  const parentAuthor = String(
    parentRow[idx.get("author_email") ?? -1] ?? "",
  ).toLowerCase().trim();
  const parentBodyShort = String(parentRow[idx.get("body") ?? -1] ?? "")
    .slice(0, 60);

  const id = genCommentId();
  const now = nowIso();
  const me = subjectEmail.toLowerCase().trim();
  const trimmedBody = body.trim();
  // Parse @<email> patterns out of the body so task-discussion replies
  // (and any other reply) can tag people. The picker UI can come later;
  // even raw @maayan@fandf.co.il is enough for the data layer to work.
  const parsedMentions = parseMentionsFromBody(trimmedBody).filter(
    (e) => e !== me, // self-mentions never notify
  );
  // If the parent is a task row, deep-link to the task page so the
  // notification "Open" button lands the recipient in the discussion
  // section directly. Detected by row_kind on the parent row.
  const parentRowKind = String(
    parentRow[idx.get("row_kind") ?? -1] ?? "",
  ).trim();
  const parentIsTask = parentRowKind === "task";
  const replyLink = parentIsTask
    ? hubTaskUrl(parentCommentId)
    : hubCommentUrl(parentProject, parentCommentId);

  // Canonical comment doc. taskId is set only when the DIRECT parent
  // is a task row (matches taskCommentsDirect's matching rule).
  const commentDoc = {
    id,
    project: parentProject,
    anchor: "general",
    parent_id: parentCommentId,
    taskId: parentIsTask ? parentCommentId : "",
    author_email: me,
    author_name: subjectEmail.split("@")[0],
    body: trimmedBody,
    mentions: parsedMentions,
    resolved: false,
    createdAt: now,
    edited_at: "",
    google_tasks: [],
    status_history: [],
    scope: threadScope,
  };
  if (fsWrites) {
    // Phase 4 — authoritative Firestore comment write; NO Sheets
    // append. writeCommentDoc is the un-gated body of the dual-write
    // mirror, so the doc shape is identical. Failure SURFACES (Phase-4
    // writes are no longer swallowed).
    const { writeCommentDoc } = await import("@/lib/firestoreSync");
    await writeCommentDoc(commentDoc);
  } else {
    const cells: Record<string, unknown> = {
      id,
      timestamp: now,
      project: parentProject,
      anchor: "general",
      author_email: me,
      author_name: subjectEmail.split("@")[0],
      parent_id: parentCommentId,
      body: trimmedBody,
      resolved: false,
      mentions: parsedMentions.join(","),
      google_tasks: "[]",
      edited_at: "",
      row_kind: "",
      status_history: "[]",
      scope: threadScope,
    };
    const row = headers.map((h) => (h in cells ? cells[h] : ""));
    const sheets = sheetsClient(subjectEmail);
    await sheets.spreadsheets.values.append({
      spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
      range: "Comments",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row as unknown[]] },
    });
    // Phase 2/3 storage migration — best-effort dual-write mirror.
    // Never throws. Awaited only when reads are flipped to Firestore
    // (read-your-writes); fire-and-forget otherwise (Phase-2 soak).
    const _fsMirror = import("@/lib/firestoreSync")
      .then((m) => m.mirrorComment(commentDoc))
      .catch(() => {});
    if (useFirestoreTasks()) await _fsMirror;
  }

  // Find the thread root + collect every email @-mentioned anywhere
  // earlier in the thread. Mirrors the Chat-side listThreadMentioned-
  // Emails fan-out: when a reply lands, anyone tagged earlier in the
  // same thread gets a mention notification (since the replier may
  // not re-tag them but they're conversationally invested).
  //
  // Walk up the parent chain to find the root, then collect any row
  // whose id===root or parent_id===root. The `mentions` cell is comma-
  // separated emails per row; union and lower-case them.
  const threadEarlierMentions = (function collectThreadMentions(): Set<string> {
    const out = new Set<string>();
    let rootId = parentCommentId;
    let cursor: typeof parentRow | undefined = parentRow;
    let safety = 20;
    while (cursor && safety-- > 0) {
      const cParent = String(cursor[idx.get("parent_id") ?? -1] ?? "").trim();
      const cId = String(cursor[idx.get("id") ?? -1] ?? "").trim();
      if (!cParent) {
        if (cId) rootId = cId;
        break;
      }
      const nextIdx = findRowByCommentId(rows, idx, cParent);
      if (nextIdx < 0) break;
      cursor = rows[nextIdx];
    }
    for (const r of rows) {
      const rid = String(r[idx.get("id") ?? -1] ?? "").trim();
      const rparent = String(r[idx.get("parent_id") ?? -1] ?? "").trim();
      if (rid !== rootId && rparent !== rootId) continue;
      const cell = String(r[idx.get("mentions") ?? -1] ?? "");
      for (const m of cell.split(",")) {
        const e = m.trim().toLowerCase();
        if (e && e !== me) out.add(e);
      }
    }
    return out;
  })();

  // Notifications run after the response is flushed — they're best-effort
  // and the user shouldn't wait on Gmail / Chat round-trips.
  deferAfterResponse(async () => {
    const { notifyOnce } = await import("@/lib/notifications");
    // Reply notification → parent author (skipped if same person OR a
    // mention already covers them — mention takes precedence).
    const explicitMentionSet = new Set(parsedMentions);
    if (
      parentAuthor &&
      parentAuthor !== me &&
      !explicitMentionSet.has(parentAuthor)
    ) {
      await notifyOnce({
        kind: "comment_reply",
        forEmail: parentAuthor,
        actorEmail: me,
        taskId: parentIsTask ? parentCommentId : "",
        commentId: id,
        project: parentProject,
        title: parentBodyShort,
        body: trimmedBody.slice(0, 280),
        link: replyLink,
        // 30s grace — flusher (poll-tasks) sends after the window, or
        // cancels if this reply is deleted within it.
        deferEmailUntil: Date.now() + 30_000,
      });
    }
    // Mention notifications → each parsed @<email>.
    for (const recipient of parsedMentions) {
      await notifyOnce({
        kind: "mention",
        forEmail: recipient,
        actorEmail: me,
        taskId: parentIsTask ? parentCommentId : "",
        commentId: id,
        project: parentProject,
        title: parentBodyShort,
        body: trimmedBody.slice(0, 280),
        link: replyLink,
        // 30s grace — flusher (poll-tasks) sends after the window, or
        // cancels if this reply is deleted within it.
        deferEmailUntil: Date.now() + 30_000,
      });
    }
    // Thread-participant fan-out → anyone @-mentioned earlier in the
    // thread who isn't already covered by the explicit mention list,
    // the parent author, or the actor themselves.
    for (const recipient of threadEarlierMentions) {
      if (recipient === me) continue;
      if (explicitMentionSet.has(recipient)) continue;
      if (recipient === parentAuthor) continue;
      await notifyOnce({
        kind: "mention",
        forEmail: recipient,
        actorEmail: me,
        taskId: parentIsTask ? parentCommentId : "",
        commentId: id,
        project: parentProject,
        title: parentBodyShort,
        body: trimmedBody.slice(0, 280),
        link: replyLink,
        // 30s grace — flusher (poll-tasks) sends after the window, or
        // cancels if this reply is deleted within it.
        deferEmailUntil: Date.now() + 30_000,
      });
    }
    // Cross-post to the project's Chat Space ONLY for project-level
    // discussion replies. Task-thread replies (parentIsTask=true)
    // already live under the task on /tasks/<id> — also mirroring
    // them to the project chat clutters the team channel with
    // task-level noise that's actionable elsewhere. Resolve / create
    // posts continue to cross-post regardless because those are
    // higher-signal events worth team awareness.
    // Internal-scoped discussion must NEVER cross-post to the
    // office-wide Chat space (Chat is globally off today, but keep the
    // invariant true if it's ever revived — internal = F&F-only).
    if (!parentIsTask && threadScope !== "internal") {
      await postChatWebhook(subjectEmail, parentProject, "reply", {
        authorName: me.split("@")[0],
        body: trimmedBody.slice(0, 120),
        deepLink: replyLink,
      });
    }
  });

  return {
    ok: true,
    comment_id: id,
    parent_id: parentCommentId,
    project: parentProject,
    body: trimmedBody,
    timestamp: now,
  };
}

/* ── Public: resolveCommentDirect ──────────────────────────────────── */

export type ResolveCommentResult = {
  ok: boolean;
  comment_id: string;
  resolved: boolean;
};

export async function resolveCommentDirect(
  subjectEmail: string,
  commentId: string,
  resolved: boolean,
): Promise<ResolveCommentResult> {
  const { rows, idx, fsWrites } = await readCommentsForWrite(subjectEmail);
  const rowIdx = findRowByCommentId(rows, idx, commentId);
  if (rowIdx < 0) throw new Error("Comment not found: " + commentId);
  const row = rows[rowIdx];
  const project = String(row[idx.get("project") ?? -1] ?? "").trim();
  await assertProjectAccess(subjectEmail, project);

  if (fsWrites) {
    // Phase 4 — authoritative Firestore merge; NO Sheets write.
    // writeCommentFields is the un-gated body of mirrorCommentFields.
    // Failure SURFACES.
    const { writeCommentFields } = await import("@/lib/firestoreSync");
    await writeCommentFields(commentId, { resolved });
  } else {
    const sheetRow = rowIdx + 2; // +1 for header, +1 for 1-based
    const resolvedCol = idx.get("resolved");
    if (resolvedCol == null) {
      throw new Error("Sheet missing 'resolved' column");
    }
    const colLetter = columnLetter(resolvedCol + 1);
    const sheets = sheetsClient(subjectEmail);
    await sheets.spreadsheets.values.update({
      spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
      range: `Comments!${colLetter}${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [[resolved]] },
    });
  }

  // If this is a top-level comment with spawned Google Tasks, cascade the
  // status change + post a Chat ping. Both are after-response — the user
  // already saw their resolved toggle land via the Sheet write above.
  const parentId = String(row[idx.get("parent_id") ?? -1] ?? "").trim();
  if (!parentId) {
    const gt = readGTaskCell(row[idx.get("google_tasks") ?? -1]);
    const bodyShort = String(row[idx.get("body") ?? -1] ?? "").slice(0, 80);
    const me = subjectEmail.toLowerCase().trim();
    deferAfterResponse(async () => {
      if (gt.length > 0) {
        await syncGoogleTasksStatus(gt, resolved ? "completed" : "needsAction");
      }
      if (resolved) {
        await postChatWebhook(subjectEmail, project, "resolve", {
          authorName: me.split("@")[0],
          body: bodyShort,
          deepLink: hubCommentUrl(project, commentId),
        });
      }
    });
  }

  // Phase 2/3 storage migration — mirror the resolved toggle (merge so
  // it doesn't clobber the rest of the doc). Never throws. Awaited
  // only when reads are flipped (read-your-writes); else fire-and-forget.
  // Phase 4: skipped — the write above was already authoritative.
  if (!fsWrites) {
    const _fsMirror = import("@/lib/firestoreSync")
      .then((m) => m.mirrorCommentFields(commentId, { resolved }))
      .catch(() => {});
    if (useFirestoreTasks()) await _fsMirror;
  }

  return { ok: true, comment_id: commentId, resolved };
}

/* ── Public: deleteCommentDirect ───────────────────────────────────── */

export type DeleteCommentResult = {
  ok: boolean;
  comment_id: string;
  deleted_replies: number;
  deleted_tasks: number;
};

export async function deleteCommentDirect(
  subjectEmail: string,
  commentId: string,
): Promise<DeleteCommentResult> {
  const { rows, idx, sheetId, fsWrites } =
    await readCommentsForWrite(subjectEmail);
  const rowIdx = findRowByCommentId(rows, idx, commentId);
  if (rowIdx < 0) throw new Error("Comment not found: " + commentId);
  const row = rows[rowIdx];
  const project = String(row[idx.get("project") ?? -1] ?? "").trim();
  const author = String(row[idx.get("author_email") ?? -1] ?? "").toLowerCase().trim();
  const me = subjectEmail.toLowerCase().trim();
  if (author !== me && !ADMIN_EMAILS.has(me)) {
    throw new Error("Not authorized to delete this comment");
  }
  if (project) await assertProjectAccess(subjectEmail, project);

  // Find direct replies (parent_id = commentId).
  const parentCol = idx.get("parent_id");
  const replyRowIndices: number[] = [];
  if (parentCol != null) {
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][parentCol] ?? "").trim() === commentId) {
        replyRowIndices.push(i);
      }
    }
  }

  // Parse spawned Google Tasks refs now (we still own `row`); the actual
  // delete-tasks API calls happen after the response is flushed since no
  // client consumes deleted_tasks and the user perceives "deleted" the
  // moment the row vanishes from their view.
  const gtToDelete: GTaskRef[] = readGTaskCell(row[idx.get("google_tasks") ?? -1]);

  // Resolve every doc/row id to remove: the comment + its direct
  // replies (reply ids read from the in-memory rows).
  const idCol = idx.get("id");
  const deletedIds = [
    commentId,
    ...(idCol != null
      ? replyRowIndices.map((ri) => String(rows[ri][idCol] ?? "").trim())
      : []),
  ].filter(Boolean);
  if (fsWrites) {
    // Phase 4 — authoritative Firestore delete (root + replies); NO
    // Sheets deleteDimension. deleteCommentDocs is the un-gated body
    // of mirrorCommentsDeleted. Failure SURFACES.
    const { deleteCommentDocs } = await import("@/lib/firestoreSync");
    await deleteCommentDocs(deletedIds);
  } else {
    // Delete the rows in descending order so indices don't shift.
    // Sheet row numbers: header is row 1; rows[i] is row (i + 2).
    const allRowsToDelete = [rowIdx, ...replyRowIndices].sort(
      (a, b) => b - a,
    );
    const sheets = sheetsClient(subjectEmail);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
      requestBody: {
        requests: allRowsToDelete.map((ri) => ({
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: ri + 1, // header is sheet row 1 = startIndex 0
              endIndex: ri + 2,
            },
          },
        })),
      },
    });
    // Phase 2 storage migration — best-effort dual-write mirror of the
    // deletion (root + replies). Flag-gated, never throws, not awaited.
    const _fsMirror = import("@/lib/firestoreSync")
      .then((m) => m.mirrorCommentsDeleted(deletedIds))
      .catch(() => {});
    if (useFirestoreTasks()) await _fsMirror;
  }

  if (Object.keys(gtToDelete).length > 0) {
    deferAfterResponse(async () => {
      await deleteGoogleTasks(gtToDelete);
    });
  }

  return {
    ok: true,
    comment_id: commentId,
    deleted_replies: replyRowIndices.length,
    deleted_tasks: Object.keys(gtToDelete).length,
  };
}

/* ── Public: editCommentDirect ─────────────────────────────────────── */

export type EditCommentResult = {
  ok: boolean;
  noop?: boolean;
  comment_id: string;
  body: string;
  edited_at: string;
  synced_tasks?: number;
};

export async function editCommentDirect(
  subjectEmail: string,
  commentId: string,
  newBody: string,
): Promise<EditCommentResult> {
  if (!newBody || !newBody.trim()) throw new Error("body required");
  const { rows, idx, fsWrites } = await readCommentsForWrite(subjectEmail);
  const rowIdx = findRowByCommentId(rows, idx, commentId);
  if (rowIdx < 0) throw new Error("Comment not found: " + commentId);
  const row = rows[rowIdx];
  const project = String(row[idx.get("project") ?? -1] ?? "").trim();
  const author = String(row[idx.get("author_email") ?? -1] ?? "").toLowerCase().trim();
  const me = subjectEmail.toLowerCase().trim();
  if (author !== me && !ADMIN_EMAILS.has(me)) {
    throw new Error("Not authorized to edit this comment");
  }
  if (project) await assertProjectAccess(subjectEmail, project);

  // Reject edits on resolved threads — match Apps Script behavior. The
  // thread is "resolved" if the root row's resolved=true. Replies and
  // top-level comments both check the root.
  const parentId = String(row[idx.get("parent_id") ?? -1] ?? "").trim();
  if (parentId) {
    const rootIdx = findRowByCommentId(rows, idx, parentId);
    if (rootIdx >= 0 && rows[rootIdx][idx.get("resolved") ?? -1] === true) {
      throw new Error("Cannot edit a comment in a resolved thread");
    }
  } else if (row[idx.get("resolved") ?? -1] === true) {
    throw new Error("Cannot edit a resolved comment");
  }

  const currentBody = String(row[idx.get("body") ?? -1] ?? "");
  if (currentBody === newBody.trim()) {
    return {
      ok: true,
      noop: true,
      comment_id: commentId,
      body: currentBody,
      edited_at: String(row[idx.get("edited_at") ?? -1] ?? ""),
    };
  }

  const now = nowIso();
  if (fsWrites) {
    // Phase 4 — authoritative Firestore merge (body + edited_at); NO
    // Sheets write. writeCommentFields is the un-gated body of
    // mirrorCommentFields. Failure SURFACES.
    const { writeCommentFields } = await import("@/lib/firestoreSync");
    await writeCommentFields(commentId, {
      body: newBody.trim(),
      edited_at: now,
    });
  } else {
    const sheetRow = rowIdx + 2;
    const bodyCol = idx.get("body");
    const editedAtCol = idx.get("edited_at");
    if (bodyCol == null) throw new Error("Sheet missing 'body' column");
    const data: Array<{ range: string; values: string[][] }> = [
      {
        range: `Comments!${columnLetter(bodyCol + 1)}${sheetRow}`,
        values: [[newBody.trim()]],
      },
    ];
    if (editedAtCol != null) {
      data.push({
        range: `Comments!${columnLetter(editedAtCol + 1)}${sheetRow}`,
        values: [[now]],
      });
    }
    const sheets = sheetsClient(subjectEmail);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
      requestBody: { valueInputOption: "RAW", data },
    });
    // Phase 2/3 storage migration — best-effort dual-write mirror of
    // the body edit + edited_at (merge). Never throws. Awaited only
    // when reads are flipped (read-your-writes); else fire-and-forget.
    const _fsMirror = import("@/lib/firestoreSync")
      .then((m) =>
        m.mirrorCommentFields(commentId, {
          body: newBody.trim(),
          edited_at: now,
        }),
      )
      .catch(() => {});
    if (useFirestoreTasks()) await _fsMirror;
  }

  // Sync spawned Google Tasks notes (top-level only) after the response —
  // the edit body is already in the Sheet, so the user's view reflects the
  // new text on next render. Personal Google Tasks lists update in
  // background.
  let queuedTaskSync = 0;
  if (!parentId) {
    const gt = readGTaskCell(row[idx.get("google_tasks") ?? -1]);
    if (gt.length > 0) {
      queuedTaskSync = gt.length;
      const trimmedNewBody = newBody.trim();
      deferAfterResponse(async () => {
        await patchGoogleTaskNotes(
          gt,
          trimmedNewBody,
          project,
          hubCommentUrl(project, commentId),
        );
      });
    }
  }

  return {
    ok: true,
    comment_id: commentId,
    body: newBody.trim(),
    edited_at: now,
    synced_tasks: queuedTaskSync,
  };
}

/* ── Public: createMentionDirect ───────────────────────────────────── */

export type CreateMentionResult = {
  ok: boolean;
  comment_id: string;
  project: string;
  body: string;
  assignees: string[];
  due: string;
  timestamp: string;
};

export async function createMentionDirect(
  subjectEmail: string,
  args: {
    project: string;
    body: string;
    assignees: unknown;
    due?: string;
    /** Audience of the new top-level thread. "internal" = F&F only;
     *  omitted/"shared" = client-visible (the historical behavior). */
    scope?: "internal" | "shared";
  },
): Promise<CreateMentionResult> {
  const project = String(args.project || "").trim();
  if (!project) throw new Error("project required");
  if (!args.body || !args.body.trim()) throw new Error("body required");
  await assertProjectAccess(subjectEmail, project);

  const scope = normalizeScope(args.scope);
  // Only F&F may open an internal thread. The internal composer isn't
  // shown to clients, but this endpoint is directly callable — refuse a
  // non-F&F caller asking for scope:"internal" rather than silently
  // downgrading (a downgrade would leak the message to the client).
  if (scope === "internal" && !isInternalEmail(subjectEmail)) {
    throw new Error("Not authorized to post an internal message");
  }

  const assignees = parseAssignees(args.assignees);
  const due = String(args.due || "").trim();

  const id = genCommentId();
  const now = nowIso();
  const me = subjectEmail.toLowerCase().trim();

  // Mention rows no longer spawn personal Google Tasks. Google Tasks are
  // reserved for the work-management `tasksCreate` flow + the approval
  // / clarification paths it owns. Mentions still drive the in-hub
  // notification badge, the Chat cross-stream signal, and the daily
  // digest email — all without polluting people's Google Tasks lists.
  // (See `tasksWriteDirect.createGoogleTasks` for the surviving spawn
  // path; this cut is intentional, design decision 2026-04-27.)
  // Canonical mention doc (top-level, no parent → taskId "").
  const commentDoc = {
    id,
    project,
    anchor: "general",
    parent_id: "",
    taskId: "",
    author_email: me,
    author_name: me.split("@")[0],
    body: args.body.trim(),
    mentions: assignees,
    resolved: false,
    createdAt: now,
    edited_at: "",
    google_tasks: [],
    status_history: [],
    scope,
  };
  const fsWrites = useFirestoreWrites();
  if (fsWrites) {
    // Phase 4 — authoritative Firestore comment write; NO Sheets
    // header read + append. writeCommentDoc is the un-gated body of
    // mirrorComment (identical doc shape). Failure SURFACES.
    const { writeCommentDoc } = await import("@/lib/firestoreSync");
    await writeCommentDoc(commentDoc);
  } else {
    const cells: Record<string, unknown> = {
      id,
      timestamp: now,
      project,
      anchor: "general",
      author_email: me,
      author_name: me.split("@")[0],
      parent_id: "",
      body: args.body.trim(),
      resolved: false,
      mentions: assignees.join(","),
      google_tasks: "[]",
      edited_at: "",
      row_kind: "",
      status_history: "[]",
      scope,
    };
    const sheets = sheetsClient(subjectEmail);
    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
      range: "Comments!1:1",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const headers = ((headerRes.data.values?.[0] ?? []) as unknown[]).map(
      (h) => String(h ?? "").trim(),
    );
    const row = headers.map((h) => (h in cells ? cells[h] : ""));
    await sheets.spreadsheets.values.append({
      spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
      range: "Comments",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row as unknown[]] },
    });
    // Phase 2/3 storage migration — best-effort dual-write mirror of
    // the mention row. Never throws. Awaited only when reads are
    // flipped (read-your-writes); else fire-and-forget (Phase-2 soak).
    const _fsMirror = import("@/lib/firestoreSync")
      .then((m) => m.mirrorComment(commentDoc))
      .catch(() => {});
    if (useFirestoreTasks()) await _fsMirror;
  }

  // Notifications run after the response is flushed. Each mentioned
  // assignee gets a `mention` notification (writes a row to the
  // Notifications tab + sends email when their pref allows). Chat
  // webhook still fires per-project as before.
  const trimmedBody = args.body.trim();
  const link = hubCommentUrl(project, id);
  deferAfterResponse(async () => {
    const { notifyOnce } = await import("@/lib/notifications");
    for (const recipient of assignees) {
      await notifyOnce({
        kind: "mention",
        forEmail: recipient,
        actorEmail: me,
        commentId: id,
        project,
        title: due ? `תאריך: ${due}` : "",
        body: trimmedBody.slice(0, 280),
        link,
        // 30s grace — flusher (poll-tasks) sends after the window, or
        // cancels if this comment is deleted within it.
        deferEmailUntil: Date.now() + 30_000,
      });
    }
    // Internal threads never reach the office-wide Chat space.
    if (scope !== "internal") {
      await postChatWebhook(subjectEmail, project, "create", {
        authorName: me.split("@")[0],
        body: trimmedBody.slice(0, 120),
        deepLink: link,
      });
    }
  });

  return {
    ok: true,
    comment_id: id,
    project,
    body: trimmedBody,
    assignees,
    due,
    timestamp: now,
  };
}
