"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

/**
 * URL-driven multi-select period filter for the /stats page. Each
 * option is one of:
 *   - "current"  → the rowType=current aggregation (one sample/project)
 *   - "YYYY-MM"  → a חודשי month bucket
 *
 * Default selection (when ?periods= is absent or empty) is all months
 * except "current" — because "current" is the sum of its monthlies and
 * including both double-counts. Selecting "current" is opt-in.
 *
 * URL shape: `?periods=2026-06,2026-05,current` (comma-separated).
 * Empty selection = no filter = all months (default behavior).
 */

const ALL_KEY = "__all__"; // sentinel meaning "all months (current opt-out)"

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
}: {
  /** Periods present in the dataset — sorted by the server. */
  availablePeriods: string[];
  /** URL-decoded selection, or null when the user hasn't picked. */
  selected: string[] | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Default selection — all months, no "current". Used when `selected`
  // is null (no URL param yet).
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

  const writeURL = (next: string[]) => {
    const params = new URLSearchParams(searchParams?.toString() || "");
    if (
      next.length === defaultMonthsOnly.length &&
      defaultMonthsOnly.every((p) => next.includes(p))
    ) {
      // Selection equals the default — drop the param so the URL stays
      // clean for the common case.
      params.delete("periods");
    } else {
      params.set("periods", next.join(","));
    }
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `/stats?${qs}` : "/stats");
    });
  };

  const togglePeriod = (period: string) => {
    const next = new Set(effectiveSelected);
    if (next.has(period)) next.delete(period);
    else next.add(period);
    writeURL(Array.from(next));
  };

  const setPreset = (preset: typeof ALL_KEY | "months" | "current-only") => {
    if (preset === ALL_KEY) writeURL(availablePeriods.slice());
    else if (preset === "months") writeURL(defaultMonthsOnly.slice());
    else if (preset === "current-only") writeURL(["current"]);
  };

  return (
    <div className="stats-picker">
      <button
        type="button"
        className="stats-picker-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={isPending}
      >
        <span className="stats-picker-icon" aria-hidden>
          📅
        </span>
        <span className="stats-picker-current">{buttonLabel}</span>
        {isPending ? (
          <span className="stats-picker-caret">⏳</span>
        ) : (
          <span className="stats-picker-caret">{open ? "▴" : "▾"}</span>
        )}
      </button>
      {open && (
        <div className="stats-picker-panel" role="listbox">
          <div className="period-picker-presets">
            <button
              type="button"
              className="stats-pill"
              onClick={() => setPreset("months")}
              disabled={isPending}
            >
              כל החודשים
            </button>
            <button
              type="button"
              className="stats-pill"
              onClick={() => setPreset(ALL_KEY)}
              disabled={isPending}
            >
              + Current
            </button>
            <button
              type="button"
              className="stats-pill"
              onClick={() => setPreset("current-only")}
              disabled={isPending}
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
                    disabled={isPending}
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
