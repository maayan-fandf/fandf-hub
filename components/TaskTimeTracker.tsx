"use client";

import { useCallback, useEffect, useState } from "react";
import type { TimeLogRow } from "@/lib/timeLog";

/**
 * Per-task time tracking — side-panel block on the task detail page.
 *
 * Two parts:
 *  1. STATUS COUNTER (top) — "time in status בעבודה", derived live from
 *     status_history (starts when the task enters in_progress, stops
 *     when it leaves; see lib/inProgressTime). Because that's elapsed
 *     wall-clock — not effort — and inflates if a task is left in
 *     progress over a weekend, the value is EDITABLE: saving a number
 *     writes the `inprogress_minutes` override on the task row, which
 *     supersedes the auto value until reset.
 *  2. MANUAL LOG (bottom) — append-only per-person entries via the
 *     /api/tasks/time ledger (informational; does not drive billing).
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
  overrideMinutes,
}: {
  taskId: string;
  /** Status-derived in-progress minutes (computed server-side from
   *  status_history at page render). */
  autoMinutes: number;
  /** True when the task is in_progress right now (counter still grows;
   *  the shown value is as of page load). */
  isRunning: boolean;
  /** Manual override persisted on the task row, or null when unset
   *  (→ show the auto value). */
  overrideMinutes: number | null;
}) {
  /* ── Status counter (auto + editable override) ─────────────────── */
  const [override, setOverride] = useState<number | null>(overrideMinutes);
  const [editOpen, setEditOpen] = useState(false);
  const [editAmount, setEditAmount] = useState("");
  const [editUnit, setEditUnit] = useState<"min" | "hr">("min");
  const [savingOverride, setSavingOverride] = useState(false);
  const [counterErr, setCounterErr] = useState("");

  const effective = override != null ? override : autoMinutes;

  function openEdit() {
    // Prefill with the current effective value (in minutes).
    setEditAmount(String(effective));
    setEditUnit("min");
    setCounterErr("");
    setEditOpen(true);
  }

  async function saveOverride(e: React.FormEvent) {
    e.preventDefault();
    const raw = Number(editAmount.replace(",", "."));
    if (!Number.isFinite(raw) || raw < 0) {
      setCounterErr("יש להזין מספר תקין");
      return;
    }
    const minutes = Math.round(editUnit === "hr" ? raw * 60 : raw);
    setSavingOverride(true);
    setCounterErr("");
    try {
      const res = await fetch("/api/tasks/tracked-time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, minutes }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "save failed");
      setOverride(typeof data.inprogress_minutes === "number" ? data.inprogress_minutes : minutes);
      setEditOpen(false);
    } catch (err) {
      setCounterErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingOverride(false);
    }
  }

  async function resetOverride() {
    setSavingOverride(true);
    setCounterErr("");
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
    } catch (err) {
      setCounterErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingOverride(false);
    }
  }

  /* ── Manual per-person ledger ──────────────────────────────────── */
  const [entries, setEntries] = useState<TimeLogRow[]>([]);
  const [totalMinutes, setTotalMinutes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [logErr, setLogErr] = useState("");
  const [logOpen, setLogOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState<"min" | "hr">("min");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/tasks/time?taskId=${encodeURIComponent(taskId)}`,
        { cache: "no-store" },
      );
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "load failed");
      setEntries(data.entries ?? []);
      setTotalMinutes(data.totalMinutes ?? 0);
      setLogErr("");
    } catch (e) {
      setLogErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitLog(e: React.FormEvent) {
    e.preventDefault();
    const raw = Number(amount.replace(",", "."));
    if (!Number.isFinite(raw) || raw <= 0) {
      setLogErr("יש להזין זמן חיובי");
      return;
    }
    const minutes = Math.round(unit === "hr" ? raw * 60 : raw);
    if (minutes <= 0) {
      setLogErr("יש להזין זמן חיובי");
      return;
    }
    setSubmitting(true);
    setLogErr("");
    try {
      const res = await fetch("/api/tasks/time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, minutes, note: note.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "save failed");
      setEntries(data.entries ?? []);
      setTotalMinutes(data.totalMinutes ?? 0);
      setAmount("");
      setNote("");
      setLogOpen(false);
    } catch (err) {
      setLogErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="time-tracker">
      {/* ── Status counter ─────────────────────────────────────── */}
      <div className="time-tracker-total">
        <span className="time-tracker-total-num">{fmtDur(effective)}</span>
        <span className="time-tracker-total-label">
          זמן בסטטוס ״בעבודה״
          {override != null ? (
            <span className="time-tracker-tag" title={`אוטומטי: ${fmtDur(autoMinutes)}`}>
              נערך ידנית
            </span>
          ) : isRunning ? (
            <span
              className="time-tracker-tag is-running"
              title="המשימה בסטטוס ׳בעבודה׳ כעת — הערך מתעדכן בריענון"
            >
              ● בעבודה כעת
            </span>
          ) : null}
        </span>
      </div>

      {counterErr && <div className="time-tracker-error">{counterErr}</div>}

      {editOpen ? (
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
            <button type="submit" className="btn-primary btn-sm" disabled={savingOverride}>
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
                setCounterErr("");
              }}
              disabled={savingOverride}
            >
              ביטול
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="btn-ghost btn-sm time-tracker-add"
          onClick={openEdit}
        >
          ✎ ערוך זמן
        </button>
      )}

      <hr className="time-tracker-sep" />

      {/* ── Manual per-person log ──────────────────────────────── */}
      <div className="time-tracker-total">
        <span className="time-tracker-total-num">
          {loading ? "…" : fmtDur(totalMinutes)}
        </span>
        <span className="time-tracker-total-label">תיעוד ידני (לכל אדם)</span>
      </div>

      {!loading && entries.length > 0 && (
        <ul className="time-tracker-list">
          {entries.slice(0, 6).map((en, i) => (
            <li key={`${en.loggedAt}-${i}`} className="time-tracker-entry">
              <span className="time-tracker-entry-dur">{fmtDur(en.minutes)}</span>
              <span className="time-tracker-entry-meta">
                {en.loggedAt.slice(0, 10)} · {en.loggedBy.split("@")[0]}
                {en.note ? ` · ${en.note}` : ""}
              </span>
            </li>
          ))}
          {entries.length > 6 && (
            <li className="time-tracker-more">
              ועוד {entries.length - 6} רשומות…
            </li>
          )}
        </ul>
      )}

      {logErr && <div className="time-tracker-error">{logErr}</div>}

      {logOpen ? (
        <form className="time-tracker-form" onSubmit={submitLog}>
          <div className="time-tracker-row">
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              placeholder="כמות"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="time-tracker-amount"
              autoFocus
            />
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as "min" | "hr")}
              className="time-tracker-unit"
            >
              <option value="min">דקות</option>
              <option value="hr">שעות</option>
            </select>
          </div>
          <input
            type="text"
            placeholder="הערה (לא חובה)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="time-tracker-note"
            maxLength={500}
          />
          <div className="time-tracker-actions">
            <button type="submit" className="btn-primary btn-sm" disabled={submitting}>
              {submitting ? "שומר…" : "שמור"}
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setLogOpen(false);
                setLogErr("");
              }}
              disabled={submitting}
            >
              ביטול
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="btn-ghost btn-sm time-tracker-add"
          onClick={() => setLogOpen(true)}
        >
          + תעד זמן
        </button>
      )}
    </div>
  );
}
