/**
 * Phase 2 — best-effort Firestore dual-write.
 * Part of the storage migration (docs/STORAGE_MIGRATION_HANDOFF.md).
 *
 * CONTRACT (do not weaken before Phase 4):
 *  - Every function is GATED on useFirestoreDualWrite() (the Phase-2
 *    flag, INDEPENDENT of the Phase-3 read flag). Flag off → instant
 *    no-op (returns before touching anything). Default off.
 *  - Every function is BEST-EFFORT: it NEVER throws and NEVER blocks the
 *    Sheets write. Callers `void` these. A Firestore failure logs and is
 *    swallowed — Sheets stays the source of truth through Phase 3, so a
 *    missed mirror just shows up as parity drift (scripts/parity-check),
 *    not as a user-visible failure. Phase 4 is where Firestore failures
 *    start to surface.
 *
 * DOC SHAPES are the canonical WorkTask shape (lib/appsScript.ts) for
 * tasks, and must stay byte-identical to what scripts/backfill-firestore.mjs
 * writes so scripts/parity-check.mjs can diff the two cleanly. If you
 * change a shape here, change it in the backfill + parity scripts too.
 * Firestore rejects `undefined` → optional/absent values become `null`
 * (numbers/strings) or `[]`/`{}` (collections).
 */

import { createHash } from "node:crypto";
import { useFirestoreDualWrite } from "@/lib/sa";
import { getDb, FS_COLLECTIONS } from "@/lib/firestore";
import type { WorkTask, GTaskRef } from "@/lib/appsScript";

/** Dual-write is gated on its OWN flag (USE_FIRESTORE_DUALWRITE), NOT
 *  the read flag — so it can soak (Sheets still serving reads) and so
 *  the read-flag rollback stays lossless (Sheets keeps being mirrored
 *  while reads fall back to Sheets). See lib/sa.ts. */
function fsEnabled(): boolean {
  return useFirestoreDualWrite();
}

/** Run a best-effort mirror. Never throws; logs and swallows. No-op
 *  when the flag is off (so call sites pay ~nothing in the default
 *  state). */
async function safe(label: string, fn: () => Promise<void>): Promise<void> {
  if (!fsEnabled()) return;
  try {
    await fn();
  } catch (e) {
    console.log(
      `[firestoreSync] ${label} mirror failed (non-fatal):`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/* ── id helpers ───────────────────────────────────────────────────── */

/** pricingLog has no natural id. Deterministic content hash → the
 *  backfill AND this dual-write produce the SAME doc id for the same
 *  ledger row, so a backfill re-run after dual-write started can't
 *  double-count, and parity stays an exact multiset compare. Two
 *  byte-identical ledger rows (same second, task, price, creator)
 *  collapse to one doc — indistinguishable charges on an append-only
 *  ledger; acceptable + safer than id drift. MUST match
 *  scripts/backfill-firestore.mjs. */
export function pricingDocId(e: {
  createdAtIl: string;
  taskId: string;
  company: string;
  project: string;
  departments: string;
  kind: string;
  price: number;
  createdBy: string;
}): string {
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

/* ── task ─────────────────────────────────────────────────────────── */

/** Canonical WorkTask → Firestore doc. Drops the derived
 *  `comments_count` (recomputed on read, not stored — would only cause
 *  spurious parity churn). Normalizes undefined → null/[]/{}.
 *
 *  EXPORTED for Phase 4: tasksCreateDirect builds the create doc via
 *  `createTaskFirestore(taskToDoc(task))` (handoff §10.1). It stays the
 *  single canonical WorkTask→doc mapping so the create path and the
 *  dual-write mirror can never drift. */
export function taskToDoc(t: WorkTask): Record<string, unknown> {
  return {
    id: String(t.id ?? ""),
    brief: String(t.brief ?? ""),
    company: String(t.company ?? ""),
    project: String(t.project ?? ""),
    title: String(t.title ?? ""),
    description: String(t.description ?? ""),
    departments: Array.isArray(t.departments) ? t.departments : [],
    kind: String(t.kind ?? "other"),
    priority: typeof t.priority === "number" ? t.priority : 2,
    status: String(t.status ?? "awaiting_approval"),
    sub_status: String(t.sub_status ?? ""),
    author_email: String(t.author_email ?? "").toLowerCase(),
    approver_email: String(t.approver_email ?? "").toLowerCase(),
    project_manager_email: String(t.project_manager_email ?? "").toLowerCase(),
    assignees: Array.isArray(t.assignees) ? t.assignees : [],
    requested_date: String(t.requested_date ?? ""),
    created_at: String(t.created_at ?? ""),
    updated_at: String(t.updated_at ?? ""),
    parent_id: String(t.parent_id ?? ""),
    round_number: typeof t.round_number === "number" ? t.round_number : 1,
    drive_folder_id: String(t.drive_folder_id ?? ""),
    drive_folder_url: String(t.drive_folder_url ?? ""),
    chat_space_id: String(t.chat_space_id ?? ""),
    chat_task_name: String(t.chat_task_name ?? ""),
    calendar_event_ids:
      t.calendar_event_ids && typeof t.calendar_event_ids === "object"
        ? t.calendar_event_ids
        : {},
    google_tasks: Array.isArray(t.google_tasks) ? t.google_tasks : [],
    status_history: Array.isArray(t.status_history) ? t.status_history : [],
    description_history: Array.isArray(t.description_history)
      ? t.description_history
      : [],
    edited_at: String(t.edited_at ?? ""),
    campaign: String(t.campaign ?? ""),
    file_order: String(t.file_order ?? ""),
    pending_complete: String(t.pending_complete ?? ""),
    rank: typeof t.rank === "number" ? t.rank : null,
    blocks: Array.isArray(t.blocks) ? t.blocks : [],
    blocked_by: Array.isArray(t.blocked_by) ? t.blocked_by : [],
    umbrella_id: String(t.umbrella_id ?? ""),
    is_umbrella: t.is_umbrella === true,
    price: typeof t.price === "number" ? t.price : null,
    inprogress_minutes:
      typeof t.inprogress_minutes === "number" ? t.inprogress_minutes : null,
    time_pauses: Array.isArray(t.time_pauses) ? t.time_pauses : [],
  };
}

/** Upsert the full task doc. Used by tasksCreateDirect (new task) and
 *  tasksUpdateDirect (after the row write, from the re-read row). Full
 *  `.set()` (overwrite) keeps it idempotent + convergent with the
 *  backfill. */
export async function mirrorTask(task: WorkTask): Promise<void> {
  await safe(`task ${task.id}`, async () => {
    const id = String(task.id ?? "").trim();
    if (!id) return;
    await getDb()
      .collection(FS_COLLECTIONS.tasks)
      .doc(id)
      .set(taskToDoc(task));
  });
}

/** Re-read a task row via the existing direct reader and mirror it.
 *  Universal hook for writers that mutate a row WITHOUT producing a
 *  WorkTask in hand (dependencyCascade / umbrellaRecompute batchUpdates).
 *  Uses the SA admin identity for the read (these run post-write,
 *  best-effort, off the user's critical path). */
export async function mirrorTaskById(
  subjectEmail: string,
  taskId: string,
): Promise<void> {
  await safe(`taskById ${taskId}`, async () => {
    const id = String(taskId ?? "").trim();
    if (!id) return;
    // MUST read the just-written SHEETS row — NOT tasksGetDirect, which
    // is flag-gated and (when reads are flipped to Firestore) would
    // read the stale Firestore copy and mirror it back unchanged. That
    // was the read-flip bug. tasksGetFromSheetsForMirror is pinned to
    // Sheets unconditionally.
    const { tasksGetFromSheetsForMirror } = await import("@/lib/tasksDirect");
    const task = await tasksGetFromSheetsForMirror(subjectEmail, id);
    if (!task) return;
    await getDb()
      .collection(FS_COLLECTIONS.tasks)
      .doc(id)
      .set(taskToDoc(task));
  });
}

/** Merge just the google_tasks cell (+ updated_at) for the GT-cell-only
 *  writers: persistGoogleTasksCell + the pollTasks due-date update.
 *  merge:true so it doesn't clobber the rest of the doc if a full
 *  mirror raced. */
export async function mirrorGoogleTasks(
  taskId: string,
  refs: GTaskRef[],
): Promise<void> {
  await safe(`gtasks ${taskId}`, () => writeGoogleTasks(taskId, refs));
}

/** Phase 4 — AUTHORITATIVE google_tasks-cell merge. Un-gated body of
 *  mirrorGoogleTasks (see writeCommentDoc rationale). Used by the
 *  pollTasks due-date writer when Sheets writes have stopped. */
export async function writeGoogleTasks(
  taskId: string,
  refs: GTaskRef[],
): Promise<void> {
  const id = String(taskId ?? "").trim();
  if (!id) return;
  await getDb()
    .collection(FS_COLLECTIONS.tasks)
    .doc(id)
    .set(
      {
        google_tasks: Array.isArray(refs) ? refs : [],
        updated_at: new Date().toISOString(),
      },
      { merge: true },
    );
}

/* ── comment ──────────────────────────────────────────────────────── */

export type CommentMirror = {
  id: string;
  project: string;
  anchor: string;
  parent_id: string;
  /** Set only when the DIRECT parent is a task row (mirrors how
   *  taskCommentsDirect matches a task's own comments). Replies → "". */
  taskId: string;
  author_email: string;
  author_name: string;
  body: string;
  mentions: string[];
  resolved: boolean;
  createdAt: string;
  edited_at: string;
  google_tasks: GTaskRef[];
  status_history: unknown[];
  /** Audience scope. "internal" = F&F team only (client never sees it);
   *  "shared" (default) = visible to the client too. */
  scope: "internal" | "shared";
};

/**
 * Phase 4 — AUTHORITATIVE comment-doc upsert. The exact Firestore write
 * mirrorComment performs, but WITHOUT the `safe()` wrapper (no
 * dual-write-flag gate, no error swallow). Phase-4 call sites await
 * this directly so the write is the source of truth and failures
 * surface. The doc shape lives here ONCE so the dual-write mirror and
 * the Phase-4 authoritative path can never drift (parity invariant). */
export async function writeCommentDoc(c: CommentMirror): Promise<void> {
  const id = String(c.id ?? "").trim();
  if (!id) return;
  await getDb().collection(FS_COLLECTIONS.comments).doc(id).set({
    id,
    project: c.project,
    anchor: c.anchor,
    parent_id: c.parent_id,
    taskId: c.taskId,
    author_email: c.author_email,
    author_name: c.author_name,
    body: c.body,
    mentions: Array.isArray(c.mentions) ? c.mentions : [],
    resolved: c.resolved === true,
    createdAt: c.createdAt,
    edited_at: c.edited_at || "",
    row_kind: "",
    google_tasks: Array.isArray(c.google_tasks) ? c.google_tasks : [],
    status_history: Array.isArray(c.status_history) ? c.status_history : [],
    scope: c.scope === "internal" ? "internal" : "shared",
  });
}

/** Upsert a full comment doc (postReply / createMention). */
export async function mirrorComment(c: CommentMirror): Promise<void> {
  await safe(`comment ${c.id}`, () => writeCommentDoc(c));
}

/** Phase 4 — AUTHORITATIVE partial merge onto a comment doc. Un-gated
 *  body of mirrorCommentFields (see writeCommentDoc rationale). */
export async function writeCommentFields(
  commentId: string,
  partial: Record<string, unknown>,
): Promise<void> {
  const id = String(commentId ?? "").trim();
  if (!id) return;
  await getDb()
    .collection(FS_COLLECTIONS.comments)
    .doc(id)
    .set(partial, { merge: true });
}

/** Merge a partial onto a comment doc (resolve toggle / body edit). */
export async function mirrorCommentFields(
  commentId: string,
  partial: Record<string, unknown>,
): Promise<void> {
  await safe(`commentFields ${commentId}`, () =>
    writeCommentFields(commentId, partial),
  );
}

/** Phase 4 — AUTHORITATIVE hard-delete of a comment + its replies.
 *  Un-gated body of mirrorCommentsDeleted (see writeCommentDoc
 *  rationale). */
export async function deleteCommentDocs(commentIds: string[]): Promise<void> {
  const ids = commentIds.map((s) => String(s ?? "").trim()).filter(Boolean);
  if (ids.length === 0) return;
  const db = getDb();
  const batch = db.batch();
  for (const id of ids) {
    batch.delete(db.collection(FS_COLLECTIONS.comments).doc(id));
  }
  await batch.commit();
}

/** Hard-delete a comment + its replies (deleteCommentDirect). */
export async function mirrorCommentsDeleted(
  commentIds: string[],
): Promise<void> {
  await safe(`commentsDeleted ${commentIds.length}`, () =>
    deleteCommentDocs(commentIds),
  );
}

/* ── pricingLog ───────────────────────────────────────────────────── */

export type PricingMirror = {
  createdAtIl: string;
  taskId: string;
  company: string;
  project: string;
  departments: string;
  kind: string;
  price: number;
  createdBy: string;
  billed: number | null;
  /** Optional free-text note. Used by manual billing entries (added from
   *  /admin/billing); blank for auto-logged task rows. Not part of
   *  pricingDocId, so it never affects idempotency. */
  note?: string;
};

/** Phase 4 — AUTHORITATIVE single ledger-entry write. Un-gated body of
 *  mirrorPricingEntry (see writeCommentDoc rationale). Deterministic
 *  content-hash id → idempotent with the backfill AND with a prior
 *  dual-write of the same entry. */
export async function writePricingEntry(e: PricingMirror): Promise<void> {
  const docId = pricingDocId(e);
  await getDb()
    .collection(FS_COLLECTIONS.pricingLog)
    .doc(docId)
    .set({
      createdAtIl: e.createdAtIl,
      month: String(e.createdAtIl || "").slice(0, 7),
      taskId: e.taskId,
      company: e.company,
      project: e.project,
      departments: e.departments,
      kind: e.kind,
      price: typeof e.price === "number" ? e.price : 0,
      createdBy: e.createdBy,
      billed: typeof e.billed === "number" ? e.billed : null,
      note: typeof e.note === "string" ? e.note : "",
    });
}

/** Append one ledger entry (logTaskPricing dual-write). Deterministic
 *  content-hash id → idempotent with the backfill. */
export async function mirrorPricingEntry(e: PricingMirror): Promise<void> {
  await safe(`pricing ${e.taskId}`, () => writePricingEntry(e));
}

/** Phase 4 — AUTHORITATIVE billed-override write across every ledger
 *  doc for a task. Un-gated body of mirrorPricingBilled. Returns the
 *  number of ledger docs updated (0 = task not in the ledger) so the
 *  Phase-4 caller can surface the same count the Sheets path returned.
 *  `null` clears the override. */
export async function writePricingBilled(
  taskId: string,
  billed: number | null,
): Promise<number> {
  const id = String(taskId ?? "").trim();
  if (!id) return 0;
  const db = getDb();
  const snap = await db
    .collection(FS_COLLECTIONS.pricingLog)
    .where("taskId", "==", id)
    .get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.docs.forEach((d) =>
    batch.set(
      d.ref,
      { billed: typeof billed === "number" ? billed : null },
      { merge: true },
    ),
  );
  await batch.commit();
  return snap.size;
}

/** Set/clear the `billed` override on every ledger doc for a task
 *  (updatePricingLogBilled dual-write). `null` clears it. */
export async function mirrorPricingBilled(
  taskId: string,
  billed: number | null,
): Promise<void> {
  await safe(`pricingBilled ${taskId}`, async () => {
    await writePricingBilled(taskId, billed);
  });
}

/** Phase 4 — AUTHORITATIVE billing-`note` write across every ledger doc
 *  for a task. Un-gated body of mirrorPricingNote. Returns the number of
 *  ledger docs updated (0 = task not in the ledger). An empty string
 *  clears the note. Pure annotation — never affects amounts. */
export async function writePricingNote(
  taskId: string,
  note: string,
): Promise<number> {
  const id = String(taskId ?? "").trim();
  if (!id) return 0;
  const db = getDb();
  const snap = await db
    .collection(FS_COLLECTIONS.pricingLog)
    .where("taskId", "==", id)
    .get();
  if (snap.empty) return 0;
  const clean = String(note ?? "").trim();
  const batch = db.batch();
  snap.docs.forEach((d) => batch.set(d.ref, { note: clean }, { merge: true }));
  await batch.commit();
  return snap.size;
}

/** Set/clear the billing `note` on every ledger doc for a task
 *  (updatePricingLogNote dual-write). "" clears it. */
export async function mirrorPricingNote(
  taskId: string,
  note: string,
): Promise<void> {
  await safe(`pricingNote ${taskId}`, async () => {
    await writePricingNote(taskId, note);
  });
}
