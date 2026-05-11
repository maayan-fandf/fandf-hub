"use client";

import { useMemo, useState } from "react";

/**
 * Per-source pie chart with multi-select chips.
 *
 * Each chip toggles its source in/out of the pie. The pie always shows
 * the AGGREGATE of currently-selected sources — so by default (all
 * selected) the user sees the project's overall objection mix; deselect
 * a couple and the pie collapses to just the active subset. "הכל" /
 * "ניקוי" links at the start of the row let the user select-all /
 * clear-all without clicking every chip.
 *
 * Aggregation is done on the client because:
 *   1. The lib already pre-buckets per source — no extra Sheets read.
 *   2. The combinatorial space (2^N sources) is too big to precompute
 *      server-side, and most selection flips happen within a single
 *      mental model (deselect noisy "yad2" → see other sources cleaner).
 *
 * Stable objection→color mapping is built once across the union of all
 * sources, so the same objection keeps its color when chips toggle.
 */

type Source = {
  source: string;
  total: number;
  topObjections: { label: string; count: number; isOther?: boolean }[];
};

const PALETTE = [
  "#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9",
  "#8b5cf6", "#14b8a6", "#ef4444", "#a3a3a3", "#84cc16",
];

export default function CrmSourcePieSection({
  breakdown,
}: {
  breakdown: Source[];
}) {
  // Default: every source selected → pie shows the overall objection mix.
  const allSources = useMemo(() => breakdown.map((b) => b.source), [breakdown]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(allSources),
  );

  const toggle = (source: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(allSources));
  const clearAll = () => setSelected(new Set());

  // Stable objection→color map: walk every source's top-objections in
  // declared order and assign palette colors in first-seen order. Stays
  // constant across chip toggles (so the same slice color = same
  // objection no matter what's selected). "אחר" (isOther) renders via
  // hatched CSS so it doesn't consume a palette slot.
  const objectionColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of breakdown) {
      for (const o of b.topObjections) {
        if (o.isOther) continue;
        if (m.has(o.label)) continue;
        m.set(o.label, PALETTE[m.size % PALETTE.length]);
      }
    }
    return m;
  }, [breakdown]);

  // Aggregate the active sources' objection counts into a single map.
  // The lib already rolled "tail" objections into "אחר" PER SOURCE, so
  // multiple sources may each contribute an "אחר" bucket — we sum them
  // into one rest segment for the rendered pie.
  const aggregated = useMemo(() => {
    const byObjection = new Map<string, number>();
    let otherTotal = 0;
    let grandTotal = 0;
    for (const b of breakdown) {
      if (!selected.has(b.source)) continue;
      for (const o of b.topObjections) {
        grandTotal += o.count;
        if (o.isOther) {
          otherTotal += o.count;
        } else {
          byObjection.set(o.label, (byObjection.get(o.label) || 0) + o.count);
        }
      }
    }
    // Sort named objections by count desc; "אחר" always trails.
    const slices: { label: string; count: number; isOther?: boolean }[] =
      [...byObjection.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({ label, count }));
    if (otherTotal > 0) {
      slices.push({ label: "אחר", count: otherTotal, isOther: true });
    }
    return { slices, total: grandTotal };
  }, [breakdown, selected]);

  // Pie geometry: walk slices in display order, emit conic-gradient stops.
  const pieStyle = useMemo(() => {
    if (aggregated.total === 0) {
      return { background: "#f3f4f6" };
    }
    let cum = 0;
    const stops: string[] = [];
    for (const s of aggregated.slices) {
      const start = (cum / aggregated.total) * 360;
      cum += s.count;
      const end = (cum / aggregated.total) * 360;
      if (end - start < 1.8) continue; // < 0.5% — skip invisible slices
      const fill = s.isOther ? "#d1d5db" : objectionColor.get(s.label) || "#cbd5e1";
      stops.push(`${fill} ${start.toFixed(3)}deg ${end.toFixed(3)}deg`);
    }
    return stops.length
      ? { background: `conic-gradient(${stops.join(", ")})` }
      : { background: "#f3f4f6" };
  }, [aggregated, objectionColor]);

  const noneSelected = selected.size === 0;

  return (
    <div className="crm-block">
      <div className="crm-block-title">פיי לפי מקור הגעה</div>
      <div className="crm-source-chips" role="group" aria-label="בחירת מקורות">
        <button
          type="button"
          className="crm-source-link"
          onClick={selectAll}
          disabled={selected.size === breakdown.length}
          title="בחר את כל המקורות"
        >
          הכל
        </button>
        <button
          type="button"
          className="crm-source-link"
          onClick={clearAll}
          disabled={selected.size === 0}
          title="נקה את הבחירה"
        >
          ניקוי
        </button>
        <span className="crm-source-chips-sep" aria-hidden="true">·</span>
        {breakdown.map((b) => {
          const isActive = selected.has(b.source);
          return (
            <button
              key={b.source}
              type="button"
              aria-pressed={isActive}
              className={
                "crm-source-chip" + (isActive ? " is-active" : "")
              }
              onClick={() => toggle(b.source)}
              title={`${b.source} — ${b.total} לידים עם התנגדות`}
            >
              <span className="crm-source-chip-name">{b.source}</span>
              <span className="crm-source-chip-count">{b.total}</span>
            </button>
          );
        })}
      </div>

      <div className="crm-pie-row">
        <div
          className={
            "crm-pie" + (noneSelected ? " crm-pie-empty" : "")
          }
          style={pieStyle}
          aria-label={
            noneSelected
              ? "לא נבחר מקור"
              : `התפלגות התנגדויות עבור ${selected.size} מקורות נבחרים`
          }
        >
          {noneSelected ? (
            <span className="crm-pie-empty-label">בחר מקור</span>
          ) : null}
        </div>
        <ul className="crm-pie-legend">
          {aggregated.slices.length === 0 ? (
            <li className="crm-pie-legend-empty">אין התנגדויות בקבוצה הנבחרת.</li>
          ) : (
            aggregated.slices.map((s) => (
              <li key={s.label}>
                <span
                  className={
                    "crm-legend-dot" + (s.isOther ? " crm-legend-dot-rest" : "")
                  }
                  style={
                    s.isOther
                      ? undefined
                      : { background: objectionColor.get(s.label) }
                  }
                />
                <span className="crm-legend-label" title={s.label}>
                  {s.label}
                </span>
                <span className="crm-legend-count">
                  {s.count} ({((s.count / aggregated.total) * 100).toFixed(1)}%)
                </span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
