/**
 * Phase 4 — Firestore-authoritative write core.
 * Part of the storage migration (docs/STORAGE_MIGRATION_HANDOFF.md).
 *
 * The write orchestrators (tasksWriteDirect etc.) keep ALL their proven
 * business logic and keep computing a Comments-column-keyed `changes`
 * map exactly as today. This module only swaps the PERSISTENCE: instead
 * of a Sheets batchUpdate, it writes the Firestore `tasks/{id}` doc
 * inside a transaction.
 *
 * `withTaskLock` (in-process mutex) is kept as cheap same-instance
 * serialization, but the real cross-instance atomicity now comes from
 * the Firestore transaction here: append-type fields (status_history,
 * time_pauses, description_history) are NOT overwritten with a possibly
 * stale full array — the caller passes the appended ENTRIES as deltas
 * and we re-apply them onto the doc's CURRENT array inside the txn, so
 * a concurrent writer can't drop history (the transaction retries on
 * contention and re-appends). This is the faithful withTaskLock →
 * transaction port the handoff calls for.
 *
 * Everything is gated by useFirestoreWrites() at the call sites; this
 * module is only reached when the Phase-4 flag is on.
 */

import { getDb, FS_COLLECTIONS } from "@/lib/firestore";
import { taskDocToShapedRow } from "@/lib/firestoreRead";
import type { WorkTask } from "@/lib/appsScript";

/** Comments-column keys that hold JSON-array values in `changes`
 *  (writers JSON.stringify them). Translated back to native arrays. */
const ARRAY_JSON_COLS = new Set([
  "departments",
  "status_history",
  "time_pauses",
  "description_history",
  "blocks",
  "blocked_by",
  "google_tasks",
]);
/** Comments-column keys holding a JSON object. */
const OBJECT_JSON_COLS = new Set(["calendar_event_ids"]);
/** Append-type history fields — re-applied as deltas inside the txn. */
export const APPEND_COLS = new Set([
  "status_history",
  "time_pauses",
  "description_history",
]);

function parseJson(v: unknown, arr: boolean): unknown {
  if (v == null || v === "") return arr ? [] : {};
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return arr ? [] : {};
  }
}

/**
 * Translate the Comments-column-keyed `changes` map (exactly what
 * tasksUpdateDirect computes) into Firestore task-doc fields. The exact
 * inverse of firestoreRead.taskDocToRow's per-field mapping.
 *
 * APPEND_COLS are intentionally EXCLUDED here — they're handled as
 * deltas in the transaction so concurrent writers don't clobber
 * history. `resolved` / `anchor` are derived/constant in the doc shape
 * (taskDocToRow re-derives them) → skipped.
 */
export function changesToTaskDocFields(
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(changes)) {
    if (APPEND_COLS.has(k)) continue; // handled via delta in the txn
    if (k === "resolved" || k === "anchor") continue; // derived/const
    if (k === "body") {
      out.description = String(v ?? "");
    } else if (k === "mentions") {
      out.assignees = String(v ?? "")
        .split(/[,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (k === "timestamp") {
      out.created_at = String(v ?? "");
    } else if (ARRAY_JSON_COLS.has(k)) {
      out[k] = parseJson(v, true);
    } else if (OBJECT_JSON_COLS.has(k)) {
      out[k] = parseJson(v, false);
    } else if (k === "is_umbrella") {
      out.is_umbrella =
        v === true || v === "TRUE" || v === "true" || v === 1 || v === "1";
    } else if (k === "price" || k === "inprogress_minutes") {
      if (v === "" || v == null) out[k] = null;
      else {
        const n = Number(String(v).replace(/[^\d.-]/g, ""));
        out[k] = Number.isFinite(n) ? n : null;
      }
    } else if (k === "priority" || k === "round_number") {
      const n = parseInt(String(v ?? ""), 10);
      out[k] = Number.isFinite(n) ? n : k === "priority" ? 2 : 1;
    } else if (k === "rank") {
      if (v === "" || v == null) out.rank = null;
      else {
        const n = Number(v);
        out.rank = Number.isFinite(n) ? n : null;
      }
    } else {
      // status, sub_status, title, kind, approver_email,
      // project_manager_email, requested_date, brief, company,
      // campaign, file_order, pending_complete, project, updated_at,
      // edited_at, drive_folder_id, drive_folder_url, umbrella_id,
      // parent_id, author_email, chat_space_id, chat_task_name …
      out[k] = String(v ?? "");
    }
  }
  return out;
}

/** Append deltas the orchestrator pushed this update (the ENTRIES, not
 *  the full arrays). Keyed by the Comments column name. */
export type TaskAppendDeltas = {
  status_history?: unknown[];
  time_pauses?: unknown[];
  description_history?: unknown[];
};

/**
 * Persist a task update to Firestore in a transaction. Reads the
 * current doc, sets the translated scalar/array fields (last-writer-
 * wins per field — identical to today's per-cell Sheets batchUpdate),
 * and RE-APPENDS the history deltas onto the doc's current arrays
 * (concurrency-safe; the txn retries on contention). Returns the
 * post-write task as a WorkTask. Throws if the doc is missing
 * (surfaces — Phase 4 failures are no longer swallowed).
 */
export async function persistTaskUpdateFirestore(
  taskId: string,
  changes: Record<string, unknown>,
  appends: TaskAppendDeltas,
): Promise<{ task: WorkTask; row: unknown[]; idx: Map<string, number> }> {
  const id = String(taskId || "").trim();
  if (!id) throw new Error("persistTaskUpdateFirestore: empty taskId");
  const db = getDb();
  const ref = db.collection(FS_COLLECTIONS.tasks).doc(id);
  const fields = changesToTaskDocFields(changes);

  const merged = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Task not found: " + id);
    const cur = snap.data() as Record<string, unknown>;
    const update: Record<string, unknown> = { ...fields };
    // History appends: base on the CURRENT doc array (not a stale
    // read from the orchestrator), then append the delta entries.
    for (const col of APPEND_COLS) {
      const delta = (appends as Record<string, unknown[] | undefined>)[col];
      if (delta == null) continue;
      const curArr = Array.isArray(cur[col]) ? (cur[col] as unknown[]) : [];
      update[col] = [...curArr, ...delta];
    }
    tx.set(ref, update, { merge: true });
    return { ...cur, ...update };
  });

  const shaped = taskDocToShapedRow(merged);
  if (!shaped) throw new Error("persistTaskUpdateFirestore: shape failed " + id);
  const { rowToTaskForMirror } = await import("@/lib/tasksDirect");
  return {
    task: rowToTaskForMirror(shaped.row, shaped.idx),
    row: shaped.row,
    idx: shaped.idx,
  };
}

/**
 * Create a task doc in Firestore (Phase 4 authoritative create).
 * Overwrites by id (tasks are created once with a fresh id). Throws on
 * failure (surfaces).
 */
export async function createTaskFirestore(
  doc: Record<string, unknown>,
): Promise<void> {
  const id = String(doc.id || "").trim();
  if (!id) throw new Error("createTaskFirestore: empty task id");
  await getDb().collection(FS_COLLECTIONS.tasks).doc(id).set(doc);
}
