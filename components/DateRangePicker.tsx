"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildMonthGrid,
  isoDate,
  parseIso,
  monthLabel,
  WEEKDAY_LABELS_HE,
} from "@/lib/calendarGrid";

/**
 * Single-popover date-range picker. Replaces the two adjacent
 * <input type="date"> pickers on /tasks's filter bar — same hidden-
 * input names so the form's GET-submit URL shape doesn't change,
 * but the visible UX is a single calendar where you click the start
 * date then click the end date (Facebook-Ads style). Hover shows a
 * preview of the in-progress range.
 *
 * Behavior:
 *   - Trigger button shows the current "<from> — <to>" labels (or
 *     "כל התאריכים" when both are empty), clicking opens the popover.
 *   - First click in popover sets `start`, clears `end`.
 *   - Second click in popover sets `end` (auto-swap if before start).
 *   - "ניקוי" clears both. Outside click closes the popover.
 *   - The two hidden inputs (names from + to) update on every state
 *     change — the form's apply button picks up the latest values
 *     when the user submits.
 */
export default function DateRangePicker({
  fromName,
  toName,
  initialFrom,
  initialTo,
  label,
}: {
  fromName: string;
  toName: string;
  initialFrom: string;
  initialTo: string;
  /** Visible label above the trigger (e.g. "תאריך מבוקש"). */
  label: string;
}) {
  const [from, setFrom] = useState<string>(initialFrom);
  const [to, setTo] = useState<string>(initialTo);
  const [open, setOpen] = useState(false);
  // Calendar's currently-shown month (anchor at the 1st). Defaults to
  // the chosen `from` month, else today.
  const [viewMonth, setViewMonth] = useState<Date>(() => {
    const seed = parseIso(from) ?? parseIso(to) ?? new Date();
    return new Date(seed.getFullYear(), seed.getMonth(), 1);
  });
  // Hover preview while picking end. Null when nothing hovered.
  const [hoverDay, setHoverDay] = useState<string>("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (popoverRef.current?.contains(tgt)) return;
      if (triggerRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const days = useMemo(() => buildMonthGrid(viewMonth), [viewMonth]);
  const todayIso = isoDate(new Date());

  function pick(iso: string) {
    if (!from || (from && to)) {
      // Start a fresh range.
      setFrom(iso);
      setTo("");
      return;
    }
    // We have `from` but no `to` — set the end. Auto-swap if user
    // clicked an earlier date than start.
    if (iso < from) {
      setTo(from);
      setFrom(iso);
    } else {
      setTo(iso);
    }
  }

  function clear() {
    setFrom("");
    setTo("");
    setHoverDay("");
  }

  function shiftMonth(delta: number) {
    setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  }

  // Effective range for the highlight: [from, to] when both set,
  // [from, hover] while picking end (to give the live preview the
  // user sees when they hover).
  const rangeStart = from || "";
  const rangeEnd = to || (from && hoverDay && hoverDay > from ? hoverDay : "");

  const triggerLabel = !from && !to
    ? "כל התאריכים"
    : `${from || "—"}  עד  ${to || "—"}`;

  return (
    <label className="filter-date-range">
      {label}
      {/* Hidden inputs carry the values into the surrounding form's GET
          submit. Name attributes match the URL params the server reads. */}
      <input type="hidden" name={fromName} value={from} />
      <input type="hidden" name={toName} value={to} />
      <button
        ref={triggerRef}
        type="button"
        className="date-range-trigger"
        data-active={from || to ? "1" : undefined}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="date-range-trigger-icon">📅</span>
        <span className="date-range-trigger-text">{triggerLabel}</span>
        {(from || to) && (
          <span
            className="date-range-trigger-clear"
            role="button"
            tabIndex={0}
            aria-label="נקה"
            onClick={(e) => { e.stopPropagation(); clear(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); clear(); }
            }}
          >
            ✕
          </span>
        )}
      </button>
      {open && (
        <div className="date-range-popover" ref={popoverRef} role="dialog">
          <div className="date-range-month-head">
            <button type="button" className="date-range-nav" onClick={() => shiftMonth(-1)} aria-label="חודש קודם">‹</button>
            <span className="date-range-month-label">
              {monthLabel(viewMonth)}
            </span>
            <button type="button" className="date-range-nav" onClick={() => shiftMonth(1)} aria-label="חודש הבא">›</button>
          </div>
          <div className="date-range-weekdays">
            {WEEKDAY_LABELS_HE.map((w) => (
              <span key={w} className="date-range-weekday">{w}</span>
            ))}
          </div>
          <div className="date-range-days">
            {days.map((d) => {
              const inRange =
                rangeStart && rangeEnd && d.iso >= rangeStart && d.iso <= rangeEnd;
              const isStart = d.iso === rangeStart;
              const isEnd = d.iso === rangeEnd;
              const isToday = d.iso === todayIso;
              return (
                <button
                  key={d.iso}
                  type="button"
                  className="date-range-day"
                  data-other-month={d.otherMonth ? "1" : undefined}
                  data-in-range={inRange ? "1" : undefined}
                  data-start={isStart ? "1" : undefined}
                  data-end={isEnd ? "1" : undefined}
                  data-today={isToday ? "1" : undefined}
                  onClick={() => pick(d.iso)}
                  onMouseEnter={() => setHoverDay(d.iso)}
                  onMouseLeave={() => setHoverDay("")}
                  aria-label={d.iso}
                >
                  {d.day}
                </button>
              );
            })}
          </div>
          <div className="date-range-footer">
            <span className="date-range-summary">
              {from || to ? `${from || "…"} → ${to || "…"}` : "בחר תאריך התחלה"}
            </span>
            <button type="button" className="date-range-clear" onClick={clear}>
              ניקוי
            </button>
            <button type="button" className="date-range-done" onClick={() => setOpen(false)}>
              סגור
            </button>
          </div>
        </div>
      )}
    </label>
  );
}

