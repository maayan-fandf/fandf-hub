"use client";

import { useMemo, useState } from "react";
import PortfolioBenchmarksTable from "@/components/PortfolioBenchmarksTable";
import type { PortfolioBenchmarks } from "@/lib/portfolioBenchmarks";
import { METRIC_LABELS, type Metric } from "@/lib/statsInsights";
import { percentile } from "@/lib/statsMath";

/**
 * Channels tab — one view that merges what used to be two half-answers
 * (the cheap→expensive bar chart and the P25/median/P75 table): a
 * range-bar table. Every channel family is a row with its exact
 * numbers, plus a P25→P75 range bar with a median tick drawn on a
 * SHARED ₪ scale — so the visual ranking and the spread are readable
 * in the same glance.
 *
 * One accent hue for all bars (the old chart tinted bars green→red by
 * rank — a value-ramp on nominal categories, i.e. double-encoding —
 * dropped in the 2026-07 overhaul).
 *
 * The full three-metric table stays available under a details-toggle
 * (it remains the canonical "benchmarks distribution" artifact).
 */

const fmtIls = (n: number) =>
  n > 0 ? "₪" + Math.round(n).toLocaleString("he-IL") : "—";

export default function StatsChannelsView({
  benchmarks,
  aliasToRaw,
  metric,
}: {
  benchmarks: PortfolioBenchmarks;
  aliasToRaw: Record<string, string[]>;
  metric: Metric;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  const rows = useMemo(() => {
    return Object.entries(benchmarks.channels)
      .map(([alias, c]) => ({
        alias,
        n: c[metric].stats.n,
        p25: c[metric].stats.p25,
        median: c[metric].stats.median,
        p75: c[metric].stats.p75,
        rawCount: aliasToRaw?.[alias]?.length || 0,
      }))
      .filter((r) => r.n >= 3 && r.median > 0)
      .sort((a, b) => a.median - b.median);
  }, [benchmarks.channels, aliasToRaw, metric]);

  // Shared scale — one axis for every bar, so bar position IS the
  // ranking. A single runaway family (dv360's P75 was 7× everyone
  // else's) must not squash the rest into slivers: cap the scale near
  // the 90th percentile of P75s and CLIP outlier bars with an explicit
  // marker — their exact numbers still sit in the columns.
  const scaleMax = useMemo(() => {
    const p75s = rows.map((r) => r.p75);
    const max = Math.max(...p75s, 1);
    const q90 = percentile(p75s, 90);
    if (q90 > 0 && max > q90 * 2.5) return q90 * 1.1;
    return max * 1.05;
  }, [rows]);

  const projectStats = benchmarks.project[metric].stats;
  const hoveredRawList = hovered ? aliasToRaw?.[hovered] || [] : [];

  if (rows.length === 0) {
    return (
      <section className="stats-section">
        <h2>📡 ערוצים</h2>
        <div className="stats-empty">אין מספיק נתוני ערוצים (נדרש n ≥ 3).</div>
      </section>
    );
  }

  return (
    <>
      <section className="stats-section">
        <div className="stats-section-head">
          <h2 style={{ margin: 0 }}>
            📡 ערוצים לפי {METRIC_LABELS[metric]} — זול → יקר
          </h2>
          <span className="stats-rank-note">
            פס = טווח P25–P75 · קו = חציון · נכללות קבוצות עם n ≥ 3
          </span>
        </div>

        {/* Portfolio reference row — the project-aggregate distribution
            for the selected metric, so every channel bar is read
            against "the book as a whole". */}
        <div className="chan-portfolio-ref">
          כלל התיק: חציון <b>{fmtIls(projectStats.median)}</b>
          {" · "}P25 {fmtIls(projectStats.p25)} · P75 {fmtIls(projectStats.p75)}
          {" · "}n={projectStats.n}
        </div>

        <div className="chan-table-wrap">
          {hovered && hoveredRawList.length > 0 && (
            <div className="pb-alias-popover" role="tooltip">
              <div className="pb-alias-popover-head">
                <strong>{hovered}</strong>
                <span className="pb-alias-popover-count">
                  {hoveredRawList.length} ערוצים
                </span>
              </div>
              <ul className="pb-alias-popover-list">
                {hoveredRawList.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          <table className="chan-table">
            <thead>
              <tr>
                <th>ערוץ</th>
                <th className="chan-num">n</th>
                <th className="chan-num">P25</th>
                <th className="chan-num">חציון</th>
                <th className="chan-num">P75</th>
                <th className="chan-bar-col">
                  התפלגות (0 – {fmtIls(scaleMax)}
                  {rows.some((r) => r.p75 > scaleMax) ? " · ‹ = חורג מהסקאלה" : ""}
                  )
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const clipped = r.p75 > scaleMax;
                const left = Math.min((r.p25 / scaleMax) * 100, 99);
                const right = Math.min((r.p75 / scaleMax) * 100, 100);
                const width = Math.max(right - left, 0.8);
                const tick = Math.min((r.median / scaleMax) * 100, 99);
                return (
                  <tr
                    key={r.alias}
                    className={hovered === r.alias ? "is-hovered" : undefined}
                  >
                    <td
                      className="pb-alias chan-alias"
                      onMouseEnter={() => setHovered(r.alias)}
                      onMouseLeave={() =>
                        setHovered((cur) => (cur === r.alias ? null : cur))
                      }
                    >
                      <span className="pb-alias-name">{r.alias}</span>
                      {r.rawCount > 0 && (
                        <span className="pb-alias-count"> ({r.rawCount})</span>
                      )}
                    </td>
                    <td className="chan-num">{r.n}</td>
                    <td className="chan-num">{fmtIls(r.p25)}</td>
                    <td className="chan-num chan-median">{fmtIls(r.median)}</td>
                    <td className="chan-num">{fmtIls(r.p75)}</td>
                    <td className="chan-bar-col">
                      <div
                        className="chan-track"
                        title={`P25 ${fmtIls(r.p25)} · חציון ${fmtIls(r.median)} · P75 ${fmtIls(r.p75)}`}
                      >
                        <div
                          className="chan-range"
                          style={{
                            insetInlineStart: `${left}%`,
                            width: `${width}%`,
                          }}
                        />
                        <div
                          className="chan-tick"
                          style={{ insetInlineStart: `${tick}%` }}
                        />
                        {clipped && (
                          <span className="chan-clip" aria-hidden>
                            ‹
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <details className="stats-section stats-details">
        <summary>
          🏛 הטבלה המלאה — התפלגות התיק בכל שלושת המדדים (n · P25 · חציון ·
          P75)
        </summary>
        <PortfolioBenchmarksTable
          benchmarks={benchmarks}
          aliasToRaw={aliasToRaw}
        />
      </details>
    </>
  );
}
