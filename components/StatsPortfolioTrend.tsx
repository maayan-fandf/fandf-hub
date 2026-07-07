"use client";

import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PortfolioBenchmarks } from "@/lib/portfolioBenchmarks";
import { useChartPalette } from "@/lib/chartTheme";
import { trendSeries, METRIC_LABELS, type Metric } from "@/lib/statsInsights";

/**
 * Portfolio time-trend chart. For each month, the median of the
 * selected metric across all projects with a sample that month, wrapped
 * in the P25–P75 interquartile band — so the book reads as a
 * distribution moving through time, not a single line. A dashed
 * reference line anchors the lifetime median.
 *
 * 2026-07 overhaul: added the IQR band, solid hairline grid (dashed
 * grid reads as threshold/projection), theme-aware palette
 * (lib/chartTheme — the hardcoded indigo was 2:1 against the dark
 * surface).
 */

const fmtIls = (n: number) =>
  n > 0 ? "₪" + Math.round(n).toLocaleString("he-IL") : "—";

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export default function StatsPortfolioTrend({
  benchmarks,
  metric,
  monthsBack = 24,
}: {
  benchmarks: PortfolioBenchmarks;
  metric: Metric;
  monthsBack?: number;
}) {
  const pal = useChartPalette();

  const { data, lifetimeMedian } = useMemo(() => {
    const series = trendSeries(benchmarks, metric, monthsBack);
    // Recharts renders the band as a stacked pair: an invisible base at
    // P25 + a wash of height (P75 − P25) on top of it.
    const data = series.map((p) => ({
      ...p,
      bandBase: p.p25,
      bandSpan: Math.max(p.p75 - p.p25, 0),
    }));
    const lifetimeMedian = median(
      benchmarks.project[metric].samples
        .filter((s) => /^\d{4}-\d{2}$/.test(s.period))
        .map((s) => s.value),
    );
    return { data, lifetimeMedian };
  }, [benchmarks, metric, monthsBack]);

  if (data.length < 2) {
    // Need at least two months to show a trend.
    return null;
  }

  // Direction of travel — first vs last month change, percent.
  const firstVal = data[0].median;
  const lastVal = data[data.length - 1].median;
  const pctChange =
    firstVal > 0 ? ((lastVal - firstVal) / firstVal) * 100 : 0;
  const trendArrow = pctChange > 5 ? "↗" : pctChange < -5 ? "↘" : "→";
  const trendTone =
    pctChange > 5
      ? "stats-trend-up"
      : pctChange < -5
        ? "stats-trend-down"
        : "stats-trend-flat";

  return (
    <section className="stats-section">
      <div className="stats-section-head">
        <h2 style={{ margin: 0 }}>
          📈 מגמת התיק — {METRIC_LABELS[metric]}
        </h2>
        <span className={`stats-trend-badge ${trendTone}`}>
          {trendArrow} {pctChange >= 0 ? "+" : ""}
          {pctChange.toFixed(1)}% ב-{data.length} חודשים
        </span>
      </div>
      <div className="stats-trend-meta">
        הרצועה = P25–P75 (חצי מהתיק בתוכה) · הקו = חציון · קו מקווקו =
        חציון כל הזמן ({fmtIls(lifetimeMedian)})
      </div>
      <div className="stats-trend-chart">
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart
            data={data}
            margin={{ top: 12, right: 20, left: 20, bottom: 4 }}
          >
            <CartesianGrid stroke={pal.grid} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: pal.tick }} />
            <YAxis
              tickFormatter={(v) => fmtIls(v)}
              tick={{ fontSize: 11, fill: pal.tick }}
              domain={["auto", "auto"]}
            />
            <Tooltip
              labelStyle={{ direction: "rtl", color: pal.tooltipInk }}
              contentStyle={{
                background: pal.tooltipBg,
                border: `1px solid ${pal.tooltipBorder}`,
                color: pal.tooltipInk,
              }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as {
                  median: number;
                  p25: number;
                  p75: number;
                  n: number;
                };
                return (
                  <div className="gsp-tooltip">
                    <strong>{String(label)}</strong>
                    <span>חציון: {fmtIls(p.median)}</span>
                    <span>
                      P25–P75: {fmtIls(p.p25)}–{fmtIls(p.p75)}
                    </span>
                    <span>n = {p.n} פרויקטים</span>
                  </div>
                );
              }}
            />
            <Legend />
            {/* IQR band — stacked invisible base + wash. */}
            <Area
              dataKey="bandBase"
              stackId="iqr"
              stroke="none"
              fill="transparent"
              isAnimationActive={false}
              legendType="none"
              tooltipType="none"
              name="__base"
              activeDot={false}
            />
            <Area
              dataKey="bandSpan"
              stackId="iqr"
              stroke="none"
              fill={pal.wash}
              isAnimationActive={false}
              name="טווח P25–P75"
              legendType="square"
              tooltipType="none"
              activeDot={false}
            />
            <Line
              type="monotone"
              dataKey="median"
              name={`חציון התיק — ${METRIC_LABELS[metric]}`}
              stroke={pal.accent}
              strokeWidth={2}
              dot={{ r: 3, strokeWidth: 2, stroke: pal.tooltipBg }}
              activeDot={{ r: 5 }}
            />
            {/* Lifetime-median reference — de-emphasized chrome, not a
                series: gray + dashed (dashing here MEANS reference). */}
            <Line
              type="linear"
              dataKey={() => lifetimeMedian}
              name="חציון כל הזמן"
              stroke={pal.deemph}
              strokeWidth={1.5}
              strokeDasharray="6 4"
              dot={false}
              activeDot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
