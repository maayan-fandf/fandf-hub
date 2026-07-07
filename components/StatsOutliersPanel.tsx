"use client";

import { useMemo } from "react";
import type {
  BenchmarkSample,
  PortfolioBenchmarks,
} from "@/lib/portfolioBenchmarks";
import {
  describeSignificance,
  distributionOf,
  twoSidedPValue,
  type SignificanceTier,
} from "@/lib/statsMath";

/**
 * Outliers panel — auto-detects projects whose current-period CPL/CPS/
 * CPM is significantly far from the portfolio mean (|z| ≥ Z_THRESHOLD).
 * Surfaces them as compact cards at the top of /stats so the user sees
 * "who needs my attention today" without scrolling the bells.
 *
 * Uses the rowType=current samples (one per project, lifetime view) as
 * the baseline — that's the most meaningful cross-project comparison.
 * Owner asked for this 2026-06-05.
 */

const Z_THRESHOLD = 1.5;

const METRIC_LABELS: Record<"cpl" | "cps" | "cpm", string> = {
  cpl: "עלות לליד",
  cps: "עלות לתיאום",
  cpm: "עלות לביצוע",
};

const fmtIls = (n: number) => "₪" + Math.round(n).toLocaleString("he-IL");

type Outlier = {
  project: string;
  value: number;
  z: number;
  delta: number; // value - median
  pValue: number;
  significance: { tier: SignificanceTier; label: string };
  side: "expensive" | "winner";
};

function detectOutliers(
  samples: BenchmarkSample[],
  mean: number,
  stddev: number,
  median: number,
): Outlier[] {
  if (!stddev || samples.length < 3) return [];
  const list: Outlier[] = [];
  for (const s of samples) {
    const z = (s.value - mean) / stddev;
    if (Math.abs(z) < Z_THRESHOLD) continue;
    const p = twoSidedPValue(z);
    list.push({
      project: s.project,
      value: s.value,
      z,
      delta: s.value - median,
      pValue: p,
      significance: describeSignificance(p),
      side: z > 0 ? "expensive" : "winner",
    });
  }
  // Sort by |z| desc — worst/best first
  list.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return list;
}

export default function StatsOutliersPanel({
  benchmarks,
  metric,
  onSelectProject,
}: {
  benchmarks: PortfolioBenchmarks;
  metric: "cpl" | "cps" | "cpm";
  /** Card click — StatsPageBody routes it into the drill-down tab. */
  onSelectProject: (project: string) => void;
}) {
  const { expensive, winners, baselineCount } = useMemo(() => {
    // Lifetime samples only — that's the project-vs-project baseline.
    const currentOnly = benchmarks.project[metric].samples.filter(
      (s) => s.period === "current",
    );
    const dist = distributionOf(currentOnly);
    const outliers = detectOutliers(
      dist.samples,
      dist.mean,
      dist.stddev,
      dist.stats.median,
    );
    return {
      expensive: outliers.filter((o) => o.side === "expensive"),
      winners: outliers.filter((o) => o.side === "winner"),
      baselineCount: currentOnly.length,
    };
  }, [benchmarks.project, metric]);

  const handleClick = (project: string) => {
    onSelectProject(project);
  };

  if (expensive.length === 0 && winners.length === 0) {
    if (baselineCount < 3) {
      // Not enough data to call anyone an outlier.
      return null;
    }
    return (
      <section className="stats-section stats-heads-up">
        <h2>🎯 דורש תשומת לב</h2>
        <div className="stats-empty">
          ✓ אין פרויקטים חורגים בתיק כרגע (כל הפרויקטים בתחום של {Z_THRESHOLD}
          σ מהממוצע).
        </div>
      </section>
    );
  }

  const renderCard = (o: Outlier) => {
    const sign = o.z >= 0 ? "+" : "−";
    const zAbs = Math.abs(o.z).toFixed(2);
    const deltaPrefix = o.delta >= 0 ? "+" : "−";
    return (
      <button
        key={o.project + o.side}
        type="button"
        className={`stats-outlier-card is-${o.side}`}
        onClick={() => handleClick(o.project)}
        title={`לחץ כדי לבחור את ${o.project}`}
      >
        <div className="stats-outlier-head">
          <span className="stats-outlier-icon" aria-hidden>
            {o.side === "expensive" ? "🔴" : "🟢"}
          </span>
          <span className="stats-outlier-project">{o.project}</span>
        </div>
        <div className="stats-outlier-value">{fmtIls(o.value)}</div>
        <div className="stats-outlier-meta">
          <span className="stats-outlier-z">
            {sign}
            {zAbs}σ
          </span>
          <span className="stats-outlier-delta">
            {deltaPrefix}
            {fmtIls(Math.abs(o.delta))} מהחציון
          </span>
          <span
            className={`stats-outlier-sig is-${o.significance.tier}`}
            title={`p = ${o.pValue < 0.001 ? "<0.001" : o.pValue.toFixed(3)}`}
          >
            {o.significance.label}
          </span>
        </div>
      </button>
    );
  };

  return (
    <section className="stats-section stats-heads-up">
      <div className="stats-section-head">
        <h2 style={{ margin: 0 }}>
          🎯 דורש תשומת לב — {METRIC_LABELS[metric]}
        </h2>
        <span className="stats-heads-up-count">
          {expensive.length + winners.length} פרויקטים מתוך {baselineCount}{" "}
          בתיק
        </span>
      </div>
      {expensive.length > 0 && (
        <div className="stats-outlier-group">
          <div className="stats-outlier-group-label">
            🔴 פרויקטים יקרים חריג ({expensive.length})
          </div>
          <div className="stats-outlier-list">{expensive.map(renderCard)}</div>
        </div>
      )}
      {winners.length > 0 && (
        <div className="stats-outlier-group">
          <div className="stats-outlier-group-label">
            🟢 פרויקטים יעילים ({winners.length})
          </div>
          <div className="stats-outlier-list">{winners.map(renderCard)}</div>
        </div>
      )}
    </section>
  );
}
