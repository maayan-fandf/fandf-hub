import type { WorkTask } from "@/lib/appsScript";

/** Step used when a card is inserted at the very top or very bottom of
 *  a sorted list (no neighbor on one side to average against). 1000 is
 *  wide enough that float drift from repeated midpoint inserts won't
 *  run out of precision for any realistic team's lifetime. */
export const RANK_STEP = 1000;

/**
 * Compute the rank value for a card being inserted into the list
 * `items` (already sorted by rank ascending) just before the card with
 * id `insertBeforeId`. Pass `null` to append at the bottom.
 *
 * - Empty list → 0
 * - Top of list → first.rank - RANK_STEP
 * - Bottom of list → last.rank + RANK_STEP
 * - Between two cards → midpoint of their ranks
 *
 * Used by both the kanban (drop on column → bottom; drop on card → just
 * above that card) and the table (drag-to-reorder within a bucket).
 */
export function computeInsertRank(
  items: WorkTask[],
  insertBeforeId: string | null,
): number {
  if (items.length === 0) return 0;
  if (insertBeforeId === null) {
    const last = items[items.length - 1];
    return (last.rank ?? 0) + RANK_STEP;
  }
  const idx = items.findIndex((t) => t.id === insertBeforeId);
  if (idx === -1) {
    const last = items[items.length - 1];
    return (last.rank ?? 0) + RANK_STEP;
  }
  const after = items[idx];
  const before = idx > 0 ? items[idx - 1] : null;
  if (!before) return (after.rank ?? 0) - RANK_STEP;
  const a = before.rank ?? 0;
  const b = after.rank ?? 0;
  return (a + b) / 2;
}

/** Stable comparator used by both kanban and table to order tasks
 *  within a column / bucket: rank ascending (lower = top), tie-break
 *  by created_at descending so brand-new tasks float above older
 *  un-ranked rows with the same fallback rank. */
export function compareByRank(a: WorkTask, b: WorkTask): number {
  const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
  const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
  if (ra !== rb) return ra - rb;
  return b.created_at.localeCompare(a.created_at);
}
