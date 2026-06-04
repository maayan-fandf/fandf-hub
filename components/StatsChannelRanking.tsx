"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PortfolioBenchmarks } from "@/lib/portfolioBenchmarks";

/**
 * Channel-family ranking bar chart — horizontal bars sorted from
 * cheapest to most-expensive median for the selected metric. Each bar
 * is labeled with `n=N` (sample count) so the user sees data richness
 * at a glance. Answers "which channel family is delivering best CPL
 * across my portfolio?"
 *
 * Filters out families with very small samples (n < 3) so the chart
 * isn't dominated by single-observation noise.
 */

const METRIC_LABELS: Record<"cpl" | "cps" | "cpm", string> = {
  cpl: "עלות לליד",
  cps: "עלות לתיאום",
  cpm: "עלות לביצוע",
};
const fmtIls = (n: number) => "₪" + Math.round(n).toLocaleString("he-IL");

// Gradient from cheap (green-blue) → expensive (red-orange). Maps a
// rank index 0..N-1 onto a colour ramp so the leftmost (cheapest) bar
// is green and the rightmost (most expensive) bar is red.
function colorForRank(idx: number, total: number): string {
  if (total <= 1) return "#4338ca";
  const t = idx / (total - 1); // 0 = cheap, 1 = expensive
  // Interpolate green → amber → red.
  if (t < 0.5) {
    // Green (#16a34a) → Amber (#d97706)
    const k = t / 0.5;
    return interpolate("#16a34a", "#d97706", k);
  }
  const k = (t - 0.5) / 0.5;
  return interpolate("#d97706", "#dc2626", k);
}

function interpolate(c1: string, c2: string, t: number): string {
  const r1 = parseInt(c1.slice(1, 3), 16);
  const g1 = parseInt(c1.slice(3, 5), 16);
  const b1 = parseInt(c1.slice(5, 7), 16);
  const r2 = parseInt(c2.slice(1, 3), 16);
  const g2 = parseInt(c2.slice(3, 5), 16);
  const b2 = parseInt(c2.slice(5, 7), 16);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r},${g},${b})`;
}

export default function StatsChannelRanking({
  benchmarks,
  metric,
}: {
  benchmarks: PortfolioBenchmarks;
  metric: "cpl" | "cps" | "cpm";
}) {
  const data = useMemo(() => {
    return Object.entries(benchmarks.channels)
      .map(([alias, c]) => ({
        alias,
        median: c[metric].stats.median,
        n: c[metric].stats.n,
      }))
      .filter((d) => d.n >= 3 && d.median > 0)
      .sort((a, b) => a.median - b.median);
  }, [benchmarks.channels, metric]);

  if (data.length === 0) return null;

  return (
    <section className="stats-section">
      <div className="stats-section-head">
        <h2 style={{ margin: 0 }}>
          📊 דירוג ערוצים — חציון {METRIC_LABELS[metric]}
        </h2>
        <span className="stats-channel-ranking-meta">
          זול → יקר · נכלל רק n ≥ 3
        </span>
      </div>
      <div className="stats-channel-ranking-chart">
        <ResponsiveContainer width="100%" height={Math.max(220, data.length * 36)}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 8, right: 60, left: 8, bottom: 8 }}
          >
            <CartesianGrid
              stroke="rgba(127,127,127,0.10)"
              strokeDasharray="3 3"
              horizontal={false}
            />
            <XAxis
              type="number"
              tickFormatter={(v) => fmtIls(v)}
              tick={{ fontSize: 11 }}
            />
            <YAxis
              type="category"
              dataKey="alias"
              tick={{ fontSize: 12 }}
              width={130}
            />
            <Tooltip
              contentStyle={{
                background: "white",
                border: "1px solid #e5e7eb",
                direction: "rtl",
              }}
              formatter={(value, _name, item) => {
                const p = item.payload as { n: number };
                return [`${fmtIls(Number(value) || 0)} · n=${p.n}`, "חציון"];
              }}
              labelFormatter={(label) => String(label)}
            />
            <Bar dataKey="median" radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {data.map((d, idx) => (
                <Cell key={d.alias} fill={colorForRank(idx, data.length)} />
              ))}
              <LabelList
                dataKey="n"
                position="right"
                formatter={(v) => `n=${String(v ?? "")}`}
                style={{ fill: "#64748b", fontSize: 11 }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
