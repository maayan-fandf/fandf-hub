"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PortfolioBenchmarks } from "@/lib/portfolioBenchmarks";

/**
 * Portfolio time-trend chart. For each month present in the data,
 * computes the median of the selected metric across ALL projects with
 * a sample in that month. Answers "is my book of business getting more
 * expensive, cheaper, or steady over the year?"
 *
 * Limit to the last 24 months so the x-axis stays readable.
 *
 * Also overlays a portfolio-wide "all-time" reference line (the
 * lifetime median) so the user sees direction-of-travel against the
 * long-run anchor.
 */

const METRIC_LABELS: Record<"cpl" | "cps" | "cpm", string> = {
  cpl: "עלות לליד",
  cps: "עלות לתיאום",
  cpm: "עלות לביצוע",
};

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
  metric: "cpl" | "cps" | "cpm";
  monthsBack?: number;
}) {
  const { data, lifetimeMedian } = useMemo(() => {
    const samples = benchmarks.project[metric].samples;
    // Group monthly samples by their YYYY-MM key. Skip "current" since
    // it's not a calendar month — the trend is about time evolution.
    const byMonth = new Map<string, number[]>();
    for (const s of samples) {
      if (s.period === "current") continue;
      if (!/^\d{4}-\d{2}$/.test(s.period)) continue;
      const list = byMonth.get(s.period) || [];
      list.push(s.value);
      byMonth.set(s.period, list);
    }
    // Sort months ascending and keep the last N.
    const months = Array.from(byMonth.keys()).sort();
    const trimmed = months.slice(-monthsBack);
    const data = trimmed.map((m) => {
      const values = byMonth.get(m) || [];
      return {
        month: m,
        median: median(values),
        n: values.length,
      };
    });
    // Lifetime median across ALL samples — reference line.
    const allValues: number[] = [];
    byMonth.forEach((list) => allValues.push(...list));
    return {
      data,
      lifetimeMedian: allValues.length ? median(allValues) : 0,
    };
  }, [benchmarks.project, metric, monthsBack]);

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
          📈 מגמת התיק — חציון {METRIC_LABELS[metric]}
        </h2>
        <span className={`stats-trend-badge ${trendTone}`}>
          {trendArrow} {pctChange >= 0 ? "+" : ""}
          {pctChange.toFixed(1)}% ב-{data.length} חודשים
        </span>
      </div>
      <div className="stats-trend-meta">
        חציון כל הזמן (קו ייחוס): <b>{fmtIls(lifetimeMedian)}</b> · n ליד
        כל נקודה = מספר הפרויקטים שתרמו דגימה באותו חודש
      </div>
      <div className="stats-trend-chart">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={data} margin={{ top: 12, right: 20, left: 20, bottom: 4 }}>
            <CartesianGrid stroke="rgba(127,127,127,0.10)" strokeDasharray="3 3" />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
            <YAxis
              tickFormatter={(v) => fmtIls(v)}
              tick={{ fontSize: 11 }}
              domain={["auto", "auto"]}
            />
            <Tooltip
              labelStyle={{ direction: "rtl", color: "#1f2937" }}
              contentStyle={{ background: "white", border: "1px solid #e5e7eb" }}
              formatter={(value, name, item) => {
                if (name === "median") {
                  const p = item.payload as { n: number };
                  return [`${fmtIls(Number(value) || 0)} (n=${p.n})`, "חציון"];
                }
                return [fmtIls(Number(value) || 0), name];
              }}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="median"
              name={`חציון התיק — ${METRIC_LABELS[metric]}`}
              stroke="#4338ca"
              strokeWidth={2.5}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
            {/* Reference line — drawn as a fake horizontal series so it
                shows up in the legend and has tooltip parity. */}
            <Line
              type="linear"
              dataKey={() => lifetimeMedian}
              name="חציון לטווח ארוך"
              stroke="#0891b2"
              strokeWidth={1.5}
              strokeDasharray="6 4"
              dot={false}
              activeDot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
