"use client";

import { useState } from "react";
import { deriveInProgressTime } from "@/lib/inProgressTime";
import type { WorkTask } from "@/lib/appsScript";

/**
 * Icon-only pause/resume button for the /tasks queue row's actions
 * column. Sized to match the other tasks-row-icon entries (Drive
 * folder, edit, comments…). Renders nothing unless the task is
 * currently in_progress AND there's no manual minute override on the
 * row — same gate as the full TaskTimePauseQuick on the detail page.
 *
 * Wired to /api/tasks/time-pause exactly like the other pause
 * surfaces. Optimistic local state on click so the icon flips
 * immediately; if the API rejects, we roll back.
 *
 * No live counter here — the actions column is icon-sized, and
 * displaying minutes there would crowd the row. The detail page +
 * /team chip carry that information already.
 */
export default function TaskTimePauseIcon({
  task,
  onChanged,
}: {
  task: WorkTask;
  /** Optional callback the parent can use to refresh derived UI state
   *  (e.g. the live-time chip elsewhere on the page) once the pause
   *  state flips. Receives the new isRunning/isPaused booleans. */
  onChanged?: (next: { isRunning: boolean; isPaused: boolean }) => void;
}) {
  const ip = deriveInProgressTime(
    task.status_history || [],
    task.status,
    task.time_pauses || [],
  );

  const [paused, setPaused] = useState(ip.isPaused);
  const [running, setRunning] = useState(ip.isRunning);
  const [busy, setBusy] = useState(false);

  // Same gate as TaskTimePauseQuick: in_progress only, AND no
  // manual override (override takes the auto value out of the
  // equation, so pausing it is meaningless).
  if (task.status !== "in_progress") return null;
  if ((task.inprogress_minutes ?? null) !== null) return null;
  // Edge case: status is in_progress but the derived stretch is
  // neither running nor paused (data gap — happens occasionally when
  // status_history is incomplete). Render nothing to avoid a confused
  // icon state.
  if (!running && !paused) return null;

  async function toggle(e: React.MouseEvent) {
    // The actions row sometimes sits inside a clickable card wrapper.
    // Stop the click from bubbling so the row's primary action (open
    // task) doesn't fire alongside the pause.
    e.preventDefault();
    e.stopPropagation();

    const wasPaused = paused;
    const wasRunning = running;
    // Optimistic flip
    setBusy(true);
    setPaused(!wasPaused);
    setRunning(wasPaused); // resuming → running; pausing → not running
    try {
      const res = await fetch("/api/tasks/time-pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: task.id,
          action: wasPaused ? "resume" : "pause",
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "toggle failed");
      const nextRunning = !!data.isRunning;
      const nextPaused = !!data.isPaused;
      setRunning(nextRunning);
      setPaused(nextPaused);
      if (onChanged) onChanged({ isRunning: nextRunning, isPaused: nextPaused });
    } catch {
      // Roll back the optimistic flip; the parent can also display
      // a toast if it wires onChanged. Silent for now to keep the
      // queue row uncluttered.
      setPaused(wasPaused);
      setRunning(wasRunning);
    } finally {
      setBusy(false);
    }
  }

  const label = paused ? "▶" : "⏸";
  const title = paused
    ? "המשך לספור זמן על המשימה"
    : "השהה את ספירת הזמן (לא משנה סטטוס)";

  return (
    <button
      type="button"
      className={`tasks-row-icon tasks-row-icon-timer${paused ? " is-paused" : " is-running"}`}
      onClick={toggle}
      disabled={busy}
      title={title}
      aria-label={title}
    >
      {label}
    </button>
  );
}
