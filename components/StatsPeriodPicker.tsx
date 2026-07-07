"use client";

import { useMemo, useState } from "react";

/**
 * Multi-select period filter for the /stats page. Each option is one of:
 *   - "current"  → the rowType=current aggregation (one sample/project)
 *   - "YYYY-MM"  → a חודשי month bucket
 *
 * Default selection (null) is all months except "current" — because
 * "current" is the sum of its monthlies and including both
 * double-counts. Selecting "current" is opt-in.
 *
 * Controlled since the 2026-07 overhaul: StatsPageBody owns the state
 * (every consumer filters the already-loaded payload client-side) and
 * mirrors it to `?periods=` via history.replaceState. `onChange(null)`
 * means "back to the default months-only selection".
 */

const ALL_KEY = "__all__"; // sentinel meaning "all periods incl. current"

function labelFor(period: string): string {
  if (period === "current") return "Current (תיק־לקוחות חי)";
  // YYYY-MM → "06/2026" for compactness
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (m) return `${m[2]}/${m[1]}`;
  return period;
}

export default function StatsPeriodPicker({
  availablePeriods,
  selected,
  onChange,
}: {
  /** Periods present in the dataset — sorted by the server. */
  availablePeriods: string[];
  /** Current selection, or null for the default (all months). */
  selected: string[] | null;
  onChange: (periods: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);

  // Default selection — all months, no "current". Used when `selected`
  // is null (no explicit pick).
  const defaultMonthsOnly = useMemo(
    () => availablePeriods.filter((p) => p !== "current"),
    [availablePeriods],
  );
  const effectiveSelected = selected ?? defaultMonthsOnly;
  const effectiveSet = useMemo(
    () => new Set(effectiveSelected),
    [effectiveSelected],
  );

  // Active selection counts:
  // - All possible options → "כל התקופות"
  // - Default (all months, no current) → "כל החודשים"
  // - Custom → "N מתוך M"
  const allCount = availablePeriods.length;
  const monthsCount = defaultMonthsOnly.length;
  let buttonLabel: string;
  if (effectiveSet.size === allCount) buttonLabel = "כל התקופות";
  else if (
    effectiveSet.size === monthsCount &&
    defaultMonthsOnly.every((p) => effectiveSet.has(p))
  )
    buttonLabel = `כל החודשים (${monthsCount})`;
  else if (effectiveSet.size === 1)
    buttonLabel = labelFor(effectiveSelected[0]);
  else buttonLabel = `${effectiveSet.size} מתוך ${allCount}`;

  const emit = (next: string[]) => {
    if (
      next.length === defaultMonthsOnly.length &&
      defaultMonthsOnly.every((p) => next.includes(p))
    ) {
      // Selection equals the default — collapse to null so the URL
      // stays clean for the common case.
      onChange(null);
    } else {
      onChange(next);
    }
  };

  const togglePeriod = (period: string) => {
    const next = new Set(effectiveSelected);
    if (next.has(period)) next.delete(period);
    else next.add(period);
    emit(Array.from(next));
  };

  const setPreset = (preset: typeof ALL_KEY | "months" | "current-only") => {
    if (preset === ALL_KEY) emit(availablePeriods.slice());
    else if (preset === "months") emit(defaultMonthsOnly.slice());
    else if (preset === "current-only") emit(["current"]);
  };

  return (
    <div className="stats-picker">
      <button
        type="button"
        className="stats-picker-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="stats-picker-icon" aria-hidden>
          📅
        </span>
        <span className="stats-picker-current">{buttonLabel}</span>
        <span className="stats-picker-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="stats-picker-panel" role="listbox">
          <div className="period-picker-presets">
            <button
              type="button"
              className="stats-pill"
              onClick={() => setPreset("months")}
            >
              כל החודשים
            </button>
            <button
              type="button"
              className="stats-pill"
              onClick={() => setPreset(ALL_KEY)}
            >
              + Current
            </button>
            <button
              type="button"
              className="stats-pill"
              onClick={() => setPreset("current-only")}
            >
              Current בלבד
            </button>
          </div>
          <div className="stats-picker-list">
            {availablePeriods.map((p) => {
              const isOn = effectiveSet.has(p);
              return (
                <label
                  key={p}
                  className={
                    "period-picker-item" + (isOn ? " is-active" : "")
                  }
                >
                  <input
                    type="checkbox"
                    checked={isOn}
                    onChange={() => togglePeriod(p)}
                  />
                  <span>{labelFor(p)}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
