"use client";

import { useEffect, useState } from "react";

/**
 * Compact pause/resume button mounted inline with the action prompt
 * at the top of the task detail page. Companion to the side-panel
 * `TaskTimeTracker` — same backend (`/api/tasks/time-pause`), just a
 * second mount point so the most-frequent control (pause while you're
 * deep in the task body) is reachable without scrolling to the side
 * panel.
 *
 * Renders nothing unless:
 *   - the task is currently in_progress (running OR paused), AND
 *   - the time value isn't manually overridden (matches the existing
 *     side-panel `showPausePlay` rule — overrides take the auto value
 *     out of the equation entirely).
 *
 * Includes a live minute counter next to the button so the user gets
 * the same "time is moving" feedback the side panel offers, without
 * pulling their eye away from the action area. The counter is derived
 * from `runningSinceIso` (server-rendered) + a 30s client tick.
 */

function fmtShort(min: number): string {
  const m = Math.max(0, Math.floor(min));
  if (m < 60) return `${m} דק׳`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}:${String(r).padStart(2, "0")} שע׳` : `${h} שע׳`;
}

export default function TaskTimePauseQuick({
  taskId,
  isRunning,
  isPaused,
  autoMinutes,
  runningSinceIso,
}: {
  taskId: string;
  isRunning: boolean;
  isPaused: boolean;
  /** Status-derived total active minutes at SSR time. */
  autoMinutes: number;
  /** ISO time the current ACTIVE (un-paused) stretch began, used to
   *  derive the live counter without a re-fetch. Empty string when
   *  paused (no active stretch right now). */
  runningSinceIso: string;
}) {
  const [paused, setPaused] = useState(isPaused);
  const [running, setRunning] = useState(isRunning);
  const [toggling, setToggling] = useState(false);
  const [err, setErr] = useState("");
  const [liveMin, setLiveMin] = useState(autoMinutes);

  // Live minute ticker. Only meaningful when the timer is running —
  // pausing freezes the counter at whatever the server last told us
  // until the user resumes (which refreshes autoMinutes via the API
  // response). 30s cadence is the same as TeamActiveTaskChip.
  useEffect(() => {
    if (!running || !runningSinceIso) return;
    const startMs = Date.parse(runningSinceIso);
    if (!Number.isFinite(startMs)) return;
    // Capture the SSR baseline at mount: how many "active" minutes
    // the server counted UP TO runningSinceIso. The live count is
    // baseline + (now - runningSinceIso). We approximate baseline as
    // (autoMinutes - minutesSinceStretchStart-at-SSR). Since we don't
    // know SSR time exactly, just use (now - runningSinceIso) +
    // (autoMinutes - approx) — simplest correct path: the server-
    // computed autoMinutes IS as of SSR, so we add (now-pageLoad).
    // pageLoad we approximate as the time this effect first runs.
    const mountedAt = Date.now();
    const tick = () => {
      const drift = Math.floor((Date.now() - mountedAt) / 60000);
      setLiveMin(autoMinutes + drift);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [running, runningSinceIso, autoMinutes]);

  // Nothing in progress → button shouldn't be on the page at all.
  // The parent already gates on `isInProgress` server-side, but
  // belt-and-suspenders so a stale prop doesn't render junk.
  if (!running && !paused) return null;

  async function toggle() {
    const action = paused ? "resume" : "pause";
    setToggling(true);
    setErr("");
    try {
      const res = await fetch("/api/tasks/time-pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, action }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "toggle failed");
      setRunning(!!data.isRunning);
      setPaused(!!data.isPaused);
      if (typeof data.minutes === "number") setLiveMin(data.minutes);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
    }
  }

  const label = toggling ? "…" : paused ? "▶ המשך" : "⏸ השהה";
  const title = paused
    ? "המשך לספור זמן (לא משנה סטטוס)"
    : "השהה את ספירת הזמן (לא משנה סטטוס)";

  return (
    <span
      className={`task-time-quick${paused ? " is-paused" : " is-running"}`}
      title={err || title}
    >
      <button
        type="button"
        className="task-time-quick-btn"
        onClick={toggle}
        disabled={toggling}
        aria-label={title}
      >
        {label}
      </button>
      <span className="task-time-quick-counter" aria-live="off">
        {fmtShort(liveMin)}
      </span>
    </span>
  );
}
