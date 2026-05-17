/**
 * Client-safe, dependency-free derivation of "how long has this task
 * been actively in status בעבודה (in_progress)" from its status_history
 * + pause/resume events.
 *
 * The counter "starts when you hit בעבודה and stops when you change the
 * status" — derived, not a stateful timer: status_history records every
 * transition with a timestamp, so the in-progress time is the sum of
 * every [enter in_progress → next transition] interval, plus a live
 * tail if it's in_progress now.
 *
 * On top of that the user can ⏸ pause / ▶ resume WITHOUT changing
 * status (a break, lunch, context-switch). Those events live in a
 * separate stream (WorkTask.time_pauses); paused stretches are
 * subtracted. Pauses are replayed PER in_progress interval, each
 * starting un-paused, so a pause can never bleed across status
 * sessions (leave בעבודה and a dangling pause is closed at that
 * boundary; re-entering בעבודה starts fresh).
 *
 * Even with pauses this is still ELAPSED wall-clock, not guaranteed
 * effort, so the manual `inprogress_minutes` override on the task row
 * supersedes this entirely when set (see WorkTask.inprogress_minutes).
 *
 * No server imports — minimal local input types keep this usable from
 * a client component too (mirrors lib/pricingMatch's rationale).
 */

export const IN_PROGRESS_STATUS = "in_progress";

export type StatusHistoryLike = {
  /** ISO timestamp of the transition. */
  at: string;
  /** Status the task moved TO at `at`. */
  to: string;
  from?: string;
};

export type PauseEventLike = {
  /** ISO timestamp of the pause/resume. */
  at: string;
  action: "pause" | "resume";
};

export type InProgressTime = {
  /** Total ACTIVE minutes in_progress (closed intervals + live tail,
   *  minus paused stretches), rounded. */
  minutes: number;
  /** True when in_progress right now AND not paused — the value is
   *  still growing. */
  isRunning: boolean;
  /** True when in_progress right now but currently paused. */
  isPaused: boolean;
  /** ISO time the current ACTIVE (running, un-paused) stretch began,
   *  when isRunning; "" otherwise. */
  runningSinceIso: string;
};

function ts(s: string): number {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : NaN;
}

type Interval = { start: number; end: number; isCurrent: boolean };

export function deriveInProgressTime(
  history: StatusHistoryLike[] | undefined | null,
  currentStatus: string,
  pauses?: PauseEventLike[] | undefined | null,
  nowMs: number = Date.now(),
): InProgressTime {
  const entries = (history ?? [])
    .filter((e) => e && typeof e.at === "string" && !Number.isNaN(ts(e.at)))
    .slice()
    .sort((a, b) => ts(a.at) - ts(b.at));

  // 1. Build the in_progress intervals from status_history.
  const intervals: Interval[] = [];
  let openAt: number | null = null;
  for (const e of entries) {
    const at = ts(e.at);
    if (e.to === IN_PROGRESS_STATUS) {
      if (openAt == null) openAt = at;
    } else if (openAt != null) {
      intervals.push({ start: openAt, end: at, isCurrent: false });
      openAt = null;
    }
  }
  if (openAt != null && currentStatus === IN_PROGRESS_STATUS) {
    intervals.push({ start: openAt, end: nowMs, isCurrent: true });
  }
  // (If openAt != null but not currently in_progress, it's a data gap —
  //  a status change with no history row — so we don't extend it.)

  const pauseEvents = (pauses ?? [])
    .filter((p) => p && typeof p.at === "string" && !Number.isNaN(ts(p.at)))
    .slice()
    .sort((a, b) => ts(a.at) - ts(b.at));

  // 2. For each interval, replay pauses scoped to that interval (each
  //    starts un-paused → no bleed across status sessions).
  let totalMs = 0;
  let isPaused = false;
  let runningSinceMs = 0;
  for (const iv of intervals) {
    const len = Math.max(0, iv.end - iv.start);
    let pausedMs = 0;
    let pState: "run" | "pause" = "run";
    let pStart = 0;
    let activeSince = iv.start;
    for (const pe of pauseEvents) {
      const at = ts(pe.at);
      if (at < iv.start || at > iv.end) continue;
      if (pe.action === "pause" && pState === "run") {
        pState = "pause";
        pStart = at;
      } else if (pe.action === "resume" && pState === "pause") {
        pausedMs += Math.max(0, at - pStart);
        pState = "run";
        activeSince = at;
      }
    }
    if (pState === "pause") {
      pausedMs += Math.max(0, iv.end - pStart);
    }
    totalMs += Math.max(0, len - pausedMs);
    if (iv.isCurrent) {
      isPaused = pState === "pause";
      runningSinceMs = activeSince;
    }
  }

  const hasCurrent = intervals.some((iv) => iv.isCurrent);
  const isRunning = hasCurrent && !isPaused;

  return {
    minutes: Math.round(totalMs / 60000),
    isRunning,
    isPaused: hasCurrent && isPaused,
    runningSinceIso: isRunning ? new Date(runningSinceMs).toISOString() : "",
  };
}
