"use client";

import { useState } from "react";
import type {
  PortfolioBenchmarks,
  BenchmarkDistribution,
} from "@/lib/portfolioBenchmarks";

/**
 * Portfolio benchmarks table — the centerpiece of /stats.
 *
 * Renders the same distribution view as the dashboard's
 * renderBenchmarksOverview (Index.html:3767): a project-aggregate row
 * (one sample per project from current period), then per-channel-
 * family rows sorted by CPL sample size descending (most data-rich
 * first). For each row: n / P25 / חציון / P75 for עלות לליד, עלות
 * לתיאום, עלות לביצוע.
 *
 * Client component — drives a hover tooltip on the alias cells that
 * lists the raw channel labels normalized into each bucket. Native
 * `title` attribute is slow + plain-text only, so we render a styled
 * floating panel instead (2026-06-05).
 */

type Props = {
  benchmarks: PortfolioBenchmarks;
  /** Optional: alias → raw channel names for the hover tooltip. */
  aliasToRaw?: Record<string, string[]>;
};

const fmtIls = (n: number) =>
  n > 0 ? "₪" + Math.round(n).toLocaleString("he-IL") : "—";

const METRIC_LABELS: Array<{
  key: "cpl" | "cps" | "cpm";
  label: string;
}> = [
  { key: "cpl", label: "עלות לליד" },
  { key: "cps", label: "עלות לתיאום" },
  { key: "cpm", label: "עלות לביצוע" },
];

function StatsCells({ d }: { d: BenchmarkDistribution | undefined }) {
  const s = d?.stats;
  if (!s || !s.n) {
    return (
      <td colSpan={4} className="pb-muted">
        —
      </td>
    );
  }
  return (
    <>
      <td>{s.n}</td>
      <td>{fmtIls(s.p25)}</td>
      <td>{fmtIls(s.median)}</td>
      <td>{fmtIls(s.p75)}</td>
    </>
  );
}

export default function PortfolioBenchmarksTable({
  benchmarks,
  aliasToRaw,
}: Props) {
  const aliases = Object.keys(benchmarks.channels).sort((a, b) => {
    const na = benchmarks.channels[a].cpl?.stats.n || 0;
    const nb = benchmarks.channels[b].cpl?.stats.n || 0;
    return nb - na;
  });

  // Hovered alias — drives the floating tooltip listing the raw
  // channel labels that normalized into that bucket. Position-anchored
  // to the table row so it doesn't fight with the page layout.
  const [hovered, setHovered] = useState<string | null>(null);
  const hoveredRawList = hovered ? aliasToRaw?.[hovered] || [] : [];

  return (
    <div className="pb-wrap">
      <div className="pb-note">
        חלון: התקופה הנוכחית של כל פרויקט · ערוצים לא־ממומנים (אתר, טלפון,
        חדשות) לא נכללים בקיבוץ אבל כן בספירת הפרויקט.
      </div>

      {/* Project-aggregate distribution */}
      <div className="pb-section">
        <div className="pb-section-title">פרויקט (אגרגציה)</div>
        <table className="pb-table">
          <thead>
            <tr>
              <th></th>
              <th>n</th>
              <th>P25</th>
              <th>חציון</th>
              <th>P75</th>
            </tr>
          </thead>
          <tbody>
            {METRIC_LABELS.map((m) => {
              const d = benchmarks.project[m.key];
              const s = d?.stats;
              return (
                <tr key={m.key}>
                  <td>{m.label}</td>
                  {s && s.n ? (
                    <>
                      <td>{s.n}</td>
                      <td>{fmtIls(s.p25)}</td>
                      <td>{fmtIls(s.median)}</td>
                      <td>{fmtIls(s.p75)}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="pb-muted">
                      —
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Per-channel distribution */}
      <div className="pb-section">
        <div className="pb-section-title">
          לפי ערוץ ({aliases.length} קבוצות)
        </div>
        <div className="pb-table-scroll pb-channels-wrap">
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
          <table className="pb-table pb-table-channels">
            <thead>
              <tr>
                <th rowSpan={2}>ערוץ</th>
                <th colSpan={4}>עלות לליד</th>
                <th colSpan={4}>עלות לתיאום</th>
                <th colSpan={4}>עלות לביצוע</th>
              </tr>
              <tr>
                <th>n</th>
                <th>P25</th>
                <th>חציון</th>
                <th>P75</th>
                <th>n</th>
                <th>P25</th>
                <th>חציון</th>
                <th>P75</th>
                <th>n</th>
                <th>P25</th>
                <th>חציון</th>
                <th>P75</th>
              </tr>
            </thead>
            <tbody>
              {aliases.map((a) => {
                const c = benchmarks.channels[a];
                const rawCount = aliasToRaw?.[a]?.length || 0;
                return (
                  <tr
                    key={a}
                    className={
                      "pb-channel-row" + (hovered === a ? " is-hovered" : "")
                    }
                  >
                    <td
                      className="pb-alias"
                      onMouseEnter={() => setHovered(a)}
                      onMouseLeave={() =>
                        setHovered((cur) => (cur === a ? null : cur))
                      }
                    >
                      <span className="pb-alias-name">{a}</span>
                      {rawCount > 0 && (
                        <span className="pb-alias-count">
                          {" "}
                          ({rawCount})
                        </span>
                      )}
                    </td>
                    <StatsCells d={c.cpl} />
                    <StatsCells d={c.cps} />
                    <StatsCells d={c.cpm} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
