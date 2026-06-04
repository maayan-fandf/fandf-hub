"use client";

import { useMemo } from "react";
import GaussianStripPlot from "@/components/GaussianStripPlot";
import type {
  BenchmarkDistribution,
  PortfolioBenchmarks,
} from "@/lib/portfolioBenchmarks";
import { distributionOf } from "@/lib/statsMath";

/**
 * Renders the Gaussian distribution plots. Both `metric` and
 * `selectedPeriods` are URL-driven (the pickers live in the sticky
 * context bar at the top of /stats), so this component is a pure
 * renderer — no internal picker state.
 */

type Metric = "cpl" | "cps" | "cpm";

const METRIC_LABELS: Record<Metric, string> = {
  cpl: "עלות לליד",
  cps: "עלות לתיאום",
  cpm: "עלות לביצוע",
};

/** Filter a server-computed distribution to a subset of periods, then
 *  recompute mean / σ / quartiles from the surviving samples. Passing
 *  `null` (no filter) or a set that already covers everything returns
 *  the distribution untouched. */
function filterDistribution(
  d: BenchmarkDistribution,
  periodSet: Set<string> | null,
): BenchmarkDistribution {
  if (!periodSet || periodSet.size === 0) return d;
  const filtered = d.samples.filter((s) => periodSet.has(s.period));
  if (filtered.length === d.samples.length) return d;
  return distributionOf(filtered);
}

export default function GaussianSection({
  benchmarks,
  selectedProject,
  compareProject,
  selectedPeriods,
  metric,
}: {
  benchmarks: PortfolioBenchmarks;
  selectedProject: string | null;
  /** Compare-mode second project — when set, its samples render in
   *  amber on every bell so the user can read two projects against
   *  the portfolio side by side. */
  compareProject: string | null;
  /** Periods the user has selected via the top context bar. `null` =
   *  no filter (use server default). */
  selectedPeriods: string[] | null;
  /** URL-driven via `?metric=cpl|cps|cpm` (picker in the context bar). */
  metric: Metric;
}) {
  const metricLabel = METRIC_LABELS[metric];

  // Build a fast lookup once per render. Skipped if the user's
  // selection covers EVERY available period — no filter needed.
  const periodSet = useMemo(() => {
    if (!selectedPeriods || selectedPeriods.length === 0) return null;
    if (selectedPeriods.length === benchmarks.availablePeriods.length)
      return null;
    return new Set(selectedPeriods);
  }, [selectedPeriods, benchmarks.availablePeriods.length]);

  // Project × month distribution — filterable by period (the existing
  // plot). Each dot = one (project, month).
  const projectMonthDist = filterDistribution(
    benchmarks.project[metric],
    periodSet,
  );

  // Project lifetime distribution — one dot per PROJECT. Always uses
  // the rowType=current samples (which represent the project's full
  // flight-window aggregation), independent of the period filter. This
  // is the answer to "how does project X compare to project Y" without
  // multiple-dots-per-project noise. Owner asked 2026-06-05.
  const projectLifetimeDist = useMemo(() => {
    const currentOnly = benchmarks.project[metric].samples.filter(
      (s) => s.period === "current",
    );
    return distributionOf(currentOnly);
  }, [benchmarks.project, metric]);

  // Channel-family entries, filtered + re-sorted by the post-filter n
  const channelEntries = useMemo(() => {
    return Object.entries(benchmarks.channels)
      .map(([alias, c]) => ({
        alias,
        dist: filterDistribution(c[metric], periodSet),
      }))
      .filter((e) => e.dist.stats.n >= 3)
      .sort((a, b) => b.dist.stats.n - a.dist.stats.n)
      .slice(0, 6);
  }, [benchmarks.channels, metric, periodSet]);

  return (
    <section className="stats-section">
      <h2>📐 התפלגות גאוסיאנית — {metricLabel}</h2>

      {/* Legend — explains the curve / lines / dots and defines μ + σ. */}
      <div className="gsp-legend">
        <div className="gsp-legend-title">איך לקרוא את הגרפים:</div>
        <div className="gsp-legend-items">
          <span className="gsp-legend-item">
            <span className="gsp-legend-curve" aria-hidden /> עקומת
            פעמון של ההתפלגות (Normal PDF)
          </span>
          <span className="gsp-legend-item">
            <span className="gsp-legend-mu" aria-hidden /> <b>μ</b> —
            ממוצע
          </span>
          <span className="gsp-legend-item">
            <span className="gsp-legend-median" aria-hidden /> <b>M</b>{" "}
            — חציון
          </span>
          <span className="gsp-legend-item">
            <span className="gsp-legend-band1" aria-hidden /> ±1σ —
            סטיית-תקן אחת (כ-68% מהדגימות)
          </span>
          <span className="gsp-legend-item">
            <span className="gsp-legend-band2" aria-hidden /> ±2σ —
            שתי סטיות-תקן (כ-95%)
          </span>
          <span className="gsp-legend-item">
            <span className="gsp-legend-dot-muted" aria-hidden />{" "}
            פרויקט בתיק
          </span>
          <span className="gsp-legend-item">
            <span className="gsp-legend-dot-selected" aria-hidden />{" "}
            הפרויקט הנבחר
          </span>
        </div>
        <div className="gsp-legend-glossary">
          <b>σ (סיגמא)</b> = סטיית תקן — ערך גבוה משמעו שונות רחבה
          בתיק. <b>μ (מיו)</b> = ממוצע. <em>z-score</em> ליד שם הפרויקט
          הנבחר מציין בכמה סטיות-תקן הוא רחוק מהממוצע (|z|&nbsp;&lt;&nbsp;1
          = תקין, 1&nbsp;≤&nbsp;|z|&nbsp;&lt;&nbsp;2 = מעל הממוצע,
          |z|&nbsp;≥&nbsp;2 = חריג).
          {" · "}
          <b>אינטראקציה:</b> ריחוף על נקודה מסמן את כל נקודות אותו
          פרויקט (תוכלו לראות את הפיזור החודשי שלו על התפלגות התיק) ·
          לחיצה בוחרת את הפרויקט.
        </div>
      </div>

      <div className="gsp-grid">
        {/* Project lifetime — one dot per project. Best view for
            project-vs-project comparison. NOT affected by the period
            filter — always uses each project's full-window current
            aggregation. */}
        <GaussianStripPlot
          title={`🏆 פרויקט — סיכום (נקודה אחת לפרויקט) — ${metricLabel}`}
          distribution={projectLifetimeDist}
          highlightProject={selectedProject}
          compareProject={compareProject}
          metricLabel={`פרויקט (סיכום) · ${metricLabel}`}
        />
        {/* Project × month — multiple dots per project, one per month.
            Filterable by the period picker. */}
        <GaussianStripPlot
          title={`🌐 פרויקט × חודש — ${metricLabel}`}
          distribution={projectMonthDist}
          highlightProject={selectedProject}
          compareProject={compareProject}
          metricLabel={`פרויקט × חודש · ${metricLabel}`}
        />
        {channelEntries.map(({ alias, dist }) => (
          <GaussianStripPlot
            key={alias}
            title={`${alias} — ${metricLabel}`}
            distribution={dist}
            highlightProject={selectedProject}
            compareProject={compareProject}
            channelLabel={alias}
            metricLabel={metricLabel}
          />
        ))}
      </div>
    </section>
  );
}
