"use client";

import { useState } from "react";

/**
 * Per-task time tracking — side-panel block on the task detail page.
 *
 * Just the status-derived counter: "time in status בעבודה", derived
 * from status_history (starts when the task enters in_progress, stops
 * when it leaves; see lib/inProgressTime). While in_progress it can be
 * ⏸ paused / ▶ resumed without changing status. Because it's elapsed
 * wall-clock — not effort — the value is EDITABLE any time (incl.
 * after the task is no longer in progress): saving a number writes the
 * `inprogress_minutes` override on the task row, which supersedes the
 * auto value until reset.
 */

function fmtDur(min: number): string {
  const m = Math.max(0, Math.round(min || 0));
  if (m < 60) return `${m} דק׳`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} שע׳ ${r} דק׳` : `${h} שע׳`;
}

export default function TaskTimeTracker({
  taskId,
  autoMinutes,
  isRunning,
  isPaused,
  overrideMinutes,
}: {
  taskId: string;
  /** Status-derived active in-progress minutes (computed server-side
   *  from status_history + pauses at page render). */
  autoMinutes: number;
  /** True when in_progress now and not paused (counter still growing;
   *  shown value is as of page load). */
  isRunning: boolean;
  /** True when in_progress now but paused. */
  isPaused: boolean;
  /** Manual override persisted on the task row, or null when unset
   *  (→ show the auto value). */
  overrideMinutes: number | null;
}) {
  const [override, setOverride] = useState<number | null>(overrideMinutes);
  const [auto, setAuto] = useState(autoMinutes);
  const [running, setRunning] = useState(isRunning);
  const [paused, setPaused] = useState(isPaused);
  const [editOpen, setEditOpen] = useState(false);
  const [editAmount, setEditAmount] = useState("");
  const [editUnit, setEditUnit] = useState<"min" | "hr">("min");
  const [savingOverride, setSavingOverride] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [err, setErr] = useState("");

  const effective = override != null ? override : auto;
  const inProgress = running || paused;
  const showPausePlay = override == null && inProgress;

  function openEdit() {
    setEditAmount(String(effective));
    setEditUnit("min");
    setErr("");
    setEditOpen(true);
  }

  async function saveOverride(e: React.FormEvent) {
    e.preventDefault();
    const raw = Number(editAmount.replace(",", "."));
    if (!Number.isFinite(raw) || raw < 0) {
      setErr("יש להזין מספר תקין");
      return;
    }
    const minutes = Math.round(editUnit === "hr" ? raw * 60 : raw);
    setSavingOverride(true);
    setErr("");
    try {
      const res = await fetch("/api/tasks/tracked-time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, minutes }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "save failed");
      setOverride(
        typeof data.inprogress_minutes === "number"
          ? data.inprogress_minutes
          : minutes,
      );
      setEditOpen(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setSavingOverride(false);
    }
  }

  async function resetOverride() {
    setSavingOverride(true);
    setErr("");
    try {
      const res = await fetch("/api/tasks/tracked-time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, reset: true }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "reset failed");
      setOverride(null);
      setEditOpen(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setSavingOverride(false);
    }
  }

  async function togglePause() {
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
      if (typeof data.minutes === "number") setAuto(data.minutes);
      setRunning(!!data.isRunning);
      setPaused(!!data.isPaused);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="time-tracker">
      <div className="time-tracker-total">
        <span className="time-tracker-total-num">{fmtDur(effective)}</span>
        <span className="time-tracker-total-label">
          זמן בסטטוס ״בעבודה״
          {override != null ? (
            <span
              className="time-tracker-tag"
              title={`אוטומטי: ${fmtDur(auto)} · ערך ידני גובר`}
            >
              נערך ידנית
            </span>
          ) : paused ? (
            <span className="time-tracker-tag is-paused" title="הספירה מושהית">
              ⏸ מושהה
            </span>
          ) : running ? (
            <span
              className="time-tracker-tag is-running"
              title="המשימה בסטטוס ׳בעבודה׳ — הספירה רצה (מתעדכן בריענון)"
            >
              ● בעבודה כעת
            </span>
          ) : null}
        </span>
      </div>

      {err && <div className="time-tracker-error">{err}</div>}

      <div className="time-tracker-actions">
        {showPausePlay && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={togglePause}
            disabled={toggling}
            title={
              paused
                ? "המשך ספירת הזמן"
                : "השהה את ספירת הזמן (בלי לשנות סטטוס)"
            }
          >
            {toggling ? "…" : paused ? "▶ המשך" : "⏸ השהה"}
          </button>
        )}
        {!editOpen && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={openEdit}
          >
            ✎ ערוך זמן
          </button>
        )}
      </div>

      {editOpen && (
        <form className="time-tracker-form" onSubmit={saveOverride}>
          <div className="time-tracker-row">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              placeholder="כמות"
              value={editAmount}
              onChange={(e) => setEditAmount(e.target.value)}
              className="time-tracker-amount"
              autoFocus
            />
            <select
              value={editUnit}
              onChange={(e) => setEditUnit(e.target.value as "min" | "hr")}
              className="time-tracker-unit"
            >
              <option value="min">דקות</option>
              <option value="hr">שעות</option>
            </select>
          </div>
          <div className="time-tracker-actions">
            <button
              type="submit"
              className="btn-primary btn-sm"
              disabled={savingOverride}
            >
              {savingOverride ? "שומר…" : "שמור"}
            </button>
            {override != null && (
              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={resetOverride}
                disabled={savingOverride}
                title="חזרה לערך האוטומטי לפי היסטוריית הסטטוסים"
              >
                איפוס לאוטומטי
              </button>
            )}
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setEditOpen(false);
                setErr("");
              }}
              disabled={savingOverride}
            >
              ביטול
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
