"use client";

/**
 * Three-pill metric picker for /stats's sticky context bar. Controlled
 * since the 2026-07 overhaul: StatsPageBody owns the metric state (all
 * consumers are client components slicing the already-loaded payload,
 * so flipping metrics is instant — the URL is synced by the parent via
 * history.replaceState, no server round-trip).
 */

const METRICS: Array<{ key: "cpl" | "cps" | "cpm"; label: string }> = [
  { key: "cpl", label: "עלות לליד" },
  { key: "cps", label: "עלות לתיאום" },
  { key: "cpm", label: "עלות לביצוע" },
];

export default function StatsMetricPicker({
  selected,
  onChange,
}: {
  selected: "cpl" | "cps" | "cpm";
  onChange: (m: "cpl" | "cps" | "cpm") => void;
}) {
  return (
    <div
      className="stats-metric-picker"
      role="radiogroup"
      aria-label="בחירת מטריקה"
    >
      {METRICS.map((m) => (
        <button
          key={m.key}
          type="button"
          role="radio"
          aria-checked={selected === m.key}
          className={"stats-pill" + (selected === m.key ? " is-active" : "")}
          onClick={() => onChange(m.key)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
