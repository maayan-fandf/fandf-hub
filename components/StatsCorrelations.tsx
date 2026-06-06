"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PortfolioBenchmarks } from "@/lib/portfolioBenchmarks";
import {
  describeSignificance,
  linearRegression,
  pearsonPValue,
  pearsonR,
} from "@/lib/statsMath";

/**
 * Funnel-correlation scatters — three side-by-side plots showing how the
 * portfolio's per-project CPL relates to the downstream funnel:
 *
 *   1. CPL vs CPS — does a cheap lead translate to a cheap scheduled
 *      meeting, or do channels that produce cheap leads bottleneck
 *      somewhere between intake and scheduling?
 *
 *   2. CPL vs CPM — same question for actual held meetings.
 *
 *   3. CPL vs scheduling rate — does paying more per lead actually
 *      buy higher-quality intent? Plots CPL against the share of
 *      leads that convert to a scheduled meeting (scheduled/leads).
 *      Positive r ⇒ "you pay more, you get better-converting leads";
 *      flat/negative r ⇒ "expensive leads don't earn their cost".
 *      Owner asked for this third axis 2026-06-05 to test the
 *      "expensive leads = better leads" hypothesis end-to-end.
 *
 * Each dot is one PROJECT, plotted at (its lifetime CPL, its lifetime
 * CPS/CPM/rate). Uses period="current" samples — those represent the
 * project's full-window aggregation, so one dot per project.
 *
 * The summary line shows Pearson r + significance tier + a regression
 * slope (formatted as money or % depending on Y axis kind). The
 * regression line is overlaid on the scatter so the trend is visible
 * even when individual dots scatter.
 */

const fmtIls = (n: number) => "₪" + Math.round(n).toLocaleString("he-IL");
const fmtPct = (n: number) => n.toFixed(1) + "%";

type YKind = "money" | "percent";

type ScatterDot = {
  project: string;
  x: number;
  y: number;
};

function buildDots(
  benchmarks: PortfolioBenchmarks,
  metricX: "cpl",
  metricY: "cps" | "cpm",
): ScatterDot[] {
  // Project → x value (lifetime CPL) and y value (lifetime CPS/CPM).
  const xByProject = new Map<string, number>();
  for (const s of benchmarks.project[metricX].samples) {
    if (s.period === "current") xByProject.set(s.project, s.value);
  }
  const yByProject = new Map<string, number>();
  for (const s of benchmarks.project[metricY].samples) {
    if (s.period === "current") yByProject.set(s.project, s.value);
  }
  const dots: ScatterDot[] = [];
  xByProject.forEach((x, project) => {
    const y = yByProject.get(project);
    if (y == null) return; // project has CPL but not CPS/CPM — drop
    dots.push({ project, x, y });
  });
  return dots;
}

/**
 * CPL ↔ scheduling rate: scheduled/leads, derived from the existing
 * CPL + CPS benchmarks without any new data fetch. The identity:
 *
 *   CPS = spend / scheduled
 *   CPL = spend / leads
 *   ⇒ scheduled / leads = CPL / CPS
 *
 * Returns rate as a percentage (0–100). Projects with CPS == 0 (no
 * scheduled meetings at all) are dropped — division by zero, and the
 * "zero conversion" case is the empty-funnel signal the dashboard
 * already surfaces elsewhere. Rates outside [0, 100] are also dropped
 * as sanity guards against data oddities (e.g., CPL > CPS due to
 * different snapshot windows).
 */
function buildSchedRateDots(benchmarks: PortfolioBenchmarks): ScatterDot[] {
  const cplByProject = new Map<string, number>();
  for (const s of benchmarks.project.cpl.samples) {
    if (s.period === "current") cplByProject.set(s.project, s.value);
  }
  const cpsByProject = new Map<string, number>();
  for (const s of benchmarks.project.cps.samples) {
    if (s.period === "current") cpsByProject.set(s.project, s.value);
  }
  const dots: ScatterDot[] = [];
  cplByProject.forEach((cpl, project) => {
    const cps = cpsByProject.get(project);
    if (cps == null || cps <= 0) return;
    const rate = (cpl / cps) * 100;
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return;
    dots.push({ project, x: cpl, y: rate });
  });
  return dots;
}

type Stats = {
  dots: ScatterDot[];
  r: number;
  p: number;
  regression: { slope: number; intercept: number } | null;
};

function buildStats(dots: ScatterDot[]): Stats {
  const xs = dots.map((d) => d.x);
  const ys = dots.map((d) => d.y);
  return {
    dots,
    r: pearsonR(xs, ys),
    p: pearsonPValue(pearsonR(xs, ys), xs.length),
    regression: linearRegression(xs, ys),
  };
}

function strengthLabel(r: number): string {
  const a = Math.abs(r);
  if (a < 0.2) return "ללא קשר";
  if (a < 0.4) return "חלש";
  if (a < 0.6) return "בינוני";
  if (a < 0.8) return "חזק";
  return "חזק מאוד";
}

function ScatterPanel({
  title,
  xLabel,
  yLabel,
  /** "money" (default) → ₪-formatted Y axis + ₪-formatted slope.
   *  "percent" → %-formatted Y axis + percentage-point slope. The X
   *  axis stays ₪ in both cases (every existing plot has CPL on X). */
  yKind = "money",
  stats,
  highlightProject,
  compareProject,
  onDotClick,
}: {
  title: string;
  xLabel: string;
  yLabel: string;
  yKind?: YKind;
  stats: Stats;
  highlightProject: string | null;
  compareProject: string | null;
  onDotClick: (project: string) => void;
}) {
  const fmtY = yKind === "percent" ? fmtPct : fmtIls;
  // The slope describes Δy per ₪1 of CPL. For money: "+₪0.42". For
  // percent: "+0.42 נקודות אחוז" — keeps the unit explicit instead of
  // a bare "+0.42%" that's easily misread as relative change.
  const formatSlope = (slope: number) => {
    const sign = slope >= 0 ? "+" : "−";
    const abs = Math.abs(slope);
    if (yKind === "percent") {
      return `${sign}${abs.toFixed(2)} נקודות אחוז`;
    }
    return `${sign}₪${abs.toFixed(2)}`;
  };
  // Drop the unit suffix from labels when stating "for every ₪1 in X,
  // Y rises by Δ" — repeating "(₪)" inside that sentence reads noisy.
  const stripUnit = (s: string) =>
    s.replace(" (₪)", "").replace(" (%)", "");
  const { dots, r, p, regression } = stats;
  const sig = describeSignificance(p);

  if (dots.length < 3) {
    return (
      <div className="stats-corr-card">
        <div className="stats-corr-head">{title}</div>
        <div className="stats-empty">
          אין מספיק נתונים (נמצאו רק {dots.length} פרויקטים שיש להם שני המדדים).
        </div>
      </div>
    );
  }

  // Domain for the regression line — span the full data range.
  const xMin = Math.min(...dots.map((d) => d.x));
  const xMax = Math.max(...dots.map((d) => d.x));
  const regLine =
    regression != null
      ? [
          { x: xMin, y: regression.slope * xMin + regression.intercept },
          { x: xMax, y: regression.slope * xMax + regression.intercept },
        ]
      : [];

  // Tag each dot with its bucket so we can color them via the Scatter
  // component's shape function.
  const tagged = dots.map((d) => ({
    ...d,
    bucket:
      d.project === highlightProject
        ? "selected"
        : d.project === compareProject
          ? "compare"
          : "other",
  }));

  return (
    <div className="stats-corr-card">
      <div className="stats-corr-head">{title}</div>
      <div className="stats-corr-stats">
        <span>
          <b>r = {r.toFixed(2)}</b>
        </span>
        <span>n = {dots.length}</span>
        <span className={`stats-corr-strength is-${strengthLabel(r) === "ללא קשר" ? "none" : "real"}`}>
          {strengthLabel(r)}
        </span>
        <span
          className={`stats-outlier-sig is-${sig.tier}`}
          title={`p = ${p < 0.001 ? "<0.001" : p.toFixed(3)}`}
        >
          {sig.label}
        </span>
        {regression && (
          <span className="stats-corr-slope">
            לכל ₪1 ב-{stripUnit(xLabel)} · {stripUnit(yLabel)} עולה ב-
            {formatSlope(regression.slope)}
          </span>
        )}
      </div>
      <div className="stats-corr-chart">
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart margin={{ top: 16, right: 24, left: 24, bottom: 30 }}>
            <CartesianGrid stroke="rgba(127,127,127,0.10)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              tickFormatter={(v) => fmtIls(v)}
              tick={{ fontSize: 11 }}
              label={{ value: xLabel, position: "insideBottom", offset: -10, fontSize: 11 }}
            />
            <YAxis
              type="number"
              dataKey="y"
              tickFormatter={(v) => fmtY(v)}
              tick={{ fontSize: 11 }}
              label={{
                value: yLabel,
                angle: -90,
                position: "insideLeft",
                offset: -12,
                fontSize: 11,
              }}
            />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              contentStyle={{ background: "white", border: "1px solid #e5e7eb", direction: "rtl" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload as ScatterDot | { x: number; y: number };
                const project = "project" in d ? d.project : null;
                if (!project) return null;
                return (
                  <div className="gsp-tooltip">
                    <strong>{project}</strong>
                    <span>
                      {stripUnit(xLabel)}: {fmtIls(d.x)}
                    </span>
                    <span>
                      {stripUnit(yLabel)}: {fmtY(d.y)}
                    </span>
                  </div>
                );
              }}
            />
            {/* Regression line — drawn first so dots sit on top. */}
            {regLine.length === 2 && (
              <Line
                data={regLine}
                dataKey="y"
                type="linear"
                stroke="#0891b2"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                legendType="none"
              />
            )}
            <Scatter
              data={tagged}
              isAnimationActive={false}
              shape={(props: {
                cx?: number;
                cy?: number;
                payload?: ScatterDot & { bucket: string };
              }) => {
                const bucket = props.payload?.bucket || "other";
                const fill =
                  bucket === "selected"
                    ? "#4338ca"
                    : bucket === "compare"
                      ? "#d97706"
                      : "#94a3b8";
                const r =
                  bucket === "selected" ? 7 : bucket === "compare" ? 6.5 : 5;
                return (
                  <circle
                    cx={props.cx || 0}
                    cy={props.cy || 0}
                    r={r}
                    fill={fill}
                    stroke={bucket === "other" ? "none" : "#fff"}
                    strokeWidth={bucket === "selected" ? 2 : bucket === "compare" ? 1.5 : 0}
                    style={{ cursor: "pointer" }}
                    onClick={() => {
                      if (props.payload?.project) onDotClick(props.payload.project);
                    }}
                  />
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function StatsCorrelations({
  benchmarks,
  highlightProject,
  compareProject,
}: {
  benchmarks: PortfolioBenchmarks;
  highlightProject: string | null;
  compareProject: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const cplCpsStats = useMemo(
    () => buildStats(buildDots(benchmarks, "cpl", "cps")),
    [benchmarks],
  );
  const cplCpmStats = useMemo(
    () => buildStats(buildDots(benchmarks, "cpl", "cpm")),
    [benchmarks],
  );
  const cplRateStats = useMemo(
    () => buildStats(buildSchedRateDots(benchmarks)),
    [benchmarks],
  );

  const handleDotClick = (project: string) => {
    const params = new URLSearchParams(searchParams?.toString() || "");
    params.set("project", project);
    router.push(`/stats?${params.toString()}`);
  };

  if (
    cplCpsStats.dots.length < 3 &&
    cplCpmStats.dots.length < 3 &&
    cplRateStats.dots.length < 3
  ) {
    return null;
  }

  return (
    <section className="stats-section">
      <h2>🔗 קורלציות במשפך — האם זול-בליד = זול-בהמשך?</h2>
      <div className="stats-corr-meta">
        כל נקודה = פרויקט אחד (סיכום כל הזמן). קו ייחוס = רגרסיה לינארית.
        Pearson r מציין עוצמת הקשר הלינארי, p-value את מובהקותו.
      </div>
      <div className="stats-corr-grid">
        <ScatterPanel
          title="עלות לליד ↔ עלות לתיאום"
          xLabel="עלות לליד (₪)"
          yLabel="עלות לתיאום (₪)"
          stats={cplCpsStats}
          highlightProject={highlightProject}
          compareProject={compareProject}
          onDotClick={handleDotClick}
        />
        <ScatterPanel
          title="עלות לליד ↔ עלות לביצוע"
          xLabel="עלות לליד (₪)"
          yLabel="עלות לביצוע (₪)"
          stats={cplCpmStats}
          highlightProject={highlightProject}
          compareProject={compareProject}
          onDotClick={handleDotClick}
        />
        <ScatterPanel
          title="עלות לליד ↔ אחוז תיאום"
          xLabel="עלות לליד (₪)"
          yLabel="אחוז תיאום (%)"
          yKind="percent"
          stats={cplRateStats}
          highlightProject={highlightProject}
          compareProject={compareProject}
          onDotClick={handleDotClick}
        />
      </div>
    </section>
  );
}
