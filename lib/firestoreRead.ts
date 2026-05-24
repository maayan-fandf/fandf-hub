/**
 * Phase 3 — Firestore read path (behind USE_FIRESTORE_TASKS).
 * Part of the storage migration (docs/STORAGE_MIGRATION_HANDOFF.md).
 *
 * STRATEGY: minimal blast radius. Every task/comment reader funnels
 * through `readCommentsTab` (lib/tasksDirect.ts) / `readCommentsOnce`
 * (lib/commentsDirect.ts), which return the raw Sheets shape
 * `{ headers, rows[], headerIdx }`. Instead of rewriting every filter
 * + rowToTask + comment reader, this module reconstructs that EXACT
 * shape from Firestore — the faithful INVERSE of the backfill mapping.
 * Downstream code (rowToTask, the filters, the comment readers) then
 * runs byte-identically whether the rows came from Sheets or Firestore.
 *
 * Why this works: the parsers already tolerate both representations
 * (parseJsonCell passes non-strings through; toIsoDate passes strings
 * through), but to be 100% faithful — including readers that do
 * `JSON.parse(String(cell))` (e.g. projectMentionTasksDirect) — we
 * re-serialize the JSON/array/object columns back to strings exactly
 * as the sheet stored them. Numbers/booleans are placed as-is where
 * the parser coerces with String()/Boolean()/parseInt.
 *
 * NOTE (deliberate, not a redesign): this reads the whole tasks +
 * comments collections per call, mirroring the full-tab Sheets read it
 * replaces. It's already a big win (indexed store, no 300/min Sheets
 * quota, no 2MB unstable_cache cap) and keeps the cutover low-risk by
 * reusing all existing filter logic unchanged. Per-query index use /
 * per-doc gets are a later perf follow-up (handoff: Phase-5-era), not
 * required for the correctness cutover.
 */

import { cache } from "react";
import { getDb, FS_COLLECTIONS } from "@/lib/firestore";

/** Canonical header set — the union of every column name any task /
 *  comment reader looks up via headerIdx.get(name). Order is arbitrary
 *  (consumers go through headerIdx), but it must be COMPLETE. */
const HEADERS: string[] = [
  "id",
  "row_kind",
  "parent_id",
  "project",
  "anchor",
  "company",
  "brief",
  "title",
  "body",
  "departments",
  "kind",
  "priority",
  "status",
  "sub_status",
  "author_email",
  "author_name",
  "approver_email",
  "project_manager_email",
  "mentions",
  "requested_date",
  "timestamp",
  "updated_at",
  "round_number",
  "revision_of",
  "drive_folder_id",
  "drive_folder_url",
  "chat_space_id",
  "chat_task_name",
  "calendar_event_ids",
  "google_tasks",
  "status_history",
  "time_pauses",
  "description_history",
  "edited_at",
  "campaign",
  "file_order",
  "pending_complete",
  "rank",
  "blocks",
  "blocked_by",
  "umbrella_id",
  "is_umbrella",
  "price",
  "inprogress_minutes",
  "resolved",
  // Comment-only: audience scope. "internal" = F&F team only (client
  // never sees it), "shared" = visible to the client too. Absent on
  // legacy docs → defaulted to "shared" in commentDocToRow so every
  // pre-scope comment keeps its current client-visible behavior.
  "scope",
];

function buildHeaderIdx(): Map<string, number> {
  const m = new Map<string, number>();
  HEADERS.forEach((h, i) => m.set(h, i));
  return m;
}

const IDX = buildHeaderIdx();

type Row = unknown[];

function blankRow(): Row {
  return new Array(HEADERS.length).fill("");
}
function put(row: Row, key: string, val: unknown): void {
  const i = IDX.get(key);
  if (i != null) row[i] = val;
}

function jstr(v: unknown, arr: boolean): string {
  if (v == null) return JSON.stringify(arr ? [] : {});
  return JSON.stringify(v);
}

/** Firestore task doc → a Comments-shaped row (row_kind='task'). The
 *  inverse of scripts/_fs-migration-map.mjs rowToTaskDoc /
 *  lib/firestoreSync.ts taskToDoc. */
function taskDocToRow(d: Record<string, unknown>): Row {
  const row = blankRow();
  put(row, "id", String(d.id ?? ""));
  put(row, "row_kind", "task");
  put(row, "parent_id", String(d.parent_id ?? ""));
  put(row, "project", String(d.project ?? ""));
  put(row, "anchor", "general");
  put(row, "company", String(d.company ?? ""));
  put(row, "brief", String(d.brief ?? ""));
  put(row, "title", String(d.title ?? ""));
  // body holds description on task rows (rowToTask reads cell("body")).
  put(row, "body", String(d.description ?? ""));
  put(row, "departments", jstr(d.departments, true));
  put(row, "kind", String(d.kind ?? "other"));
  put(row, "priority", typeof d.priority === "number" ? d.priority : 2);
  put(row, "status", String(d.status ?? "awaiting_approval"));
  put(row, "sub_status", String(d.sub_status ?? ""));
  put(row, "author_email", String(d.author_email ?? ""));
  put(row, "approver_email", String(d.approver_email ?? ""));
  put(row, "project_manager_email", String(d.project_manager_email ?? ""));
  // assignees ⇒ the legacy `mentions` CSV column rowToTask splits.
  put(
    row,
    "mentions",
    Array.isArray(d.assignees) ? d.assignees.join(",") : "",
  );
  put(row, "requested_date", String(d.requested_date ?? ""));
  put(row, "timestamp", String(d.created_at ?? ""));
  put(row, "updated_at", String(d.updated_at ?? ""));
  put(
    row,
    "round_number",
    typeof d.round_number === "number" ? d.round_number : 1,
  );
  put(row, "drive_folder_id", String(d.drive_folder_id ?? ""));
  put(row, "drive_folder_url", String(d.drive_folder_url ?? ""));
  put(row, "chat_space_id", String(d.chat_space_id ?? ""));
  put(row, "chat_task_name", String(d.chat_task_name ?? ""));
  put(row, "calendar_event_ids", jstr(d.calendar_event_ids, false));
  put(row, "google_tasks", jstr(d.google_tasks, true));
  put(row, "status_history", jstr(d.status_history, true));
  put(row, "time_pauses", jstr(d.time_pauses, true));
  put(row, "description_history", jstr(d.description_history, true));
  put(row, "edited_at", String(d.edited_at ?? ""));
  put(row, "campaign", String(d.campaign ?? ""));
  put(row, "file_order", String(d.file_order ?? ""));
  put(row, "pending_complete", String(d.pending_complete ?? ""));
  put(row, "rank", typeof d.rank === "number" ? d.rank : "");
  put(row, "blocks", jstr(d.blocks, true));
  put(row, "blocked_by", jstr(d.blocked_by, true));
  put(row, "umbrella_id", String(d.umbrella_id ?? ""));
  put(row, "is_umbrella", d.is_umbrella === true ? "TRUE" : "FALSE");
  put(row, "price", typeof d.price === "number" ? d.price : "");
  put(
    row,
    "inprogress_minutes",
    typeof d.inprogress_minutes === "number" ? d.inprogress_minutes : "",
  );
  // Sheet wrote resolved = (status === 'done'); task readers ignore it
  // but keep it faithful for any row_kind-agnostic scan.
  put(row, "resolved", String(d.status ?? "") === "done");
  return row;
}

/**
 * Phase 4 — expose a single Firestore task doc in the EXACT Sheets
 * `{ row, idx }` shape, so the existing (parity-proven) update logic in
 * tasksUpdateDirect can run UNCHANGED against a Firestore-sourced row
 * inside a transaction. `idx` is a fresh Map per call (callers treat it
 * read-only via .get()). Returns null for an empty/absent doc.
 */
export function taskDocToShapedRow(
  d: Record<string, unknown> | undefined | null,
): { row: unknown[]; idx: Map<string, number> } | null {
  if (!d || !d.id) return null;
  return { row: taskDocToRow(d), idx: buildHeaderIdx() };
}

/** The canonical Comments-shaped header list (Phase 4 writers need it
 *  to translate column-keyed `changes` back to doc fields). */
export function commentsShapeHeaders(): string[] {
  return [...HEADERS];
}

/** Firestore comment doc → a Comments-shaped row (row_kind=''). The
 *  inverse of scripts/_fs-migration-map.mjs rowToCommentDoc /
 *  lib/firestoreSync.ts mirrorComment. */
function commentDocToRow(d: Record<string, unknown>): Row {
  const row = blankRow();
  put(row, "id", String(d.id ?? ""));
  put(row, "row_kind", "");
  put(row, "parent_id", String(d.parent_id ?? ""));
  put(row, "project", String(d.project ?? ""));
  put(row, "anchor", String(d.anchor ?? ""));
  put(row, "author_email", String(d.author_email ?? ""));
  put(row, "author_name", String(d.author_name ?? ""));
  put(row, "body", String(d.body ?? ""));
  put(row, "mentions", Array.isArray(d.mentions) ? d.mentions.join(",") : "");
  put(row, "timestamp", String(d.createdAt ?? ""));
  put(row, "resolved", d.resolved === true);
  put(row, "edited_at", String(d.edited_at ?? ""));
  put(row, "google_tasks", jstr(d.google_tasks, true));
  put(row, "status_history", jstr(d.status_history, true));
  // Graceful: legacy comment docs predate `scope` → treat as "shared"
  // (client-visible), preserving their pre-migration behavior. Only an
  // explicit "internal" narrows visibility.
  put(row, "scope", d.scope === "internal" ? "internal" : "shared");
  return row;
}

type ShapedRead = {
  headers: string[];
  rows: unknown[][];
  headerIdx: Map<string, number>;
};

// Minimal structural snapshot type — matches Firestore's QuerySnapshot
// `forEach` without importing @google-cloud/firestore types (mirrors
// how the rest of this module treats snapshots).
type DocLike = { data: () => unknown };
type SnapLike = { forEach: (cb: (doc: DocLike) => void) => void };

/** Build the Sheets-shaped read from a tasks snapshot + a comments
 *  snapshot. Shared by the whole-collection read AND the §11
 *  project-scoped read so the doc→row mapping can never diverge. */
function shapeSnaps(taskSnap: SnapLike, commentSnap: SnapLike): ShapedRead {
  const rows: unknown[][] = [];
  taskSnap.forEach((doc) =>
    rows.push(taskDocToRow(doc.data() as Record<string, unknown>)),
  );
  commentSnap.forEach((doc) =>
    rows.push(commentDocToRow(doc.data() as Record<string, unknown>)),
  );
  return { headers: [...HEADERS], rows, headerIdx: buildHeaderIdx() };
}

async function readCommentsShapeImpl(): Promise<ShapedRead> {
  const db = getDb();
  const [taskSnap, commentSnap] = await Promise.all([
    db.collection(FS_COLLECTIONS.tasks).get(),
    db.collection(FS_COLLECTIONS.comments).get(),
  ]);
  return shapeSnaps(taskSnap, commentSnap);
}

/**
 * Read the tasks + comments collections and return them in the exact
 * Sheets `{ headers, rows, headerIdx }` shape every reader expects.
 * Server-only (Firestore admin SDK).
 *
 * Wrapped in React `cache()` for PER-REQUEST dedup — this is the
 * read-flip perf fix. The task detail page calls several comment-family
 * readers (taskComments / projectComments / getCommentById / counts …)
 * and tasksGet, each of which funnels here. Uncached, every one did its
 * own full tasks+comments collection read → the detail render went
 * unresponsive (30s+) after a write under Firestore reads. cache()
 * collapses them all to ONE Firestore round-trip per request. Same
 * proven pattern as the Sheets `readCommentsTab` (also React cache()-
 * wrapped + shared across consumers in a request). NOT unstable_cache
 * (the nested-unstable_cache hazard in memory does not apply to React
 * cache(), which composes safely). Cross-request freshness is handled
 * by the per-write invalidate + the awaited mirror (read-your-writes).
 */
export const readCommentsShapeFromFirestore = cache(readCommentsShapeImpl);

/**
 * §11 — Project-scoped Firestore read. Same `{headers,rows,headerIdx}`
 * contract as `readCommentsShapeFromFirestore`, but only the docs for
 * ONE project: `tasks.where(project==X)` + `comments.where(project==X)`.
 * Behavior-identical for the project-page readers (they all filter
 * `proj !== project` anyway) — the win is fetching ~tens of docs
 * instead of the whole collection, killing the ~13s project-page
 * stream.
 *
 * Safe because: every tasks/comments doc carries `project`; a reply's
 * project == its thread root's project (commentsWriteDirect); chain
 * siblings share one project (tasksCreateChain) — so no thread/reply/
 * chain can be split by the equality filter. `כללי` (non-unique name)
 * returns the same multi-company row set the whole read did → company
 * disambiguation downstream is fed identically.
 *
 * Wrapped in React `cache()` keyed by `project`, so every project-
 * scoped reader on one project-page render (getProjectComments ×2,
 * getMyMentions, tasksList, projectOpenTasksDiscussion) collapses to
 * ONE tasks-by-project + ONE comments-by-project round trip. It does
 * NOT touch the process-local TTL slot in lib/tasksDirect.ts (a single
 * shared slot would be poisoned across projects) — freshness is
 * per-request only, the same model the whole-collection Firestore
 * branch already relies on.
 */
async function readCommentsShapeForProjectImpl(
  project: string,
): Promise<ShapedRead> {
  // Degenerate caller (empty/whitespace) → whole-collection read.
  // Stays behavior-identical at the edge: downstream `proj !== project`
  // filters would select empty-project rows the same way.
  if (!project.trim()) return readCommentsShapeImpl();
  const db = getDb();
  const [taskSnap, commentSnap] = await Promise.all([
    db.collection(FS_COLLECTIONS.tasks).where("project", "==", project).get(),
    db
      .collection(FS_COLLECTIONS.comments)
      .where("project", "==", project)
      .get(),
  ]);
  return shapeSnaps(taskSnap, commentSnap);
}

export const readCommentsShapeForProject = cache(
  readCommentsShapeForProjectImpl,
);

/** PricingLog ledger from Firestore, shaped like lib/pricingLog.ts
 *  PricingLogRow (minus the report-time title/brief/worker enrichment
 *  the page joins separately). */
export async function readPricingLogFromFirestore(): Promise<
  Array<{
    createdAt: string;
    month: string;
    taskId: string;
    company: string;
    project: string;
    departments: string;
    kind: string;
    price: number;
    createdBy: string;
    billed?: number;
    note?: string;
  }>
> {
  const snap = await getDb().collection(FS_COLLECTIONS.pricingLog).get();
  const out: Array<{
    createdAt: string;
    month: string;
    taskId: string;
    company: string;
    project: string;
    departments: string;
    kind: string;
    price: number;
    createdBy: string;
    billed?: number;
    note?: string;
  }> = [];
  snap.forEach((doc) => {
    const d = doc.data() as Record<string, unknown>;
    const createdAt = String(d.createdAtIl ?? "").trim();
    const taskId = String(d.taskId ?? "").trim();
    if (!createdAt && !taskId) return;
    const price = typeof d.price === "number" ? d.price : 0;
    const note = String(d.note ?? "").trim();
    out.push({
      createdAt,
      month: String(d.month ?? createdAt.slice(0, 7)),
      taskId,
      company: String(d.company ?? "").trim(),
      project: String(d.project ?? "").trim(),
      departments: String(d.departments ?? "").trim(),
      kind: String(d.kind ?? "").trim(),
      price: Number.isFinite(price) ? price : 0,
      createdBy: String(d.createdBy ?? "").trim(),
      billed: typeof d.billed === "number" ? d.billed : undefined,
      note: note || undefined,
    });
  });
  return out;
}
