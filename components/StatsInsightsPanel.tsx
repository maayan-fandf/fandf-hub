"use client";

import { useMemo } from "react";
import type { PortfolioBenchmarks } from "@/lib/portfolioBenchmarks";
import {
  computeInsights,
  METRIC_LABELS,
  type Metric,
} from "@/lib/statsInsights";

/**
 * Auto-insights strip — the "so what" layer. Instead of making the
 * reader mine eight charts, the page states what it found: direction
 * of travel, biggest month-over-month movers, the value channel,
 * significant outliers, the funnel-correlation verdict, volatility.
 * Every card is one Hebrew sentence + an optional jump action.
 *
 * Pure client-side derivation from the benchmarks payload
 * (lib/statsInsights.ts) — recomputes instantly when the metric
 * picker flips.
 */

export default function StatsInsightsPanel({
  benchmarks,
  metric,
  onAction,
}: {
  benchmarks: PortfolioBenchmarks;
  metric: Metric;
  /** Insight action click — StatsPageBody routes it (tab switch or
   *  project selection). */
  onAction: (action: {
    kind: "tab" | "project";
    tab?: string;
    project?: string;
  }) => void;
}) {
  const insights = useMemo(
    () => computeInsights(benchmarks, metric),
    [benchmarks, metric],
  );
  if (insights.length === 0) return null;

  return (
    <section className="stats-section insights-section">
      <div className="stats-section-head">
        <h2 style={{ margin: 0 }}>💡 מה הנתונים אומרים</h2>
        <span className="stats-rank-note">
          מחושב אוטומטית על {METRIC_LABELS[metric]} · מתעדכן עם הבחירה למעלה
        </span>
      </div>
      <div className="insights-grid">
        {insights.map((ins) => (
          <div key={ins.id} className={`insight-card is-${ins.tone}`}>
            <span className="insight-icon" aria-hidden>
              {ins.icon}
            </span>
            <span className="insight-text">{ins.text}</span>
            {ins.action && (
              <button
                type="button"
                className="insight-action"
                onClick={() => onAction(ins.action!)}
              >
                {ins.action.label} ←
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
