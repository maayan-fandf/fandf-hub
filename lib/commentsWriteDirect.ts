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
 * - google_tasks JSON: { email: { u, l, t, d } } — used to sync the
 *   per-assignee Google Tasks list when the comment resolves / edits /
 *   gets deleted.
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

import {
  sheetsClient,
  tasksApiClient,
  gmailClient,
} from "@/lib/sa";

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

// Strip zero-width / RTL-mark / surrogate noise that creeps into Hebrew
// cells via copy-paste. Same pattern as tasksWriteDirect.ts.
const KEYS_HEADER_NORMALIZE = /[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g;

async function readKeys(subjectEmail: string): Promise<{
  headers: string[];
  rows: unknown[][];
}> {
  const sheets = sheetsClient(subjectEmail);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: envOrThrow("SHEET_ID_MAIN"),
    range: "Keys",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (!values.length) return { headers: [], rows: [] };
  const headers = (values[0] as unknown[]).map((h) =>
    String(h ?? "")
      .replace(KEYS_HEADER_NORMALIZE, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return { headers, rows: values.slice(1) };
}

async function assertProjectAccess(
  subjectEmail: string,
  project: string,
): Promise<void> {
  const lc = subjectEmail.toLowerCase().trim();
  if (ADMIN_EMAILS.has(lc)) return;
  const { headers, rows } = await readKeys(subjectEmail);
  const iProj = headers.indexOf("פרוייקט");
  const iClients = headers.indexOf("Email Client");
  const iInternal = headers.indexOf("Access — internal only");
  const iCf = headers.indexOf("Client-facing");
  const targetProject = project.toLowerCase().trim();
  for (const row of rows) {
    const p = String(row[iProj] ?? "").toLowerCase().trim();
    if (p !== targetProject) continue;
    for (const ci of [iClients, iInternal, iCf]) {
      if (ci < 0) continue;
      const raw = String(row[ci] ?? "").toLowerCase();
      if (raw.includes(lc)) return;
    }
    throw new Error("Access denied to project: " + project);
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

async function postChatWebhook(
  subjectEmail: string,
  project: string,
  kind: "reply" | "resolve" | "create",
  card: { authorName: string; body?: string; deepLink?: string },
): Promise<void> {
  try {
    const { headers, rows } = await readKeys(subjectEmail);
    const iProj = headers.indexOf("פרוייקט");
    const iWebhook = headers.indexOf("Chat Webhook");
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
    const emoji = kind === "create" ? "💬" : kind === "resolve" ? "✅" : "↩️";
    const verb =
      kind === "create" ? " יצר/ה תגובה" : kind === "resolve" ? " סגר/ה" : " הגיב/ה";
    const text = `${emoji} ${card.authorName}${verb}${card.body ? `: ${card.body}` : ""}${card.deepLink ? `\n${card.deepLink}` : ""}`;
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.log("[commentsWriteDirect] Chat webhook post failed:", e);
  }
}

/* ── Google Tasks side effects ─────────────────────────────────────── */

type GTaskRef = { u: string; l: string; t: string; d: string };

async function createGoogleTasksForMention(
  payload: {
    commentId: string;
    project: string;
    body: string;
    due: string;
    deepLink: string;
  },
  assignees: string[],
): Promise<Record<string, GTaskRef>> {
  const out: Record<string, GTaskRef> = {};
  const allowed = await filterByGtasksPref(assignees);
  if (allowed.length === 0) return out;
  const notes =
    payload.body + (payload.deepLink ? `\n\n${payload.deepLink}` : "");
  const datePart = payload.due.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  const dueRfc = datePart
    ? new Date(datePart + "T00:00:00Z").toISOString()
    : undefined;
  await Promise.all(
    allowed.map(async (email) => {
      try {
        const tasksApi = tasksApiClient(email);
        const lists = await tasksApi.tasklists.list({ maxResults: 1 });
        const listId = lists.data.items?.[0]?.id;
        if (!listId) return;
        const created = await tasksApi.tasks.insert({
          tasklist: listId,
          requestBody: {
            title: "💬 " + payload.project + " — תגובה",
            notes,
            due: dueRfc,
          },
        });
        if (created.data.id) {
          out[email] = { u: email, l: listId, t: created.data.id, d: payload.due };
        }
      } catch (e) {
        console.log(
          `[commentsWriteDirect] Google Tasks insert failed for ${email}:`,
          e,
        );
      }
    }),
  );
  return out;
}

async function syncGoogleTasksStatus(
  googleTasks: Record<string, GTaskRef>,
  desired: "completed" | "needsAction",
): Promise<number> {
  const entries = Object.values(googleTasks || {});
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
  googleTasks: Record<string, GTaskRef>,
  newBody: string,
  project: string,
  deepLink: string,
): Promise<number> {
  const entries = Object.values(googleTasks || {});
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
  googleTasks: Record<string, GTaskRef>,
): Promise<number> {
  const entries = Object.values(googleTasks || {});
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
  if (!parentCommentId) throw new Error("parentCommentId required");
  if (!body || !body.trim()) throw new Error("body required");

  const { rows, headers, idx } = await readCommentsSheet(subjectEmail);
  const parentRowIdx = findRowByCommentId(rows, idx, parentCommentId);
  if (parentRowIdx < 0) throw new Error("Parent comment not found: " + parentCommentId);
  const parentRow = rows[parentRowIdx];
  const parentProject = String(
    parentRow[idx.get("project") ?? -1] ?? "",
  ).trim();
  if (!parentProject) throw new Error("Parent comment has no project");
  await assertProjectAccess(subjectEmail, parentProject);

  const parentAuthor = String(
    parentRow[idx.get("author_email") ?? -1] ?? "",
  ).toLowerCase().trim();
  const parentBodyShort = String(parentRow[idx.get("body") ?? -1] ?? "")
    .slice(0, 60);

  const id = genCommentId();
  const now = nowIso();
  const cells: Record<string, unknown> = {
    id,
    timestamp: now,
    project: parentProject,
    anchor: "general",
    author_email: subjectEmail.toLowerCase().trim(),
    author_name: subjectEmail.split("@")[0],
    parent_id: parentCommentId,
    body: body.trim(),
    resolved: false,
    mentions: "",
    google_tasks: "{}",
    edited_at: "",
    row_kind: "",
    status_history: "[]",
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

  // Best-effort notifications: parent author by email + project's chat webhook.
  const me = subjectEmail.toLowerCase().trim();
  if (parentAuthor && parentAuthor !== me) {
    const allowed = await filterByEmailPref([parentAuthor]);
    if (allowed.length > 0) {
      const link = hubCommentUrl(parentProject, parentCommentId);
      await sendMimeMail(
        me,
        parentAuthor,
        `💬 תגובה חדשה לשרשור — ${parentProject}`,
        [
          `${me.split("@")[0]} הגיב/ה לשרשור: "${parentBodyShort}"`,
          "",
          body.trim(),
          "",
          link ? `שרשור מלא: ${link}` : "",
        ].filter(Boolean).join("\n"),
      );
    }
  }
  await postChatWebhook(subjectEmail, parentProject, "reply", {
    authorName: me.split("@")[0],
    body: body.trim().slice(0, 120),
    deepLink: hubCommentUrl(parentProject, parentCommentId),
  });

  return {
    ok: true,
    comment_id: id,
    parent_id: parentCommentId,
    project: parentProject,
    body: body.trim(),
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
  const { rows, idx } = await readCommentsSheet(subjectEmail);
  const rowIdx = findRowByCommentId(rows, idx, commentId);
  if (rowIdx < 0) throw new Error("Comment not found: " + commentId);
  const row = rows[rowIdx];
  const project = String(row[idx.get("project") ?? -1] ?? "").trim();
  await assertProjectAccess(subjectEmail, project);

  const sheetRow = rowIdx + 2; // +1 for header, +1 for 1-based
  const resolvedCol = idx.get("resolved");
  if (resolvedCol == null) throw new Error("Sheet missing 'resolved' column");
  const colLetter = columnLetter(resolvedCol + 1);

  const sheets = sheetsClient(subjectEmail);
  await sheets.spreadsheets.values.update({
    spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
    range: `Comments!${colLetter}${sheetRow}`,
    valueInputOption: "RAW",
    requestBody: { values: [[resolved]] },
  });

  // If this is a top-level comment with spawned Google Tasks, cascade.
  const parentId = String(row[idx.get("parent_id") ?? -1] ?? "").trim();
  if (!parentId) {
    const gtRaw = row[idx.get("google_tasks") ?? -1];
    let gt: Record<string, GTaskRef> = {};
    try {
      gt = typeof gtRaw === "string" ? JSON.parse(gtRaw) : (gtRaw as Record<string, GTaskRef>) || {};
    } catch {
      gt = {};
    }
    if (Object.keys(gt).length > 0) {
      await syncGoogleTasksStatus(gt, resolved ? "completed" : "needsAction");
    }
    if (resolved) {
      const me = subjectEmail.toLowerCase().trim();
      const bodyShort = String(row[idx.get("body") ?? -1] ?? "").slice(0, 80);
      await postChatWebhook(subjectEmail, project, "resolve", {
        authorName: me.split("@")[0],
        body: bodyShort,
        deepLink: hubCommentUrl(project, commentId),
      });
    }
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
  const { rows, idx, sheetId } = await readCommentsSheet(subjectEmail);
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

  // Best-effort: delete spawned Google Tasks before removing rows.
  let deletedTasks = 0;
  const gtRaw = row[idx.get("google_tasks") ?? -1];
  try {
    const gt: Record<string, GTaskRef> =
      typeof gtRaw === "string" ? JSON.parse(gtRaw) : ((gtRaw as Record<string, GTaskRef>) || {});
    if (Object.keys(gt).length > 0) {
      deletedTasks = await deleteGoogleTasks(gt);
    }
  } catch {
    // ignore
  }

  // Delete the rows in descending order so indices don't shift.
  // Sheet row numbers: header is row 1; rows[i] is row (i + 2).
  const allRowsToDelete = [rowIdx, ...replyRowIndices].sort((a, b) => b - a);
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

  return {
    ok: true,
    comment_id: commentId,
    deleted_replies: replyRowIndices.length,
    deleted_tasks: deletedTasks,
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
  const { rows, idx } = await readCommentsSheet(subjectEmail);
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

  const sheetRow = rowIdx + 2;
  const bodyCol = idx.get("body");
  const editedAtCol = idx.get("edited_at");
  if (bodyCol == null) throw new Error("Sheet missing 'body' column");
  const now = nowIso();

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

  // Sync spawned Google Tasks notes (top-level only).
  let syncedTasks = 0;
  if (!parentId) {
    const gtRaw = row[idx.get("google_tasks") ?? -1];
    try {
      const gt: Record<string, GTaskRef> =
        typeof gtRaw === "string" ? JSON.parse(gtRaw) : ((gtRaw as Record<string, GTaskRef>) || {});
      if (Object.keys(gt).length > 0) {
        syncedTasks = await patchGoogleTaskNotes(
          gt,
          newBody.trim(),
          project,
          hubCommentUrl(project, commentId),
        );
      }
    } catch {
      // ignore
    }
  }

  return {
    ok: true,
    comment_id: commentId,
    body: newBody.trim(),
    edited_at: now,
    synced_tasks: syncedTasks,
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
  args: { project: string; body: string; assignees: unknown; due?: string },
): Promise<CreateMentionResult> {
  const project = String(args.project || "").trim();
  if (!project) throw new Error("project required");
  if (!args.body || !args.body.trim()) throw new Error("body required");
  await assertProjectAccess(subjectEmail, project);

  const assignees = parseAssignees(args.assignees);
  const due = String(args.due || "").trim();

  const id = genCommentId();
  const now = nowIso();
  const me = subjectEmail.toLowerCase().trim();

  // Spawn Google Tasks per assignee BEFORE writing the row so the
  // google_tasks JSON includes the resulting refs. Failures here don't
  // block the row append — partial maps are still useful for tracking.
  const gt = await createGoogleTasksForMention(
    {
      commentId: id,
      project,
      body: args.body.trim(),
      due,
      deepLink: hubCommentUrl(project, id),
    },
    assignees,
  );

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
    google_tasks: JSON.stringify(gt),
    edited_at: "",
    row_kind: "",
    status_history: "[]",
  };
  const sheets = sheetsClient(subjectEmail);
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
    range: "Comments!1:1",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const headers = ((headerRes.data.values?.[0] ?? []) as unknown[]).map((h) =>
    String(h ?? "").trim(),
  );
  const row = headers.map((h) => (h in cells ? cells[h] : ""));
  await sheets.spreadsheets.values.append({
    spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
    range: "Comments",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row as unknown[]] },
  });

  // Notify each mentioned user (respect email pref).
  const allowedEmail = await filterByEmailPref(assignees);
  if (allowedEmail.length > 0) {
    const link = hubCommentUrl(project, id);
    await Promise.all(
      allowedEmail.map((to) =>
        sendMimeMail(
          me,
          to,
          `💬 תויגת בתגובה — ${project}`,
          [
            `${me.split("@")[0]} תייג/ה אותך:`,
            "",
            args.body.trim(),
            "",
            due ? `תאריך: ${due}` : "",
            link ? `שרשור מלא: ${link}` : "",
          ].filter(Boolean).join("\n"),
        ),
      ),
    );
  }

  // Chat webhook for the project (single ping for the whole post).
  await postChatWebhook(subjectEmail, project, "create", {
    authorName: me.split("@")[0],
    body: args.body.trim().slice(0, 120),
    deepLink: hubCommentUrl(project, id),
  });

  return {
    ok: true,
    comment_id: id,
    project,
    body: args.body.trim(),
    assignees,
    due,
    timestamp: now,
  };
}
