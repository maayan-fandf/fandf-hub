/**
 * Direct-to-Sheets implementations of the three comment-family read
 * paths that used to go through Apps Script: `getProjectComments`,
 * `getMyMentions`, `getProjectTasks` (legacy mention-spawned Google
 * Tasks feed).
 *
 * One Sheets read per request, filtered three ways in memory. Replaces
 * three separate Apps Script round-trips (~1.5–3 s each) with a single
 * ~300 ms Sheets API read. Gated behind USE_SA_COMMENTS_READS.
 *
 * Output shapes match the Apps Script responses exactly (ProjectComments,
 * MyMentions, ProjectTasks) so the lib/appsScript.ts wrapper can branch
 * on the flag without changing call sites.
 *
 * Invariants:
 * - `row_kind === ''` or missing → plain comment (shows in
 *   projectCommentsDirect + potentially myMentionsDirect)
 * - `row_kind === 'task'` → task row from the new work-management
 *   system; skipped by these readers (the tasks queue handles those).
 * - Access control: non-admin callers see only projects they're on
 *   (via Keys roster membership), same as the Apps Script handlers.
 */

import type {
  ProjectComments,
  ProjectTasks,
  MyMentions,
  CommentItem,
  MentionItem,
  TaskItem,
} from "@/lib/appsScript";
import { sheetsClient } from "@/lib/sa";
import { getAccessScope } from "@/lib/tasksDirect";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function toIsoDate(v: unknown): string {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return String(v);
}

/**
 * Read the whole Comments tab once + build a header-name → index map.
 * Callers apply their own filters in memory. This is the single
 * Sheets API call that replaces three Apps Script round-trips on the
 * project page.
 */
async function readCommentsOnce(subjectEmail: string): Promise<{
  rows: unknown[][];
  headerIdx: Map<string, number>;
}> {
  const sheets = sheetsClient(subjectEmail);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
    range: "Comments",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (!values.length) return { rows: [], headerIdx: new Map() };
  const headers = (values[0] as unknown[]).map((h) =>
    String(h ?? "").trim(),
  );
  const headerIdx = new Map<string, number>();
  headers.forEach((h, i) => {
    if (h) headerIdx.set(h, i);
  });
  return { rows: values.slice(1), headerIdx };
}

function cellGetter(
  row: unknown[],
  idx: Map<string, number>,
): (k: string) => unknown {
  return (k: string) => {
    const i = idx.get(k);
    return i == null ? "" : row[i];
  };
}

/** Hub deep-link to a specific comment on the project timeline. Matches
 *  the `_hubTimelineCommentUrl_` pattern in Apps Script. */
function hubCommentUrl(project: string, commentId: string): string {
  const base = (process.env.AUTH_URL || "").replace(/\/+$/, "");
  if (!base) return "";
  return `${base}/projects/${encodeURIComponent(project)}/timeline#c=${encodeURIComponent(commentId)}`;
}

/* ── projectCommentsDirect ─────────────────────────────────────────── */

export async function projectCommentsDirect(
  subjectEmail: string,
  project: string,
  limit: number,
): Promise<ProjectComments> {
  const [{ rows, headerIdx }, scope] = await Promise.all([
    readCommentsOnce(subjectEmail),
    getAccessScope(subjectEmail),
  ]);

  if (!scope.isAdmin && !scope.accessibleProjects.has(project)) {
    throw new Error("Access denied to project: " + project);
  }

  const rowKindIdx = headerIdx.get("row_kind");

  // Collect all comment rows (row_kind empty) for this project.
  type Raw = {
    id: string;
    parent_id: string;
    project: string;
    anchor: string;
    author_email: string;
    author_name: string;
    body: string;
    mentions: string[];
    timestamp: string;
    resolved: boolean;
    edited_at: string;
  };
  const all: Raw[] = [];
  for (const row of rows) {
    const rk = rowKindIdx == null ? "" : String(row[rowKindIdx] ?? "").trim();
    if (rk === "task") continue;
    const cell = cellGetter(row, headerIdx);
    const proj = String(cell("project") ?? "").trim();
    if (proj !== project) continue;
    const mentionsRaw = String(cell("mentions") ?? "");
    all.push({
      id: String(cell("id") ?? ""),
      parent_id: String(cell("parent_id") ?? ""),
      project: proj,
      anchor: String(cell("anchor") ?? ""),
      author_email: String(cell("author_email") ?? ""),
      author_name: String(cell("author_name") ?? ""),
      body: String(cell("body") ?? ""),
      mentions: mentionsRaw
        .split(/[,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      timestamp: toIsoDate(cell("timestamp")),
      resolved: Boolean(cell("resolved")),
      edited_at: toIsoDate(cell("edited_at")),
    });
  }

  // Reply-count index per top-level thread id.
  const replyCount = new Map<string, number>();
  for (const r of all) {
    if (!r.parent_id) continue;
    replyCount.set(r.parent_id, (replyCount.get(r.parent_id) ?? 0) + 1);
  }

  // Show top-level threads (no parent_id) newest first, limited.
  const topLevel = all
    .filter((r) => !r.parent_id)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const visibleTop = topLevel.slice(0, Math.max(1, limit));

  // Surface the top-level threads plus any replies nested under them —
  // mirrors the Apps Script `projectComments` action. Only includes
  // replies for the threads that made the top-N cut.
  const topIds = new Set(visibleTop.map((t) => t.id));
  const replies = all.filter((r) => r.parent_id && topIds.has(r.parent_id));

  const toCommentItem = (r: Raw): CommentItem => ({
    comment_id: r.id,
    project: r.project,
    anchor: r.anchor,
    parent_id: r.parent_id,
    author_email: r.author_email,
    author_name: r.author_name,
    body: r.body,
    mentions: r.mentions,
    timestamp: r.timestamp,
    resolved: r.resolved,
    reply_count: r.parent_id ? 0 : replyCount.get(r.id) ?? 0,
    edited_at: r.edited_at || undefined,
    deep_link: hubCommentUrl(r.project, r.id),
  });

  const comments: CommentItem[] = [
    ...visibleTop.map(toCommentItem),
    ...replies.map(toCommentItem),
  ];

  return {
    project,
    comments,
    total: topLevel.length,
    me: { email: subjectEmail, isAdmin: scope.isAdmin },
  };
}

/* ── myMentionsDirect ──────────────────────────────────────────────── */

export async function myMentionsDirect(
  subjectEmail: string,
): Promise<MyMentions> {
  const [{ rows, headerIdx }, scope] = await Promise.all([
    readCommentsOnce(subjectEmail),
    getAccessScope(subjectEmail),
  ]);

  const lcEmail = subjectEmail.toLowerCase().trim();
  const rowKindIdx = headerIdx.get("row_kind");

  // Two-pass: build the thread-root resolved map first so reply-mentions
  // can inherit the root's resolved state (same as Apps Script does —
  // a reply-mention disappears from the inbox when its parent thread is
  // resolved).
  const rootResolved = new Map<string, boolean>();
  for (const row of rows) {
    const cell = cellGetter(row, headerIdx);
    const parent = String(cell("parent_id") ?? "");
    if (parent) continue; // we only index top-level rows as thread roots
    const id = String(cell("id") ?? "");
    if (!id) continue;
    rootResolved.set(id, Boolean(cell("resolved")));
  }

  const mentions: MentionItem[] = [];
  for (const row of rows) {
    const rk = rowKindIdx == null ? "" : String(row[rowKindIdx] ?? "").trim();
    if (rk === "task") continue; // tasks live in the separate tasks queue
    const cell = cellGetter(row, headerIdx);
    const mentionsCsv = String(cell("mentions") ?? "")
      .toLowerCase()
      .split(/[,;]+/)
      .map((s) => s.trim());
    if (!mentionsCsv.includes(lcEmail)) continue;

    const project = String(cell("project") ?? "").trim();
    if (!scope.isAdmin && !scope.accessibleProjects.has(project)) continue;

    const id = String(cell("id") ?? "");
    const parent = String(cell("parent_id") ?? "");
    const threadRootId = parent || id;
    const resolved = parent
      ? rootResolved.get(parent) ?? false
      : Boolean(cell("resolved"));

    mentions.push({
      comment_id: id,
      project,
      anchor: String(cell("anchor") ?? ""),
      parent_id: parent,
      thread_root_id: threadRootId,
      author_email: String(cell("author_email") ?? ""),
      author_name: String(cell("author_name") ?? ""),
      body: String(cell("body") ?? ""),
      timestamp: toIsoDate(cell("timestamp")),
      resolved,
      edited_at: toIsoDate(cell("edited_at")) || undefined,
      deep_link: hubCommentUrl(project, id),
    });
  }
  // Newest first so the inbox matches Apps Script behavior.
  mentions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    mentions,
    me: { email: subjectEmail, isAdmin: scope.isAdmin },
    total: mentions.length,
  };
}

/* ── projectMentionTasksDirect (legacy comment-mention Google Tasks) ─ */

export async function projectMentionTasksDirect(
  subjectEmail: string,
  project: string,
): Promise<ProjectTasks> {
  const [{ rows, headerIdx }, scope] = await Promise.all([
    readCommentsOnce(subjectEmail),
    getAccessScope(subjectEmail),
  ]);

  if (!scope.isAdmin && !scope.accessibleProjects.has(project)) {
    throw new Error("Access denied to project: " + project);
  }

  const rowKindIdx = headerIdx.get("row_kind");

  type Raw = {
    id: string;
    parent_id: string;
    anchor: string;
    author_email: string;
    author_name: string;
    body: string;
    mentions: string[];
    timestamp: string;
    resolved: boolean;
    google_tasks_raw: string;
    edited_at: string;
  };
  const rawByProj: Raw[] = [];
  for (const row of rows) {
    const rk = rowKindIdx == null ? "" : String(row[rowKindIdx] ?? "").trim();
    if (rk === "task") continue;
    const cell = cellGetter(row, headerIdx);
    if (String(cell("project") ?? "").trim() !== project) continue;
    rawByProj.push({
      id: String(cell("id") ?? ""),
      parent_id: String(cell("parent_id") ?? ""),
      anchor: String(cell("anchor") ?? ""),
      author_email: String(cell("author_email") ?? ""),
      author_name: String(cell("author_name") ?? ""),
      body: String(cell("body") ?? ""),
      mentions: String(cell("mentions") ?? "")
        .split(/[,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      timestamp: toIsoDate(cell("timestamp")),
      resolved: Boolean(cell("resolved")),
      google_tasks_raw: String(cell("google_tasks") ?? ""),
      edited_at: toIsoDate(cell("edited_at")),
    });
  }

  // Reply counts for the "💬 N" chip on each mention-task card.
  const replyCount = new Map<string, number>();
  for (const r of rawByProj) {
    if (!r.parent_id) continue;
    replyCount.set(r.parent_id, (replyCount.get(r.parent_id) ?? 0) + 1);
  }

  // A "task" in this legacy feed is one row of google_tasks JSON per
  // mention that spawned a Task. Apps Script returns one TaskItem PER
  // (comment × assignee) pair; we preserve that fan-out.
  const tasks: TaskItem[] = [];
  for (const r of rawByProj) {
    let gt: Record<string, { u?: string; l?: string; t?: string; d?: string }> | Array<{ u?: string; l?: string; t?: string; d?: string }> = {};
    if (r.google_tasks_raw) {
      try {
        gt = JSON.parse(r.google_tasks_raw);
      } catch {
        gt = {};
      }
    }
    // Shapes in the wild: array of entries OR object keyed by email.
    const entries = Array.isArray(gt)
      ? gt
      : Object.entries(gt).map(([email, v]) => ({ u: v.u || email, ...v }));
    for (const e of entries) {
      const assigneeEmail = String(e?.u || "").toLowerCase();
      if (!assigneeEmail) continue;
      tasks.push({
        comment_id: r.id,
        project,
        anchor: r.anchor,
        assignee_email: assigneeEmail,
        assignee_name: assigneeEmail.split("@")[0],
        due: String(e?.d || ""),
        title: r.body.slice(0, 80),
        body: r.body,
        author_name: r.author_name,
        author_email: r.author_email,
        parent_id: r.parent_id,
        created_at: r.timestamp,
        resolved: r.resolved,
        edited_at: r.edited_at || undefined,
        reply_count: r.parent_id ? 0 : replyCount.get(r.id) ?? 0,
        deep_link: hubCommentUrl(project, r.id),
      });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  return {
    project,
    tasks,
    me: { email: subjectEmail, isAdmin: scope.isAdmin },
    today,
  };
}
