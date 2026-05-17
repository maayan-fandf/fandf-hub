/**
 * Client-safe, dependency-free derivation of "how long has this task
 * been in status בעבודה (in_progress)" from its status_history.
 *
 * The counter the user asked for "starts when you hit בעבודה and stops
 * when you switch the status" — but rather than a stateful start/stop
 * timer (fragile across missed stops / server restarts), we DERIVE it:
 * status_history already records every transition with a timestamp, so
 * the in-progress time is just the sum of every [enter in_progress →
 * next transition] interval, plus a live tail if it's in_progress now.
 *
 * This measures ELAPSED wall-clock time in the in_progress state, not
 * effort — a task left in_progress over the weekend accrues the whole
 * weekend. That's exactly why the value is editable: the manual
 * `inprogress_minutes` override on the task row supersedes this when
 * set (see WorkTask.inprogress_minutes / lib/tasksWriteDirect).
 *
 * No server imports — a minimal local input type keeps this usable
 * from a client component too (mirrors lib/pricingMatch's rationale).
 */

export const IN_PROGRESS_STATUS = "in_progress";

export type StatusHistoryLike = {
  /** ISO timestamp of the transition. */
  at: string;
  /** Status the task moved TO at `at`. */
  to: string;
  /** Status the task moved FROM (unused by the interval math — the
   *  next entry's `at` is the authoritative close — but kept so callers
   *  can pass status_history rows verbatim). */
  from?: string;
};

export type InProgressTime = {
  /** Total minutes spent in_progress (closed intervals + live tail),
   *  rounded. */
  minutes: number;
  /** True when the task is in_progress right now (last transition led
   *  to in_progress and it never left) — the value is still growing. */
  isRunning: boolean;
  /** ISO time the current open in_progress stretch began, when
   *  isRunning; "" otherwise. */
  runningSinceIso: string;
};

function ts(s: string): number {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/**
 * @param history       The task's status_history (any order; sorted here).
 * @param currentStatus The task's CURRENT status — gates the live tail
 *                       so a data gap (status changed without a history
 *                       row) can't make a stale interval run forever.
 * @param nowMs         Override for "now" (testing); defaults to Date.now().
 */
export function deriveInProgressTime(
  history: StatusHistoryLike[] | undefined | null,
  currentStatus: string,
  nowMs: number = Date.now(),
): InProgressTime {
  const entries = (history ?? [])
    .filter((e) => e && typeof e.at === "string" && !Number.isNaN(ts(e.at)))
    .slice()
    .sort((a, b) => ts(a.at) - ts(b.at));

  let totalMs = 0;
  let openAt: number | null = null;

  for (const e of entries) {
    const at = ts(e.at);
    if (e.to === IN_PROGRESS_STATUS) {
      // Entering (or re-affirming) in_progress — open an interval if
      // one isn't already open.
      if (openAt == null) openAt = at;
    } else if (openAt != null) {
      // Any transition away from in_progress closes the open interval.
      totalMs += Math.max(0, at - openAt);
      openAt = null;
    }
  }

  let isRunning = false;
  let runningSinceIso = "";
  if (openAt != null && currentStatus === IN_PROGRESS_STATUS) {
    isRunning = true;
    runningSinceIso = new Date(openAt).toISOString();
    totalMs += Math.max(0, nowMs - openAt);
  }

  return {
    minutes: Math.round(totalMs / 60000),
    isRunning,
    runningSinceIso,
  };
}
