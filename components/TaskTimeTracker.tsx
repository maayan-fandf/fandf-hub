"use client";

import { useCallback, useEffect, useState } from "react";
import type { TimeLogRow } from "@/lib/timeLog";

/**
 * Optional per-task time tracking — the side-panel block on the task
 * detail page. Shows the total time logged + a short history and lets
 * any user who can see the task add an entry (minutes or hours + an
 * optional note). Append-only and informational; it does NOT affect
 * billing. Backed by /api/tasks/time → the self-provisioning TimeLog
 * tab (lib/timeLog.ts), pivoted month × company at /admin/time.
 */

function fmtDur(min: number): string {
  const m = Math.max(0, Math.round(min || 0));
  if (m < 60) return `${m} דק׳`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} שע׳ ${r} דק׳` : `${h} שע׳`;
}

export default function TaskTimeTracker({ taskId }: { taskId: string }) {
  const [entries, setEntries] = useState<TimeLogRow[]>([]);
  const [totalMinutes, setTotalMinutes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [open, setOpen] = useState(false);
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
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const raw = Number(amount.replace(",", "."));
    if (!Number.isFinite(raw) || raw <= 0) {
      setError("יש להזין זמן חיובי");
      return;
    }
    const minutes = Math.round(unit === "hr" ? raw * 60 : raw);
    if (minutes <= 0) {
      setError("יש להזין זמן חיובי");
      return;
    }
    setSubmitting(true);
    setError("");
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
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="time-tracker">
      <div className="time-tracker-total">
        <span className="time-tracker-total-num">
          {loading ? "…" : fmtDur(totalMinutes)}
        </span>
        <span className="time-tracker-total-label">סה״כ זמן שתועד</span>
      </div>

      {!loading && entries.length > 0 && (
        <ul className="time-tracker-list">
          {entries.slice(0, 6).map((en, i) => (
            <li key={`${en.loggedAt}-${i}`} className="time-tracker-entry">
              <span className="time-tracker-entry-dur">
                {fmtDur(en.minutes)}
              </span>
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

      {error && <div className="time-tracker-error">{error}</div>}

      {open ? (
        <form className="time-tracker-form" onSubmit={submit}>
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
            <button
              type="submit"
              className="btn-primary btn-sm"
              disabled={submitting}
            >
              {submitting ? "שומר…" : "שמור"}
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                setOpen(false);
                setError("");
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
          onClick={() => setOpen(true)}
        >
          + תעד זמן
        </button>
      )}
    </div>
  );
}
