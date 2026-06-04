"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  XAxis,
  YAxis,
} from "recharts";
import type { BenchmarkDistribution } from "@/lib/portfolioBenchmarks";

/**
 * Gaussian distribution plot — main feature is an actual bell curve
 * (Normal PDF) rendered as a filled area; project samples appear as a
 * rug of dots underneath. Mean / ±1σ / ±2σ / median are reference lines.
 *
 * The bell curve uses the parametric Normal PDF
 *     f(x) = (1/(σ√2π)) · exp(-½((x-μ)/σ)²)
 * with μ = sample mean and σ = sample standard deviation. That's an
 * approximation (the underlying CPL distribution isn't truly normal),
 * but it gives the user the visual lens they actually asked for: "is
 * my project's CPL in the bell's body or in the tail?"
 *
 * Two highlighting modes:
 *   - When a project is selected (highlightProject set), its dot
 *     renders in brand color + larger.
 *   - All other dots are muted gray and jittered into 2 lanes below
 *     the curve so dense regions don't overlap to one mass.
 */

type Props = {
  title: string;
  distribution: BenchmarkDistribution;
  highlightProject?: string | null;
  /** Compare-mode second highlight — its dots render in amber instead
   *  of brand-color so you can see two projects side by side on the
   *  same bell. URL-driven via `?compare=` on /stats. */
  compareProject?: string | null;
  currency?: boolean;
  /** Optional channel-family label (e.g. "facebook-other") shown on
   *  hover tooltips. Master plot (project aggregate) doesn't pass
   *  one — the tooltip just shows the project name + value. */
  channelLabel?: string;
  /** What this plot is measuring — used in the hover tooltip subtitle
   *  alongside the channelLabel. Defaults to "עלות לליד". */
  metricLabel?: string;
};

const fmtIls = (n: number) =>
  "₪" + Math.round(n).toLocaleString("he-IL");

const COLOR_DOT_MUTED = "#94a3b8";
const COLOR_DOT_SELECTED = "#4338ca";
// Compare-mode second highlight — amber so it's instantly distinct
// from the brand-color "selected" project. Two highlighted projects
// = two clearly different colors on the same bell.
const COLOR_DOT_COMPARE = "#d97706";
// Same-project hover tint — when the user hovers a dot, every OTHER
// dot from the same project lights up in this softer brand tone so
// the project's monthly spread reveals at a glance.
const COLOR_DOT_PEER = "#7c6cf7";
const COLOR_MEAN = "#0891b2"; // teal — μ
const COLOR_MEDIAN = "#d97706"; // amber — חציון (distinct from μ teal)
const COLOR_CURVE = "#4338ca";
const COLOR_CURVE_FILL = "rgba(67, 56, 202, 0.16)";
// ±1σ band — "the normal range" — clearly visible indigo fill so the
// central zone reads as a coloured strip on the bell curve.
const COLOR_BAND_1SD = "rgba(67, 56, 202, 0.20)";
// ±2σ boundary — two dashed amber vertical lines at μ±2σ. NO filled
// area — a filled ReferenceArea here sits behind the curve and gets
// visually erased by the curve's own fill. The line strokes render
// on top, so the 2σ edge is always visible.
const COLOR_BAND_2SD_EDGE = "rgba(217, 119, 6, 0.85)";

/** Normal PDF. */
function normalPdf(x: number, mu: number, sigma: number): number {
  if (!sigma) return 0;
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
}

type HoveredDot = { project: string; value: number; month?: string };

export default function GaussianStripPlot({
  title,
  distribution,
  highlightProject,
  compareProject,
  currency = true,
  channelLabel,
  metricLabel = "עלות לליד",
}: Props) {
  const { stats, mean, stddev, samples } = distribution;
  // Hover state controlled here, not by Recharts (Recharts' Tooltip
  // misbehaves in ComposedChart with scatter + area on the same X axis).
  // Driving the tooltip from onMouseEnter on the actual dot SVG
  // elements removes the ambiguity entirely.
  const [hovered, setHovered] = useState<HoveredDot | null>(null);
  // The hovered dot's project name — used to tint ALL dots from the
  // same project (so the user can see one project's spread across
  // months at a glance). Cleared when no dot is hovered.
  const hoveredProject = hovered?.project || null;
  // Click → select-project navigation. Routes via the existing URL
  // contract on /stats — `?project=<name>` rewinds the page state
  // to that project's drill-down.
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const navigateToProject = (project: string) => {
    const params = new URLSearchParams(searchParams?.toString() || "");
    params.set("project", project);
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `/stats?${qs}` : "/stats");
    });
  };
  const fmt = currency
    ? fmtIls
    : (n: number) => Math.round(n).toLocaleString("he-IL");

  // X domain — wide enough for ±3σ (the bell tails decay to near-zero
  // past that) AND for the actual sample extrema. Pad the inner
  // sample range by 5% so endpoint dots don't sit on the axis line.
  const values = samples.map((s) => s.value);
  const sampleMin = values.length ? Math.min(...values) : 0;
  const sampleMax = values.length ? Math.max(...values) : 0;
  const sampleSpan = Math.max(50, sampleMax - sampleMin);
  const domainMin = Math.max(
    0,
    Math.min(sampleMin - sampleSpan * 0.05, mean - 3 * (stddev || sampleSpan / 4)),
  );
  const domainMax = Math.max(
    sampleMax + sampleSpan * 0.05,
    mean + 3 * (stddev || sampleSpan / 4),
  );

  // Sample the bell curve at 120 evenly-spaced x — enough for a smooth
  // line at typical chart widths without being wasteful.
  const curveData = useMemo(() => {
    if (!stddev) {
      // Degenerate case: no variance. Spike at the mean — render two
      // points so Area has something to fill.
      return [
        { x: mean - 1, density: 0 },
        { x: mean, density: 1 },
        { x: mean + 1, density: 0 },
      ];
    }
    const steps = 120;
    const out: Array<{ x: number; density: number }> = [];
    for (let i = 0; i <= steps; i++) {
      const x = domainMin + ((domainMax - domainMin) * i) / steps;
      out.push({ x, density: normalPdf(x, mean, stddev) });
    }
    return out;
  }, [mean, stddev, domainMin, domainMax]);

  // Peak density of the bell — used to set y-axis range so the rug
  // dots beneath don't get squashed against the floor.
  const peakDensity = useMemo(
    () => curveData.reduce((m, p) => (p.density > m ? p.density : m), 0),
    [curveData],
  );

  // When μ and M sit close together on the x-axis their top labels
  // collide. Stack the median's label above μ's whenever the two
  // values are within 12% of the visible domain — at that distance
  // the captions visibly overlap on a 600px-wide chart.
  const xRange = domainMax - domainMin || 1;
  const proximityRatio = Math.abs(mean - stats.median) / xRange;
  const stackMedianLabel = proximityRatio < 0.12;
  // dy negative = higher on screen (further from the line). We push
  // M up by ~14px so the two captions sit on two rows instead of
  // one. When they're far apart we leave dy=0 — both at the same
  // baseline, side by side, no need to stack.
  const medianLabelDy = stackMedianLabel ? -14 : 0;

  // Rug dots — laid out at their actual x values, with a small
  // negative y offset so they appear under the bell. Jittered into 3
  // lanes so even dense clusters spread vertically rather than piling
  // on top of each other. The lanes are widely spaced (~9% of peak
  // density apart) so each dot is clearly its own mark.
  const jittered = useMemo(() => {
    const lanes = [-0.12, -0.22, -0.32];
    return samples.map((s, i) => ({
      project: s.project,
      x: s.value,
      month: s.month,
      y: peakDensity * (lanes[i % 3] || -0.18),
      isSelected:
        !!highlightProject && s.project === highlightProject,
      isCompare:
        !!compareProject &&
        s.project === compareProject &&
        // Don't double-mark if compare equals selected (defensive).
        s.project !== highlightProject,
    }));
  }, [samples, highlightProject, compareProject, peakDensity]);

  // With monthly samples a selected (or compare) project can have many
  // dots (one per month). Render them all in three groups: selected
  // (brand), compare (amber), others (muted).
  const selectedSamples = jittered.filter((d) => d.isSelected);
  const compareSamples = jittered.filter((d) => d.isCompare);
  const others = jittered.filter((d) => !d.isSelected && !d.isCompare);
  const selectedFirst = selectedSamples[0] || null;
  const compareFirst = compareSamples[0] || null;

  if (!samples.length) {
    return (
      <div className="gsp-card">
        <div className="gsp-title">{title}</div>
        <div className="gsp-empty">אין מספיק דאטה להצגת התפלגות</div>
      </div>
    );
  }

  return (
    <div className="gsp-card">
      <div className="gsp-title">{title}</div>
      <div className="gsp-summary">
        <span>n = {stats.n}</span>
        <span>μ = {fmt(mean)}</span>
        <span>σ = {fmt(stddev)}</span>
        <span>חציון = {fmt(stats.median)}</span>
        {selectedFirst && (
          <span className="gsp-summary-selected">
            ● {selectedFirst.project}
            {selectedSamples.length > 1
              ? ` (${selectedSamples.length} דגימות)`
              : `: ${fmt(selectedFirst.x)}`}
            {selectedSamples.length === 1 && (
              <em>
                {" "}
                ({sigmaZ(selectedFirst.x, mean, stddev)})
              </em>
            )}
          </span>
        )}
        {compareFirst && (
          <span className="gsp-summary-compare">
            ● {compareFirst.project}
            {compareSamples.length > 1
              ? ` (${compareSamples.length} דגימות)`
              : `: ${fmt(compareFirst.x)}`}
            {compareSamples.length === 1 && (
              <em>
                {" "}
                ({sigmaZ(compareFirst.x, mean, stddev)})
              </em>
            )}
          </span>
        )}
      </div>
      <div className="gsp-chart">
        {/* Manual hover panel — driven by the dot SVG's onMouseEnter
            handlers, not Recharts' Tooltip. Sits at the top-right of
            the chart wrap so it doesn't move with the cursor (cleaner
            than a floating tooltip when dots cluster) and doesn't get
            blocked by the bell curve area. */}
        {hovered && (
          <div className="gsp-hover-panel" role="status" aria-live="polite">
            <strong>{hovered.project}</strong>
            <span className="gsp-tooltip-sub">
              {channelLabel
                ? `${channelLabel} · ${metricLabel}`
                : metricLabel}
              {hovered.month ? ` · ${hovered.month}` : ""}
            </span>
            <span>{fmt(hovered.value)}</span>
            <small>{sigmaZ(hovered.value, mean, stddev)}</small>
          </div>
        )}
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart
            data={curveData}
            margin={{
              // When the median label is stacked above μ's we need a
              // bit more top headroom so neither caption gets clipped.
              top: stackMedianLabel ? 32 : 18,
              right: 24,
              left: 24,
              bottom: 8,
            }}
          >
            <CartesianGrid stroke="rgba(127,127,127,0.10)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              domain={[domainMin, domainMax]}
              tickFormatter={(v) => fmt(v)}
              tick={{ fontSize: 11 }}
              allowDuplicatedCategory={false}
            />
            <YAxis
              type="number"
              // Bell curve gets the top ~72% of vertical space
              // (0 → 1.12 × peak); rug occupies the bottom ~28%
              // (0 → −0.42 × peak). Widening the negative range
              // means the 3 lanes of dots aren't crammed into a
              // thin strip — they get clearly separated rows.
              domain={[peakDensity * -0.42, peakDensity * 1.12]}
              hide
            />
            {/* ±1σ band — solid indigo fill marking the "normal range"
                zone. Sits BEHIND the curve area but the hue matches the
                curve so the layered blend reads as a darker indigo
                within the bell — clearly the central zone. */}
            <ReferenceArea
              x1={mean - stddev}
              x2={mean + stddev}
              fill={COLOR_BAND_1SD}
              strokeOpacity={0}
            />
            {/* ±2σ boundaries — rendered as ReferenceLines (NOT a
                filled area) because filled ReferenceAreas sit BEHIND
                the curve's own fill and get visually erased. Two thin
                dashed amber lines at μ-2σ and μ+2σ render ON TOP of
                the curve, so the boundary is always visible. */}
            <ReferenceLine
              x={mean - 2 * stddev}
              stroke={COLOR_BAND_2SD_EDGE}
              strokeDasharray="4 4"
              strokeWidth={1.4}
            />
            <ReferenceLine
              x={mean + 2 * stddev}
              stroke={COLOR_BAND_2SD_EDGE}
              strokeDasharray="4 4"
              strokeWidth={1.4}
            />
            {/* The bell curve itself */}
            <Area
              type="monotone"
              dataKey="density"
              stroke={COLOR_CURVE}
              strokeWidth={2}
              fill={COLOR_CURVE_FILL}
              isAnimationActive={false}
              dot={false}
              activeDot={false}
            />
            {/* μ line — labeled at TOP of chart in teal */}
            <ReferenceLine
              x={mean}
              stroke={COLOR_MEAN}
              strokeDasharray="4 4"
              strokeWidth={1.6}
              label={{
                value: `μ = ${fmt(mean)}`,
                position: "top",
                fill: COLOR_MEAN,
                fontSize: 11,
                fontWeight: 700,
              }}
            />
            {/* Median line — labeled at TOP alongside μ. When the two
                values sit close on the x-axis (proximityRatio < 12%)
                M's label dy shifts up by 14px so it stacks above μ's
                caption instead of overlapping it. Amber stays distinct
                from μ's teal regardless. */}
            <ReferenceLine
              x={stats.median}
              stroke={COLOR_MEDIAN}
              strokeDasharray="2 4"
              strokeWidth={1.6}
              label={{
                value: `M = ${fmt(stats.median)}`,
                position: "top",
                fill: COLOR_MEDIAN,
                fontSize: 11,
                fontWeight: 700,
                dy: medianLabelDy,
              }}
            />
            {/* Rug of other-project dots. Custom shape receives the
                full point payload as `props.payload`; we use that to
                drive the hover state directly — no Recharts Tooltip
                involved, so there's no X-axis snapping or wrong-dot
                misattribution. */}
            <Scatter
              data={others}
              fill={COLOR_DOT_MUTED}
              isAnimationActive={false}
              dataKey="y"
              shape={(props: {
                cx?: number;
                cy?: number;
                payload?: { project: string; x: number; month?: string };
              }) => {
                // Tint when the hovered dot belongs to the SAME project
                // — visually groups all monthly samples of one project.
                const isPeer =
                  hoveredProject !== null &&
                  props.payload?.project === hoveredProject;
                return (
                  <circle
                    cx={props.cx || 0}
                    cy={props.cy || 0}
                    r={isPeer ? 6 : 5.5}
                    fill={isPeer ? COLOR_DOT_PEER : COLOR_DOT_MUTED}
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => {
                      if (props.payload) {
                        setHovered({
                          project: props.payload.project,
                          value: props.payload.x,
                          month: props.payload.month,
                        });
                      }
                    }}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => {
                      if (props.payload?.project) {
                        navigateToProject(props.payload.project);
                      }
                    }}
                  />
                );
              }}
            />
            {/* Compare project — drawn BEFORE selected so when both are
                in the same X bin, selected sits on top. Amber color
                clearly distinguishes it from the brand-color selected
                project so the user can see "Iris vs Essence" at a
                glance on every bell. */}
            {compareSamples.length > 0 && (
              <Scatter
                data={compareSamples}
                fill={COLOR_DOT_COMPARE}
                isAnimationActive={false}
                dataKey="y"
                shape={(props: {
                  cx?: number;
                  cy?: number;
                  payload?: { project: string; x: number; month?: string };
                }) => (
                  <circle
                    cx={props.cx || 0}
                    cy={props.cy || 0}
                    r={6.5}
                    fill={COLOR_DOT_COMPARE}
                    stroke="#fff"
                    strokeWidth={1.5}
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => {
                      if (props.payload) {
                        setHovered({
                          project: props.payload.project,
                          value: props.payload.x,
                          month: props.payload.month,
                        });
                      }
                    }}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => {
                      if (props.payload?.project) {
                        navigateToProject(props.payload.project);
                      }
                    }}
                  />
                )}
              />
            )}
            {/* Selected project — drawn last so it sits on top. Bigger
                radius (7px) + a darker ring so it's instantly visible
                amid the gray dots. */}
            {selectedSamples.length > 0 && (
              <Scatter
                data={selectedSamples}
                fill={COLOR_DOT_SELECTED}
                isAnimationActive={false}
                dataKey="y"
                shape={(props: {
                  cx?: number;
                  cy?: number;
                  payload?: { project: string; x: number; month?: string };
                }) => (
                  <circle
                    cx={props.cx || 0}
                    cy={props.cy || 0}
                    r={7}
                    fill={COLOR_DOT_SELECTED}
                    stroke="#fff"
                    strokeWidth={2}
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() => {
                      if (props.payload) {
                        setHovered({
                          project: props.payload.project,
                          value: props.payload.x,
                          month: props.payload.month,
                        });
                      }
                    }}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => {
                      if (props.payload?.project) {
                        navigateToProject(props.payload.project);
                      }
                    }}
                  />
                )}
              />
            )}
            {/* No <Tooltip /> here — see top of file. We render a
                manual hover panel above the ResponsiveContainer below
                the chart wrap. */}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function sigmaZ(value: number, mean: number, stddev: number): string {
  if (!stddev) return "—";
  const z = (value - mean) / stddev;
  const sign = z >= 0 ? "+" : "";
  const abs = Math.abs(z);
  const tone = abs < 1 ? "תקין" : abs < 2 ? "מעל הממוצע" : "חריג";
  return `${sign}${z.toFixed(2)}σ · ${tone}`;
}
