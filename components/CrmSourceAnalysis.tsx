"use client";

import { useMemo, useState } from "react";
import CrmFunnelTrendline from "./CrmFunnelTrendline";

/**
 * Wrapper client component that owns the source-selection state shared
 * between the per-source pie picker (with chips at the top) and the
 * trendline chart below. Both surfaces respond to the same chip
 * selection so the user can dial in a source mix once and have both
 * the objection-distribution pie AND the over-time trend reflect the
 * same filter.
 *
 * Defaults to every chip selected — first impression is the full
 * project view; clicking chips narrows from there. Empty selection is
 * allowed: the pie shows an empty state, the trendline hides itself.
 */

type Source = {
  source: string;
  total: number;
  topObjections: { label: string; count: number; isOther?: boolean }[];
};

type DailyTimeSeries = {
  date: string;
  bySource: {
    source: string;
    leads: number;
    scheduledMeetings: number;
    meetings: number;
  }[];
}[];

const PALETTE = [
  "#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9",
  "#8b5cf6", "#14b8a6", "#ef4444", "#a3a3a3", "#84cc16",
];

export default function CrmSourceAnalysis({
  breakdown,
  dailyTimeSeries,
}: {
  breakdown: Source[];
  dailyTimeSeries: DailyTimeSeries;
}) {
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

  // Stable objection→color map across all sources — same algorithm the
  // old (state-internal) pie used. Hoisted here so the pie + trendline
  // could share it if we ever want to color trendline series by an
  // objection's color too (today the trendline uses metric-based
  // colors, not objection-based, so this is just the pie's palette).
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

  // Aggregate the active sources' objection counts into a single map
  // — same logic as the old in-component aggregation.
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
    const slices: { label: string; count: number; isOther?: boolean }[] =
      [...byObjection.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({ label, count }));
    if (otherTotal > 0) {
      slices.push({ label: "אחר", count: otherTotal, isOther: true });
    }
    return { slices, total: grandTotal };
  }, [breakdown, selected]);

  // SVG arcs for the pie, with native <title> tooltips per slice.
  const sliceArcs = useMemo(() => {
    if (aggregated.total === 0) return [] as Array<{
      d: string; fill: string; tooltip: string; label: string;
    }>;
    const arcs: Array<{ d: string; fill: string; tooltip: string; label: string }> = [];
    let cumFrac = 0;
    for (const s of aggregated.slices) {
      const startFrac = cumFrac;
      cumFrac += s.count / aggregated.total;
      const endFrac = cumFrac;
      if (endFrac - startFrac < 0.005) continue;
      const a0 = startFrac * 2 * Math.PI - Math.PI / 2;
      const a1 = endFrac * 2 * Math.PI - Math.PI / 2;
      const x0 = 50 + 50 * Math.cos(a0);
      const y0 = 50 + 50 * Math.sin(a0);
      const x1 = 50 + 50 * Math.cos(a1);
      const y1 = 50 + 50 * Math.sin(a1);
      const largeArc = endFrac - startFrac > 0.5 ? 1 : 0;
      const d =
        endFrac - startFrac >= 0.9999
          ? `M 50 0 A 50 50 0 1 1 49.999 0 Z`
          : `M 50 50 L ${x0.toFixed(3)} ${y0.toFixed(3)} A 50 50 0 ${largeArc} 1 ${x1.toFixed(3)} ${y1.toFixed(3)} Z`;
      const fill = s.isOther
        ? "#d1d5db"
        : objectionColor.get(s.label) || "#cbd5e1";
      const pctText = ((s.count / aggregated.total) * 100).toFixed(1);
      const srcContext =
        selected.size === breakdown.length
          ? "כל המקורות"
          : selected.size === 1
            ? [...selected][0]
            : `${selected.size} מקורות נבחרים`;
      const tooltip = `${s.label}  ·  ${srcContext}  ·  ${s.count} (${pctText}%)`;
      arcs.push({ d, fill, tooltip, label: s.label });
    }
    return arcs;
  }, [aggregated, objectionColor, selected, breakdown]);

  const noneSelected = selected.size === 0;

  return (
    <>
      {/* Per-source pie + chip picker */}
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
            aria-label={
              noneSelected
                ? "לא נבחר מקור"
                : `התפלגות התנגדויות עבור ${selected.size} מקורות נבחרים`
            }
          >
            {noneSelected ? (
              <span className="crm-pie-empty-label">בחר מקור</span>
            ) : (
              <svg
                viewBox="0 0 100 100"
                className="crm-pie-svg"
                role="img"
                aria-hidden="true"
              >
                {sliceArcs.map((slice) => (
                  <path key={slice.label} d={slice.d} fill={slice.fill}>
                    <title>{slice.tooltip}</title>
                  </path>
                ))}
              </svg>
            )}
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

      {/* Trendline below — sums over the same selected-source set. */}
      <CrmFunnelTrendline
        dailyTimeSeries={dailyTimeSeries}
        selectedSources={selected}
      />
    </>
  );
}
