"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { TimeLogRow } from "@/lib/timeLog";

function fmtDur(min: number): string {
  const m = Math.max(0, Math.round(min || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} דק׳`;
  return r ? `${h}:${String(r).padStart(2, "0")} שע׳` : `${h} שע׳`;
}

/**
 * Time-tracking report — the informational sibling of /admin/billing.
 *
 * Status rows show TWO times: "זמן בפועל" (raw wall-clock the task sat
 * in בעבודה — ignores pauses + edits) and "זמן" (the effective /
 * shown amount = manual override ?? pause-adjusted derived). The "זמן"
 * cell is inline-editable here (writes the `inprogress_minutes`
 * override via /api/tasks/tracked-time, exactly like the task page).
 * When the shown amount differs from "זמן בפועל" — because it was
 * hand-edited, or because the pause button trimmed it — the זמן cell
 * is color-flagged so it's obvious it no longer reflects reality.
 */
export default function TimeReport({ rows }: { rows: TimeLogRow[] }) {
  const months = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.month).filter(Boolean))).sort(
        (a, b) => b.localeCompare(a),
      ),
    [rows],
  );
  const [month, setMonth] = useState<string>(months[0] ?? "");
  const [company, setCompany] = useState<string>("__all__");
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [onlyReview, setOnlyReview] = useState(false);
  const [pausedIds, setPausedIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string>("");
  const [actionErr, setActionErr] = useState("");
  // Per-session manual edits: taskId → override minutes, or null = the
  // override was cleared (revert to the derived value). Absent key =
  // use the server value.
  const [edited, setEdited] = useState<Record<string, number | null>>({});
  const [editing, setEditing] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [savingId, setSavingId] = useState<string>("");

  // Override currently in effect for a status row (local edit wins;
  // else the server override — which equals r.minutes when overridden).
  const overrideOf = (r: TimeLogRow): number | null => {
    if (Object.prototype.hasOwnProperty.call(edited, r.taskId))
      return edited[r.taskId];
    return r.overridden ? r.minutes ?? 0 : null;
  };
  // Effective (shown / billed-equivalent) minutes for a row.
  const effOf = (r: TimeLogRow): number => {
    if (!r.isStatus) return r.minutes || 0;
    const ov = overrideOf(r);
    if (ov != null) return ov;
    return r.autoMinutes ?? r.minutes ?? 0;
  };
  // Shown amount no longer equals the raw בעבודה wall-clock — either
  // hand-edited to a different number, or trimmed by a pause.
  const mismatchOf = (r: TimeLogRow): boolean =>
    !!r.isStatus && effOf(r) !== (r.rawMinutes ?? 0);
  const mismatchReason = (r: TimeLogRow): string => {
    const ov = overrideOf(r);
    if (ov != null) return "נערך ידנית — לא תואם את הזמן בפועל בסטטוס בעבודה";
    return "הזמן צומצם בעקבות השהיה — לא תואם את הזמן בפועל";
  };

  const monthRows = useMemo(
    () => rows.filter((r) => (month ? r.month === month : true)),
    [rows, month],
  );
  const companies = useMemo(
    () =>
      Array.from(
        new Set(monthRows.map((r) => r.company).filter(Boolean)),
      ).sort((a, b) => a.localeCompare(b, "he")),
    [monthRows],
  );
  const byCompany = useMemo(
    () =>
      monthRows.filter((r) =>
        company === "__all__" ? true : r.company === company,
      ),
    [monthRows, company],
  );
  const runningCount = useMemo(
    () =>
      byCompany.filter((r) => !!r.running && !pausedIds.has(r.taskId)).length,
    [byCompany, pausedIds],
  );
  const reviewCount = useMemo(
    () => byCompany.filter((r) => !!r.needsReview).length,
    [byCompany],
  );
  const filtered = useMemo(() => {
    let out = byCompany;
    if (onlyRunning)
      out = out.filter((r) => !!r.running && !pausedIds.has(r.taskId));
    if (onlyReview) out = out.filter((r) => !!r.needsReview);
    return out;
  }, [byCompany, onlyRunning, onlyReview, pausedIds]);

  async function pauseTask(taskId: string) {
    setBusyId(taskId);
    setActionErr("");
    try {
      const res = await fetch("/api/tasks/time-pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, action: "pause" }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "pause failed");
      setPausedIds((prev) => {
        const n = new Set(prev);
        n.add(taskId);
        return n;
      });
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId("");
    }
  }

  async function saveTime(taskId: string, reset: boolean) {
    setSavingId(taskId);
    setActionErr("");
    try {
      let body: Record<string, unknown>;
      if (reset) {
        body = { taskId, reset: true };
      } else {
        const n = Number(draft.replace(",", "."));
        if (!Number.isFinite(n) || n < 0) {
          setActionErr("יש להזין מספר דקות תקין");
          setSavingId("");
          return;
        }
        body = { taskId, minutes: Math.round(n) };
      }
      const res = await fetch("/api/tasks/tracked-time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "save failed");
      setEdited((prev) => ({
        ...prev,
        [taskId]: reset
          ? null
          : typeof data.inprogress_minutes === "number"
            ? data.inprogress_minutes
            : Math.round(Number(draft.replace(",", "."))),
      }));
      setEditing("");
      setDraft("");
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId("");
    }
  }

  const groups = useMemo(() => {
    const m = new Map<string, TimeLogRow[]>();
    for (const r of filtered) {
      const k = r.company || "(ללא חברה)";
      let arr = m.get(k);
      if (!arr) {
        arr = [];
        m.set(k, arr);
      }
      arr.push(r);
    }
    return Array.from(m.entries())
      .map(([co, rs]) => ({
        company: co,
        rows: rs.slice().sort((a, b) => a.loggedAt.localeCompare(b.loggedAt)),
        subtotal: rs.reduce((s, r) => s + effOf(r), 0),
      }))
      .sort((a, b) => a.company.localeCompare(b.company, "he"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, edited]);

  const grandTotal = filtered.reduce((s, r) => s + effOf(r), 0);

  function exportCsv() {
    const head = [
      "month",
      "logged_at",
      "company",
      "project",
      "task",
      "brief",
      "worker",
      "departments",
      "kind",
      "actual_minutes",
      "minutes",
      "hours",
      "differs_from_actual",
      "note",
      "needs_review",
      "task_id",
      "logged_by",
    ];
    const esc = (v: string) =>
      /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [head.join(",")];
    for (const g of groups) {
      for (const r of g.rows) {
        const eff = effOf(r);
        lines.push(
          [
            r.month,
            r.loggedAt,
            r.company,
            r.project,
            r.title ?? "",
            r.brief ?? "",
            r.worker ?? "",
            r.departments,
            r.kind,
            r.isStatus ? String(r.rawMinutes ?? 0) : "",
            String(eff),
            (eff / 60).toFixed(2),
            mismatchOf(r) ? "1" : "",
            r.note,
            r.needsReview ? "1" : "",
            r.taskId,
            r.loggedBy,
          ]
            .map((x) => esc(String(x ?? "")))
            .join(","),
        );
      }
    }
    const blob = new Blob(["﻿" + lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `time_${month || "all"}_${
      company === "__all__" ? "all" : company
    }.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (rows.length === 0) {
    return (
      <div className="billing-empty">
        אין עדיין תיעוד זמן. הדוח מתמלא אוטומטית מהזמן שמשימות נמצאות
        בסטטוס ״בעבודה״. הזמן הוא מידע בלבד — אינו משפיע על החיוב ללקוח.
      </div>
    );
  }

  return (
    <div className="billing-report">
      <div className="billing-controls">
        <label>
          חודש
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          חברה
          <select
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          >
            <option value="__all__">כל החברות</option>
            {companies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={exportCsv}
          disabled={filtered.length === 0}
        >
          ⬇ ייצוא CSV
        </button>
        <button
          type="button"
          className={`time-running-chip${runningCount ? " is-on" : ""}${
            onlyRunning ? " is-active" : ""
          }`}
          onClick={() => setOnlyRunning((v) => !v)}
          title={
            runningCount
              ? "הצג רק משימות שרצות כעת — לחיצה חוזרת מבטלת"
              : "אין כרגע משימות שרצות"
          }
          disabled={!runningCount && !onlyRunning}
        >
          ● רצות כעת: {runningCount}
        </button>
        <button
          type="button"
          className={`time-review-chip${reviewCount ? " is-on" : ""}${
            onlyReview ? " is-active" : ""
          }`}
          onClick={() => setOnlyReview((v) => !v)}
          title={
            reviewCount
              ? "זמן חריג (מעל 24 שע׳ בסטטוס ׳בעבודה׳, לא תוקן) — כנראה נשאר פתוח ללא עבודה. הצג רק אותן"
              : "אין רשומות עם זמן חריג"
          }
          disabled={!reviewCount && !onlyReview}
        >
          ⚠ לבדיקה: {reviewCount}
        </button>
        <span className="billing-grand">
          סה״כ זמן {month}: <b>{fmtDur(grandTotal)}</b>
        </span>
      </div>
      {actionErr && (
        <div className="time-tracker-error" role="alert">
          {actionErr}
        </div>
      )}

      {groups.length === 0 ? (
        <div className="billing-empty">אין תיעוד בחודש/חברה שנבחרו.</div>
      ) : (
        groups.map((g) => (
          <div key={g.company} className="billing-group">
            <div className="billing-group-head">
              <span className="billing-company">{g.company}</span>
              <span className="billing-subtotal">{fmtDur(g.subtotal)}</span>
            </div>
            <div className="billing-table" role="table">
              <div className="billing-row time-row billing-row-head" role="row">
                <span>תאריך</span>
                <span>משימה</span>
                <span>בריף</span>
                <span>פרוייקט</span>
                <span>מחלקה</span>
                <span>עובד</span>
                <span>הערה</span>
                <span title="זמן wall-clock בפועל בסטטוס בעבודה (לא כולל השהיות/עריכות)">
                  זמן בפועל
                </span>
                <span>זמן</span>
                <span>תועד ע״י</span>
              </div>
              {g.rows.map((r, i) => {
                const locallyPaused = pausedIds.has(r.taskId);
                const isRun = !!r.running && !locallyPaused;
                const isPaused = locallyPaused || !!r.paused;
                const eff = effOf(r);
                const mism = mismatchOf(r);
                const isEditing = editing === r.taskId;
                const hasOverride = overrideOf(r) != null;
                return (
                  <div
                    className="billing-row time-row"
                    role="row"
                    key={`${r.taskId}-${r.loggedAt}-${i}`}
                  >
                    <span title={r.loggedAt}>{r.loggedAt.slice(0, 10)}</span>
                    <span
                      className="time-task-cell"
                      title={r.title || r.taskId}
                    >
                      {r.needsReview && (
                        <span
                          className="time-review-flag"
                          title="זמן חריג — בדוק/תקן (כנראה נשאר ׳בעבודה׳ ללא עבודה בפועל)"
                          aria-label="לבדיקה"
                        >
                          ⚠
                        </span>
                      )}
                      {isRun ? (
                        <span
                          className="time-run-dot"
                          title="רצה כעת"
                          aria-label="רצה כעת"
                        />
                      ) : isPaused ? (
                        <span
                          className="time-run-dot is-paused"
                          title="מושהה"
                          aria-label="מושהה"
                        />
                      ) : null}
                      {r.taskId ? (
                        <Link
                          href={`/tasks/${encodeURIComponent(r.taskId)}`}
                          className="time-task-link"
                        >
                          {r.title || r.taskId}
                        </Link>
                      ) : (
                        <span className="time-task-link">
                          {r.title || "—"}
                        </span>
                      )}
                      {isRun && (
                        <button
                          type="button"
                          className="btn-ghost btn-sm time-pause-btn"
                          disabled={busyId === r.taskId}
                          onClick={() => pauseTask(r.taskId)}
                          title="השהה את ספירת הזמן (בלי לשנות סטטוס)"
                        >
                          {busyId === r.taskId ? "…" : "⏸"}
                        </button>
                      )}
                    </span>
                    <span title={r.brief || ""}>{r.brief || "—"}</span>
                    <span>{r.project || "—"}</span>
                    <span>{r.departments || "—"}</span>
                    <span title={r.worker || ""}>{r.worker || "—"}</span>
                    <span title={r.note}>{r.note || "—"}</span>
                    <span
                      className="time-actual"
                      title={
                        r.isStatus
                          ? "כמה זמן המשימה הייתה בפועל בסטטוס בעבודה"
                          : ""
                      }
                    >
                      {r.isStatus ? fmtDur(r.rawMinutes ?? 0) : "—"}
                    </span>
                    {!r.isStatus ? (
                      <span className="billing-price">{fmtDur(eff)}</span>
                    ) : isEditing ? (
                      <span className="bill-edit">
                        <input
                          type="number"
                          inputMode="numeric"
                          min="0"
                          step="1"
                          className="bill-edit-input"
                          value={draft}
                          autoFocus
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter")
                              void saveTime(r.taskId, false);
                            if (e.key === "Escape") {
                              setEditing("");
                              setDraft("");
                            }
                          }}
                        />
                        <span className="bill-unit">דק׳</span>
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          disabled={savingId === r.taskId}
                          onClick={() => void saveTime(r.taskId, false)}
                        >
                          {savingId === r.taskId ? "…" : "שמור"}
                        </button>
                        {hasOverride && (
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            disabled={savingId === r.taskId}
                            title="חזרה לערך האוטומטי לפי היסטוריית הסטטוסים"
                            onClick={() => void saveTime(r.taskId, true)}
                          >
                            איפוס
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          disabled={savingId === r.taskId}
                          onClick={() => {
                            setEditing("");
                            setDraft("");
                            setActionErr("");
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={
                          "bill-cell" + (mism ? " tl-mismatch" : "")
                        }
                        title={
                          mism
                            ? `${mismatchReason(r)} (בפועל ${fmtDur(r.rawMinutes ?? 0)}). לחיצה לעריכה`
                            : "לחיצה לעריכת הזמן (גובר על הערך האוטומטי)"
                        }
                        onClick={() => {
                          setEditing(r.taskId);
                          setDraft(String(Math.round(eff)));
                          setActionErr("");
                        }}
                      >
                        <span className="bill-amount">{fmtDur(eff)}</span>
                        <span className="bill-pencil" aria-hidden>
                          ✎
                        </span>
                      </button>
                    )}
                    <span className="billing-by">
                      {r.loggedBy.split("@")[0]}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
