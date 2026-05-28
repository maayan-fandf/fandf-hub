"use client";

import { useRef } from "react";

/**
 * Tiny `<input type="month">` for /morning/forecast's prev-month view.
 *
 * Renders the native month picker (good keyboard + a11y support out
 * of the box, no library needed) and auto-submits the parent <form>
 * on change so the user doesn't need to hit "סנן" again after picking
 * a month.
 *
 * Props:
 *   defaultValue — initial YYYY-MM from the URL (?month=2026-03)
 *   max          — upper bound (typically the previous calendar month —
 *                  current/future would conflict with the "חודש נוכחי"
 *                  view)
 *
 * Submit happens via queueMicrotask so the controlled value lands in
 * the input before the form snapshots its field set. Same dance
 * TasksFilterCompanyProject uses.
 */
export default function ForecastMonthPicker({
  defaultValue,
  max,
}: {
  defaultValue: string;
  max: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  function submitParentForm() {
    const form = inputRef.current?.form;
    if (!form) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  }

  return (
    <label className="forecast-month-picker" title="בחר חודש">
      <span className="forecast-month-picker-icon" aria-hidden>
        📅
      </span>
      <input
        ref={inputRef}
        type="month"
        name="month"
        defaultValue={defaultValue}
        max={max}
        onChange={() => queueMicrotask(submitParentForm)}
        aria-label="חודש"
      />
    </label>
  );
}
