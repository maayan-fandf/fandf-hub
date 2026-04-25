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

/* ── getCommentByIdDirect ──────────────────────────────────────────── */

/** Lean payload for the "convert comment to task" pre-fill flow on
 *  /tasks/new. Just the fields the create form cares about — no replies,
 *  no resolved state, no spawned-task refs. */
export type CommentSeed = {
  id: string;
  project: string;
  body: string;
  mentions: string[];
  author_email: string;
  author_name: string;
};

/** Single-row fetch by comment id, used when /tasks/new is opened with
 *  `?from_comment=<id>` to pre-populate the create form. Returns null
 *  if the row doesn't exist or the caller can't access its project. */
export async function getCommentByIdDirect(
  subjectEmail: string,
  commentId: string,
): Promise<CommentSeed | null> {
  const [{ rows, headerIdx }, scope] = await Promise.all([
    readCommentsOnce(subjectEmail),
    getAccessScope(subjectEmail),
  ]);
  const idIdx = headerIdx.get("id");
  if (idIdx == null) return null;
  const target = String(commentId || "").trim();
  for (const row of rows) {
    if (String(row[idIdx] ?? "").trim() !== target) continue;
    const cell = cellGetter(row, headerIdx);
    const project = String(cell("project") ?? "").trim();
    if (!project) return null;
    if (!scope.isAdmin && !scope.accessibleProjects.has(project)) return null;
    const mentionsCsv = String(cell("mentions") ?? "");
    const mentions = mentionsCsv
      .split(/[,;\n]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@"));
    return {
      id: String(cell("id") ?? ""),
      project,
      body: String(cell("body") ?? ""),
      mentions,
      author_email: String(cell("author_email") ?? "").toLowerCase(),
      author_name: String(cell("author_name") ?? ""),
    };
  }
  return null;
}

/* ── migrateCommentThreadDirect ────────────────────────────────────── */

function columnLetter(colNumber: number): string {
  // 1 -> A, 27 -> AA. Used to build A1 ranges for batchUpdate.
  let n = colNumber;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Move an entire comment thread (root + replies) under a newly-created
 * task. Used by the convert-to-task flow:
 *
 *   - Source comment row C: parent_id "" → newTaskId
 *   - Each reply Rn (parent_id = C.id): → newTaskId
 *
 * Result: every row that was previously part of the C-thread becomes a
 * direct reply on the task, preserving identity / timestamps / authors.
 * The original 2-level hierarchy (root→replies) flattens into the task's
 * 1-level reply list, in original chronological order.
 *
 * Best-effort: if the source comment is not found, returns silently
 * (the task creation itself already succeeded; caller doesn't roll back).
 */
export async function migrateCommentThreadDirect(
  subjectEmail: string,
  sourceCommentId: string,
  newTaskId: string,
): Promise<{ migrated: number }> {
  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_COMMENTS");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: "Comments",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (values.length < 2) return { migrated: 0 };
  const headers = (values[0] as unknown[]).map((h) =>
    String(h ?? "").trim(),
  );
  const idIdx = headers.indexOf("id");
  const parentIdx = headers.indexOf("parent_id");
  if (idIdx < 0 || parentIdx < 0) return { migrated: 0 };
  const parentCol = columnLetter(parentIdx + 1);

  // Collect every row whose id == sourceCommentId OR whose parent_id ==
  // sourceCommentId. The first set has 0 or 1 entries (the root); the
  // second set is the replies. Both move to parent_id = newTaskId.
  const updates: Array<{ range: string; values: [[string]] }> = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const rowId = String(row[idIdx] ?? "").trim();
    const rowParent = String(row[parentIdx] ?? "").trim();
    const isRoot = rowId === sourceCommentId;
    const isReply = rowParent === sourceCommentId;
    if (!isRoot && !isReply) continue;
    // Sheet row number = i + 1 (values[0] is the header row).
    const sheetRow = i + 1;
    updates.push({
      range: `Comments!${parentCol}${sheetRow}`,
      values: [[newTaskId]],
    });
  }
  if (updates.length === 0) return { migrated: 0 };
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: ssId,
    requestBody: { valueInputOption: "RAW", data: updates },
  });
  return { migrated: updates.length };
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

/* ── taskCommentsDirect ────────────────────────────────────────────── */

/**
 * Comments parented to a task (`row_kind='task'`). A task-comment is just a
 * regular comment row (`row_kind=''`) whose `parent_id` is a task id —
 * `postReplyForUser_` in Apps Script already handles the write side as-is.
 * This reader filters the Comments sheet to those rows for a given task and
 * enforces project-scoped access via the task's own `project` field.
 */
export async function taskCommentsDirect(
  subjectEmail: string,
  taskId: string,
): Promise<{
  task_id: string;
  project: string;
  comments: CommentItem[];
  me: { email: string; isAdmin: boolean };
}> {
  const [{ rows, headerIdx }, scope] = await Promise.all([
    readCommentsOnce(subjectEmail),
    getAccessScope(subjectEmail),
  ]);

  const rowKindIdx = headerIdx.get("row_kind");

  // First pass — locate the task row so we know its project for the access
  // check. Tasks live in the same Comments sheet with row_kind='task'.
  let taskProject = "";
  for (const row of rows) {
    const cell = cellGetter(row, headerIdx);
    if (String(cell("id") ?? "") !== taskId) continue;
    const rk = rowKindIdx == null ? "" : String(row[rowKindIdx] ?? "").trim();
    if (rk !== "task") continue;
    taskProject = String(cell("project") ?? "").trim();
    break;
  }
  if (!taskProject) throw new Error("Task not found: " + taskId);

  if (!scope.isAdmin && !scope.accessibleProjects.has(taskProject)) {
    throw new Error("Access denied to project: " + taskProject);
  }

  // Second pass — collect comment rows (row_kind empty) whose parent is the task.
  const comments: CommentItem[] = [];
  for (const row of rows) {
    const rk = rowKindIdx == null ? "" : String(row[rowKindIdx] ?? "").trim();
    if (rk === "task") continue;
    const cell = cellGetter(row, headerIdx);
    if (String(cell("parent_id") ?? "") !== taskId) continue;

    const id = String(cell("id") ?? "");
    const project = String(cell("project") ?? "").trim();
    const mentionsRaw = String(cell("mentions") ?? "");
    comments.push({
      comment_id: id,
      project,
      anchor: String(cell("anchor") ?? ""),
      parent_id: taskId,
      author_email: String(cell("author_email") ?? ""),
      author_name: String(cell("author_name") ?? ""),
      body: String(cell("body") ?? ""),
      mentions: mentionsRaw
        .split(/[,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      timestamp: toIsoDate(cell("timestamp")),
      resolved: Boolean(cell("resolved")),
      reply_count: 0,
      edited_at: toIsoDate(cell("edited_at")) || undefined,
      deep_link: hubCommentUrl(project, id),
    });
  }

  // Oldest-first: task comments read top-to-bottom like a chat log.
  comments.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    task_id: taskId,
    project: taskProject,
    comments,
    me: { email: subjectEmail, isAdmin: scope.isAdmin },
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

/* ── getMyCountsDirect ───────────────────────────────────────────────── */

/**
 * Direct-SA implementation of `myCounts`. Reads the Comments sheet
 * once, builds per-project tallies of:
 *   - openTasks: count of legacy comment-mention spawned Google Tasks
 *     on unresolved threads (admin-gated to projects the user can see).
 *   - openMentions: count of unresolved threads (or replies under
 *     unresolved roots) where the user is in `mentions`.
 *
 * Mirrors `getMyCountsForUser_` in dashboard-clasp Code.js exactly so
 * the wrapper in lib/appsScript.ts can branch on USE_SA_COMMENTS_READS
 * without changing the response shape.
 *
 * Ignores `row_kind='task'` rows — those belong to the new task system
 * and aren't counted in this legacy "open tasks" tally.
 */
import type { MyCounts } from "@/lib/appsScript";

export async function getMyCountsDirect(
  subjectEmail: string,
): Promise<MyCounts> {
  const target = subjectEmail.toLowerCase().trim();
  const [{ rows, headerIdx }, scope] = await Promise.all([
    readCommentsOnce(subjectEmail),
    getAccessScope(subjectEmail),
  ]);

  const rowKindIdx = headerIdx.get("row_kind");
  const idIdx = headerIdx.get("id");
  const parentIdx = headerIdx.get("parent_id");
  const projectIdx = headerIdx.get("project");
  const resolvedIdx = headerIdx.get("resolved");
  const mentionsIdx = headerIdx.get("mentions");
  const googleTasksIdx = headerIdx.get("google_tasks");

  // First pass: index all comment rows by id so a reply can look up
  // its root's resolved state. Skip task rows.
  type Raw = {
    id: string;
    parent_id: string;
    project: string;
    resolved: boolean;
    mentions: string[];
    googleTasksLen: number;
  };
  const all: Raw[] = [];
  for (const row of rows) {
    if (rowKindIdx != null && String(row[rowKindIdx] ?? "").trim() === "task") {
      continue;
    }
    const id = idIdx != null ? String(row[idIdx] ?? "") : "";
    if (!id) continue;
    const project = projectIdx != null ? String(row[projectIdx] ?? "") : "";
    const parent_id = parentIdx != null ? String(row[parentIdx] ?? "") : "";
    const resolved = resolvedIdx != null ? Boolean(row[resolvedIdx]) : false;
    const mentionsRaw =
      mentionsIdx != null ? String(row[mentionsIdx] ?? "") : "";
    const mentions = mentionsRaw
      .split(/[,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    let googleTasksLen = 0;
    if (googleTasksIdx != null) {
      const v = row[googleTasksIdx];
      if (v) {
        try {
          const parsed = JSON.parse(String(v));
          if (Array.isArray(parsed)) googleTasksLen = parsed.length;
          else if (parsed && typeof parsed === "object") {
            googleTasksLen = Object.keys(parsed).length;
          }
        } catch {
          /* ignore */
        }
      }
    }
    all.push({ id, parent_id, project, resolved, mentions, googleTasksLen });
  }

  const byId = new Map<string, Raw>();
  for (const r of all) byId.set(r.id, r);

  const byProject: Record<string, { openTasks: number; openMentions: number }> =
    {};
  let totalTasks = 0;
  let totalMentions = 0;

  for (const c of all) {
    if (!c.project) continue;
    const projKey = c.project.toLowerCase().trim();
    const canSeeProject = scope.isAdmin || scope.accessibleProjects.has(c.project);

    if (!byProject[c.project]) {
      byProject[c.project] = { openTasks: 0, openMentions: 0 };
    }

    // openTasks: legacy comment-mention Google Tasks count on
    // unresolved threads. Admin sees all; non-admins gated by Keys.
    if (canSeeProject && !c.resolved && c.googleTasksLen > 0) {
      byProject[c.project].openTasks += c.googleTasksLen;
      totalTasks += c.googleTasksLen;
    }

    // openMentions: this user is mentioned + the thread root is open.
    if (target && c.mentions.includes(target)) {
      const root = c.parent_id ? byId.get(c.parent_id) ?? c : c;
      if (!root.resolved) {
        byProject[c.project].openMentions++;
        totalMentions++;
      }
    }
    void projKey; // keep TS happy if we ever extend on this var
  }

  // Strip projects with zero of both counts.
  const pruned: Record<string, { openTasks: number; openMentions: number }> = {};
  for (const [p, v] of Object.entries(byProject)) {
    if (v.openTasks > 0 || v.openMentions > 0) pruned[p] = v;
  }

  return {
    me: { email: subjectEmail, isAdmin: scope.isAdmin },
    total: { openTasks: totalTasks, openMentions: totalMentions },
    byProject: pruned,
  };
}
