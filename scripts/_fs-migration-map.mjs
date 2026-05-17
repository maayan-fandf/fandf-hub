/* eslint-disable */
/**
 * Shared Sheets→Firestore mapping for the migration scripts. Pure (no
 * side effects, no I/O) so backfill-firestore.mjs and parity-check.mjs
 * import the SAME logic — a parity check is only meaningful if it maps
 * rows exactly the way the backfill (and the live dual-write) does.
 *
 * This MUST stay byte-identical in shape to lib/firestoreSync.ts
 * (taskToDoc / mirrorComment / mirrorPricingEntry / pricingDocId).
 * It is a faithful port of BOTH rowToTask copies (lib/tasksDirect.ts +
 * lib/tasksWriteDirect.ts), the comment readers (lib/commentsDirect.ts),
 * and lib/pricingLog.ts. Firestore rejects `undefined` → graceful/
 * missing values become `null` (numbers) / `[]` / `{}` / "".
 */

import { createHash } from "node:crypto";

export function parseJsonArray(v) {
  if (v == null || v === "") return [];
  if (typeof v !== "string") return Array.isArray(v) ? v : [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}
export function parseJsonObject(v) {
  if (v == null || v === "") return {};
  if (typeof v !== "string") return v && typeof v === "object" ? v : {};
  try {
    const p = JSON.parse(v);
    return p && typeof p === "object" && !Array.isArray(p) ? p : {};
  } catch {
    return {};
  }
}
/** google_tasks: array now, legacy `{email:ref}` object → Object.values. */
export function parseGoogleTasksCell(v) {
  if (v == null || v === "") return [];
  let p = v;
  if (typeof v === "string") {
    try {
      p = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (Array.isArray(p)) return p;
  if (p && typeof p === "object") return Object.values(p);
  return [];
}
export function toIsoDate(v) {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return String(v);
}
export function numOrNull(raw, { nonNeg = false } = {}) {
  if (raw === "" || raw == null) return null;
  const n = Number(String(raw).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(n)) return null;
  if (nonNeg && n < 0) return null;
  return n;
}
export function boolCoerce(v) {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}
export function emailsFromCsv(s) {
  return String(s ?? "")
    .split(/[,;\n]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/** MUST stay byte-identical to lib/firestoreSync.ts pricingDocId. */
export function pricingDocId(e) {
  const h = createHash("sha1")
    .update(
      [
        e.createdAtIl,
        e.taskId,
        e.company,
        e.project,
        e.departments,
        e.kind,
        String(e.price),
        e.createdBy,
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 24);
  return `plog-${h}`;
}

/** Comments task row → tasks/{id} doc. Mirrors lib/firestoreSync.ts
 *  taskToDoc. `revision_of` is intentionally excluded (not part of the
 *  canonical WorkTask shape — neither rowToTask copy surfaces it). */
export function rowToTaskDoc(row, headerIdx) {
  const cell = (k) => {
    const i = headerIdx.get(k);
    return i == null ? "" : row[i];
  };
  const createdAt = toIsoDate(cell("timestamp"));
  const rankRaw = cell("rank");
  const parsedRank =
    rankRaw === "" || rankRaw == null ? NaN : parseFloat(String(rankRaw));
  const fallbackRank = (() => {
    const ms = Date.parse(createdAt);
    return Number.isFinite(ms) ? -ms : Number.MAX_SAFE_INTEGER / 2;
  })();
  return {
    id: String(cell("id") ?? ""),
    brief: String(cell("brief") ?? ""),
    company: String(cell("company") ?? ""),
    project: String(cell("project") ?? ""),
    title: String(cell("title") ?? ""),
    description: String(cell("body") ?? ""),
    departments: parseJsonArray(cell("departments")),
    kind: String(cell("kind") ?? "other"),
    priority: parseInt(String(cell("priority") ?? "2"), 10) || 2,
    status: String(cell("status") ?? "awaiting_approval"),
    sub_status: String(cell("sub_status") ?? ""),
    author_email: String(cell("author_email") ?? "").toLowerCase(),
    approver_email: String(cell("approver_email") ?? "").toLowerCase(),
    project_manager_email: String(cell("project_manager_email") ?? "").toLowerCase(),
    assignees: emailsFromCsv(cell("mentions")),
    requested_date: String(cell("requested_date") ?? ""),
    created_at: createdAt,
    updated_at: String(cell("updated_at") ?? ""),
    parent_id: String(cell("parent_id") ?? ""),
    round_number: parseInt(String(cell("round_number") ?? "1"), 10) || 1,
    drive_folder_id: String(cell("drive_folder_id") ?? ""),
    drive_folder_url: String(cell("drive_folder_url") ?? ""),
    chat_space_id: String(cell("chat_space_id") ?? ""),
    chat_task_name: String(cell("chat_task_name") ?? ""),
    calendar_event_ids: parseJsonObject(cell("calendar_event_ids")),
    google_tasks: parseGoogleTasksCell(cell("google_tasks")),
    status_history: parseJsonArray(cell("status_history")),
    description_history: parseJsonArray(cell("description_history")),
    edited_at: String(cell("edited_at") ?? ""),
    campaign: String(cell("campaign") ?? ""),
    file_order: String(cell("file_order") ?? ""),
    pending_complete: String(cell("pending_complete") ?? ""),
    rank: Number.isFinite(parsedRank) ? parsedRank : fallbackRank,
    blocks: parseJsonArray(cell("blocks")),
    blocked_by: parseJsonArray(cell("blocked_by")),
    umbrella_id: String(cell("umbrella_id") ?? ""),
    is_umbrella: boolCoerce(cell("is_umbrella")),
    price: numOrNull(cell("price")),
    inprogress_minutes: numOrNull(cell("inprogress_minutes"), { nonNeg: true }),
    time_pauses: parseJsonArray(cell("time_pauses")),
  };
}

/** Comments comment row → comments/{id} doc. Mirrors lib/firestoreSync.ts
 *  mirrorComment. `taskIds` is the set of row_kind='task' ids so taskId
 *  is set only when the DIRECT parent is a task row. */
export function rowToCommentDoc(row, headerIdx, taskIds) {
  const cell = (k) => {
    const i = headerIdx.get(k);
    return i == null ? "" : row[i];
  };
  const parentId = String(cell("parent_id") ?? "").trim();
  return {
    id: String(cell("id") ?? ""),
    project: String(cell("project") ?? "").trim(),
    anchor: String(cell("anchor") ?? ""),
    parent_id: parentId,
    taskId: parentId && taskIds.has(parentId) ? parentId : "",
    author_email: String(cell("author_email") ?? "").toLowerCase(),
    author_name: String(cell("author_name") ?? ""),
    body: String(cell("body") ?? ""),
    mentions: String(cell("mentions") ?? "")
      .split(/[,;\n]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@")),
    resolved: Boolean(cell("resolved")),
    createdAt: toIsoDate(cell("timestamp")),
    edited_at: toIsoDate(cell("edited_at")) || "",
    row_kind: "",
    google_tasks: parseGoogleTasksCell(cell("google_tasks")),
    status_history: parseJsonArray(cell("status_history")),
  };
}

/** PricingLog row (A:I values array) → the stored pricingLog doc shape.
 *  Mirrors lib/firestoreSync.ts mirrorPricingEntry. Returns null for
 *  rows readPricingLog would skip. */
export function pricingRowToDoc(r) {
  const createdAtIl = String(r[0] ?? "").trim();
  const taskId = String(r[1] ?? "").trim();
  if (!createdAtIl && !taskId) return null;
  const priceN = numOrNull(r[6]);
  const billedRaw = r[8];
  const billedHas =
    billedRaw !== undefined &&
    billedRaw !== null &&
    String(billedRaw).trim() !== "";
  const billedN = numOrNull(billedRaw);
  return {
    createdAtIl,
    month: createdAtIl.slice(0, 7),
    taskId,
    company: String(r[2] ?? "").trim(),
    project: String(r[3] ?? "").trim(),
    departments: String(r[4] ?? "").trim(),
    kind: String(r[5] ?? "").trim(),
    price: priceN == null ? 0 : priceN,
    createdBy: String(r[7] ?? "").trim(),
    billed: billedHas && billedN != null ? billedN : null,
  };
}
