"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Material 3 input-mode time picker. Replaces `<input type="time">`
 * on the task forms with two large HH / MM cells in the Material 3
 * style — outlined boxes, accent-tinted focus state, generous touch
 * target. Israel uses 24-hour time so we skip the AM/PM toggle from
 * the M3 spec.
 *
 * The component supports BOTH the controlled pattern (`value` +
 * `onChange`) used by TaskEditPanel + TaskInlineEditors AND the
 * uncontrolled-with-form-name pattern (`name` + `defaultValue`) used
 * by TaskCreateForm — the latter renders an `<input type="hidden"
 * name=...>` mirror so native form submission picks up the value
 * exactly the same way the previous `<input type="time">` did.
 *
 * Behaviour:
 *   - Two `<input type="text" inputMode="numeric">` cells (`text`,
 *     not `number`, to skip browser spinners + give mobile users a
 *     numeric keyboard via `inputMode`)
 *   - Type-2-and-advance: typing a 2-digit hour auto-focuses the
 *     minute cell + selects its content for fast keyboard entry
 *   - Clamp on blur (hour to 0-23, minute to 0-59) + zero-pad
 *   - Empty cells are valid and emit "" — preserves the
 *     "no time set" state the surrounding date+time forms rely on
 *   - `name` prop emits a hidden mirror so HTML form submit picks
 *     up the combined "HH:MM" value
 *
 * Reported by Maayan 2026-05-06.
 */
type Props = {
  /** Controlled value — "HH:MM" 24-hour string, or "" for empty. */
  value?: string;
  /** Uncontrolled initial value. Used when `value` is omitted. */
  defaultValue?: string;
  onChange?: (next: string) => void;
  /** When supplied, emits a hidden `<input>` so the value rides
   *  through native HTML form submit under that name. */
  name?: string;
  ariaLabel?: string;
  disabled?: boolean;
};

function parseHHMM(s: string): { h: string; m: string } {
  const t = String(s || "").trim();
  if (!t) return { h: "", m: "" };
  const m = t.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return { h: "", m: "" };
  const hh = m[1].padStart(2, "0").slice(0, 2);
  const mm = m[2].padStart(2, "0").slice(0, 2);
  return { h: hh, m: mm };
}

function combine(h: string, m: string): string {
  if (!h && !m) return "";
  if (!h) return "";
  // Minute defaults to "00" when only the hour was filled — matches
  // the legacy native input's behaviour (hour-only typed value
  // committed as HH:00 by most browsers).
  const hh = h.padStart(2, "0").slice(0, 2);
  const mm = (m || "00").padStart(2, "0").slice(0, 2);
  return `${hh}:${mm}`;
}

function clampInt(s: string, max: number): string {
  if (!s) return "";
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return "";
  const clamped = Math.max(0, Math.min(max, n));
  return String(clamped).padStart(2, "0");
}

export default function TimePicker({
  value,
  defaultValue,
  onChange,
  name,
  ariaLabel,
  disabled,
}: Props) {
  const isControlled = value !== undefined;
  const seed = parseHHMM(isControlled ? value || "" : defaultValue || "");
  const [hVal, setHVal] = useState(seed.h);
  const [mVal, setMVal] = useState(seed.m);
  const minuteRef = useRef<HTMLInputElement>(null);

  // Sync from external value when controlled. Uncontrolled mode
  // never re-syncs — the parent surrenders ownership.
  useEffect(() => {
    if (!isControlled) return;
    const { h, m } = parseHHMM(value || "");
    setHVal(h);
    setMVal(m);
  }, [isControlled, value]);

  function emit(h: string, m: string) {
    if (onChange) onChange(combine(h, m));
  }

  function onHourChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
    setHVal(raw);
    emit(raw, mVal);
    // Auto-advance to minutes when 2 digits typed — feels native to
    // anyone who's used a phone-style time picker.
    if (raw.length === 2 && minuteRef.current) {
      minuteRef.current.focus();
      try {
        minuteRef.current.select();
      } catch {
        /* noop */
      }
    }
  }

  function onHourBlur() {
    if (!hVal) return;
    const padded = clampInt(hVal, 23);
    setHVal(padded);
    emit(padded, mVal);
  }

  function onMinuteChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/\D/g, "").slice(0, 2);
    setMVal(raw);
    emit(hVal, raw);
  }

  function onMinuteBlur() {
    if (!mVal) return;
    const padded = clampInt(mVal, 59);
    setMVal(padded);
    emit(hVal, padded);
  }

  return (
    <span
      className="time-picker"
      role="group"
      aria-label={ariaLabel || "שעה"}
      dir="ltr"
    >
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        className="time-picker-cell"
        value={hVal}
        onChange={onHourChange}
        onBlur={onHourBlur}
        placeholder="HH"
        aria-label="שעות"
        disabled={disabled}
        maxLength={2}
        autoComplete="off"
      />
      <span className="time-picker-sep" aria-hidden>:</span>
      <input
        ref={minuteRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        className="time-picker-cell"
        value={mVal}
        onChange={onMinuteChange}
        onBlur={onMinuteBlur}
        placeholder="MM"
        aria-label="דקות"
        disabled={disabled}
        maxLength={2}
        autoComplete="off"
      />
      {name && (
        // Hidden mirror so HTML-form submits (TaskCreateForm) pick
        // up the combined value under the same name the legacy
        // <input type="time"> used.
        <input
          type="hidden"
          name={name}
          value={combine(hVal, mVal)}
        />
      )}
    </span>
  );
}
