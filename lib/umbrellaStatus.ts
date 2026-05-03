/**
 * Umbrella status derivation — given an umbrella container task's
 * children (rows whose `umbrella_id` points back at the umbrella),
 * compute the umbrella's status as a pure function of child states.
 *
 * Per the locked design (memory/project_dependencies_chains_pending.md):
 *
 *   All `done`                              → done
 *   All `cancelled`                         → cancelled
 *   Any non-terminal                        → in_progress
 *   All blocked or not-started              → awaiting_handling
 *   Mix incl. some cancelled, rest done     → done
 *
 * "Non-terminal" = any of in_progress / awaiting_clarification /
 *  awaiting_approval / awaiting_handling / draft. Note that `blocked`
 *  alone is technically pre-work but counts as "alive" for derivation
 *  — an umbrella with all-blocked children is `awaiting_handling`
 *  (waiting to start), not `in_progress` (work happening).
 *
 * Phase 4 of dependencies feature, 2026-05-03. Pure helper — no
 * Sheets I/O. Wire-in lives in lib/tasksWriteDirect.ts (child status
 * change → recompute umbrella → persist if changed).
 */

import type { WorkTaskStatus } from "@/lib/appsScript";

/**
 * Compute the derived umbrella status from its children's statuses.
 *
 * @param childStatuses Statuses of every child (rows whose umbrella_id
 *   points back at this umbrella). Empty array → `awaiting_handling`
 *   (an umbrella with no children is "waiting to be populated", not
 *   "done").
 */
export function deriveUmbrellaStatus(
  childStatuses: ReadonlyArray<WorkTaskStatus>,
): WorkTaskStatus {
  if (childStatuses.length === 0) return "awaiting_handling";

  let allDone = true;
  let allCancelled = true;
  let anyDoneOrCancelled = false;
  let anyActive = false; // in_progress, awaiting_clarification, awaiting_approval

  for (const s of childStatuses) {
    if (s !== "done") allDone = false;
    if (s !== "cancelled") allCancelled = false;
    if (s === "done" || s === "cancelled") anyDoneOrCancelled = true;
    if (
      s === "in_progress" ||
      s === "awaiting_clarification" ||
      s === "awaiting_approval"
    ) {
      anyActive = true;
    }
  }

  if (allDone) return "done";
  if (allCancelled) return "cancelled";
  // Mixed with no actively-worked children — could be all-cancelled-or-done
  // (terminal mix) which we treat as `done` per the spec, OR could be a
  // mix of done/cancelled + blocked/awaiting_handling/draft (some work
  // remains but it hasn't started yet).
  if (anyActive) return "in_progress";
  // No active children. If everything left is terminal-or-empty, the
  // umbrella IS effectively done (the cancelled steps don't block
  // the deliverable's completion). Otherwise something's still pending
  // start (blocked / awaiting_handling / draft) → awaiting_handling.
  let anyPending = false;
  for (const s of childStatuses) {
    if (
      s === "blocked" ||
      s === "awaiting_handling" ||
      s === "draft"
    ) {
      anyPending = true;
      break;
    }
  }
  if (anyPending) return "awaiting_handling";
  // Reached only when every child is `done` or `cancelled` (no active,
  // no pending). The all-done case was handled above; this is the
  // "mix incl. some cancelled, rest done" branch from the spec.
  if (anyDoneOrCancelled) return "done";
  // Defensive fallback — shouldn't be reachable, but `awaiting_handling`
  // is the safest "still alive" status if children are all in some
  // unexpected state.
  return "awaiting_handling";
}

/**
 * Compute aggregate progress display strings for an umbrella's child
 * list. Used by the umbrella detail page header + the list-view chip
 * when umbrellas are surfaced via the toggle.
 *
 * Returns: `{ done, total, displayHe }` where `displayHe` is the
 * Hebrew badge text like "2 / 4 ✓".
 */
export function deriveUmbrellaProgress(
  childStatuses: ReadonlyArray<WorkTaskStatus>,
): { done: number; cancelled: number; total: number; displayHe: string } {
  let done = 0;
  let cancelled = 0;
  for (const s of childStatuses) {
    if (s === "done") done++;
    else if (s === "cancelled") cancelled++;
  }
  const total = childStatuses.length;
  // Cancelled steps are still "accounted for" but render with a strike
  // visual on the detail page. The badge text just shows done/total
  // since that's what people care about at a glance.
  const displayHe = total === 0 ? "אין שלבים" : `${done} / ${total} ✓`;
  return { done, cancelled, total, displayHe };
}
