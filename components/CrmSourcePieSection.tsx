"use client";

import { useState } from "react";

/**
 * Per-source pie chart: pick a source from the chip row → see how its
 * leads broke down across objections. Companion to the objections×source
 * matrix above (same matrix, transposed view) — picker prevents N pies
 * from flooding the screen for projects with many sources.
 *
 * Renders the pie as a conic-gradient (no SVG, no chart lib) because
 * the data is already pre-bucketed by the server. Same stable
 * objection→color mapping across all sources so switching the picker
 * doesn't re-shuffle the legend.
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
  // Default: first source (highest total). Empty state shouldn't render
  // since the parent already gates on `breakdown.length > 0`.
  const [selected, setSelected] = useState<string>(breakdown[0]?.source ?? "");
  const active =
    breakdown.find((b) => b.source === selected) ?? breakdown[0];
  if (!active) return null;

  // Build the stable objection→color map ACROSS all sources, so the same
  // objection has the same color no matter which source-pie is showing.
  const objectionColor = new Map<string, string>();
  for (const b of breakdown) {
    for (const o of b.topObjections) {
      if (objectionColor.has(o.label)) continue;
      if (o.isOther) continue; // hatched, not a palette color
      objectionColor.set(o.label, PALETTE[objectionColor.size % PALETTE.length]);
    }
  }

  // Pie geometry: walk segments, emit `color start end` triples for
  // conic-gradient. Skip slices < 0.5% — they're invisible anyway and
  // adding zero-degree stops produces rendering artifacts.
  let cum = 0;
  const stops: string[] = [];
  for (const o of active.topObjections) {
    const start = (cum / active.total) * 360;
    cum += o.count;
    const end = (cum / active.total) * 360;
    if (end - start < 1.8) continue; // < 0.5% — skip
    const color = o.isOther ? "url(#crm-pie-hatch)" : objectionColor.get(o.label) || "#cbd5e1";
    // conic-gradient doesn't accept url() refs — for the "other"
    // bucket we render a flat neutral color and rely on the legend to
    // explain. Alternative would be an SVG pie, more code for one
    // bucket's worth of visual nuance.
    const fill = o.isOther ? "#d1d5db" : color;
    stops.push(`${fill} ${start.toFixed(3)}deg ${end.toFixed(3)}deg`);
  }
  const pieStyle = stops.length
    ? { background: `conic-gradient(${stops.join(", ")})` }
    : { background: "#f3f4f6" };

  return (
    <div className="crm-block">
      <div className="crm-block-title">פיי לפי מקור הגעה</div>
      <div className="crm-source-chips" role="tablist">
        {breakdown.map((b) => (
          <button
            key={b.source}
            type="button"
            role="tab"
            aria-selected={b.source === selected}
            className={
              "crm-source-chip" +
              (b.source === selected ? " is-active" : "")
            }
            onClick={() => setSelected(b.source)}
            title={`${b.source} — ${b.total} לידים עם התנגדות`}
          >
            <span className="crm-source-chip-name">{b.source}</span>
            <span className="crm-source-chip-count">{b.total}</span>
          </button>
        ))}
      </div>

      <div className="crm-pie-row">
        <div
          className="crm-pie"
          style={pieStyle}
          aria-label={`התפלגות התנגדויות עבור מקור ${active.source}`}
        />
        <ul className="crm-pie-legend">
          {active.topObjections.map((o) => (
            <li key={o.label}>
              <span
                className={
                  "crm-legend-dot" + (o.isOther ? " crm-legend-dot-rest" : "")
                }
                style={
                  o.isOther
                    ? undefined
                    : { background: objectionColor.get(o.label) }
                }
              />
              <span className="crm-legend-label" title={o.label}>
                {o.label}
              </span>
              <span className="crm-legend-count">
                {o.count} ({((o.count / active.total) * 100).toFixed(1)}%)
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
