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
 * Single-date picker. Same calendar-popover UX as DateRangePicker
 * but for a single date — drop-in replacement for native
 * <input type="date">. Supports both controlled (value/onChange) and
 * uncontrolled (name/defaultValue) modes so it slots into either an
 * external state owner (drawers, edit panels) or a plain <form>
 * GET-submit.
 *
 * Trigger button shows the picked date (yyyy-mm-dd) or a placeholder.
 * Click → opens calendar popover. Click any day → sets the date and
 * closes. ✕ chip clears. Outside click / Escape closes.
 */
export default function DatePicker(props: {
  /** Controlled value (yyyy-mm-dd). Pass undefined for uncontrolled. */
  value?: string;
  onChange?: (iso: string) => void;
  /** Uncontrolled mode: form input name. Renders a hidden input
   *  carrying the picked value into the surrounding form's submit. */
  name?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const {
    value: controlledValue,
    onChange,
    name,
    defaultValue,
    placeholder = "בחר תאריך",
    disabled,
    className,
    ariaLabel,
  } = props;
  const isControlled = controlledValue !== undefined;
  const [internalValue, setInternalValue] = useState<string>(defaultValue ?? "");
  const value = isControlled ? (controlledValue ?? "") : internalValue;

  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState<Date>(() => {
    const seed = parseIso(value) ?? new Date();
    return new Date(seed.getFullYear(), seed.getMonth(), 1);
  });
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Re-anchor month when value changes externally (e.g., parent reset).
  useEffect(() => {
    const seed = parseIso(value);
    if (seed) setViewMonth(new Date(seed.getFullYear(), seed.getMonth(), 1));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (popoverRef.current?.contains(tgt)) return;
      if (triggerRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const days = useMemo(() => buildMonthGrid(viewMonth), [viewMonth]);
  const todayIso = isoDate(new Date());

  function setValue(v: string) {
    if (isControlled) onChange?.(v);
    else { setInternalValue(v); onChange?.(v); }
  }
  function pick(iso: string) {
    setValue(iso);
    setOpen(false);
  }
  function clear() {
    setValue("");
  }
  function shiftMonth(delta: number) {
    setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  }
  function todayButton() {
    const t = isoDate(new Date());
    setValue(t);
    setViewMonth(new Date());
    setOpen(false);
  }

  return (
    <span className={`date-picker ${className ?? ""}`}>
      {!isControlled && name !== undefined && (
        <input type="hidden" name={name} value={value} />
      )}
      <button
        ref={triggerRef}
        type="button"
        className="date-range-trigger"
        data-active={value ? "1" : undefined}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="date-range-trigger-icon">📅</span>
        <span className="date-range-trigger-text">
          {value || <span className="date-picker-placeholder">{placeholder}</span>}
        </span>
        {value && !disabled && (
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
            <span className="date-range-month-label">{monthLabel(viewMonth)}</span>
            <button type="button" className="date-range-nav" onClick={() => shiftMonth(1)} aria-label="חודש הבא">›</button>
          </div>
          <div className="date-range-weekdays">
            {WEEKDAY_LABELS_HE.map((w) => (
              <span key={w} className="date-range-weekday">{w}</span>
            ))}
          </div>
          <div className="date-range-days">
            {days.map((d) => {
              const isSel = d.iso === value;
              const isToday = d.iso === todayIso;
              return (
                <button
                  key={d.iso}
                  type="button"
                  className="date-range-day"
                  data-other-month={d.otherMonth ? "1" : undefined}
                  data-start={isSel ? "1" : undefined}
                  data-today={isToday ? "1" : undefined}
                  onClick={() => pick(d.iso)}
                  aria-label={d.iso}
                  aria-pressed={isSel}
                >
                  {d.day}
                </button>
              );
            })}
          </div>
          <div className="date-range-footer">
            <span className="date-range-summary">{value || "בחר תאריך"}</span>
            <button type="button" className="date-range-clear" onClick={todayButton}>היום</button>
            <button type="button" className="date-range-done" onClick={() => setOpen(false)}>סגור</button>
          </div>
        </div>
      )}
    </span>
  );
}
