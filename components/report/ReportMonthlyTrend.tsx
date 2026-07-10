"use client";

import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { useChartPalette } from "@/lib/chartTheme";
import {
  fmtInt,
  fmtILS,
  type MonthlyChannelRow,
  type ProjectReportData,
} from "@/lib/reportShared";

/**
 * Historical monthly trend — native rebuild of the legacy "מגמה
 * היסטורית" section (updateMonthly / aggregateMonthly, Index.html:6079):
 * per-metric trend cards (עלות / לידים / תיאומים / ביצועים — period
 * total, month sparkline, month-over-month delta) + a unit-cost line
 * chart (עלות לליד / לתיאום / לביצוע over months), with a channel
 * multi-select filter. Aggregates the per-channel monthly rows client-
 * side so the filter is instant.
 */

type MonthAgg = {
  month: string;
  spend: number;
  leads: number;
  scheduled: number;
  meetings: number;
  costPerLead: number;
  costPerScheduled: number;
  costPerMeeting: number;
};

function aggregate(
  rows: MonthlyChannelRow[],
  channels: Set<string> | null,
): MonthAgg[] {
  const byMonth = new Map<string, MonthAgg>();
  for (const r of rows) {
    if (channels && !channels.has(r.channel)) continue;
    const m =
      byMonth.get(r.month) ??
      {
        month: r.month,
        spend: 0,
        leads: 0,
        scheduled: 0,
        meetings: 0,
        costPerLead: 0,
        costPerScheduled: 0,
        costPerMeeting: 0,
      };
    m.spend += r.spend;
    m.leads += r.leads;
    m.scheduled += r.scheduled;
    m.meetings += r.meetings;
    byMonth.set(r.month, m);
  }
  return [...byMonth.values()]
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((m) => ({
      ...m,
      costPerLead: m.leads > 0 ? m.spend / m.leads : 0,
      costPerScheduled: m.scheduled > 0 ? m.spend / m.scheduled : 0,
      costPerMeeting: m.meetings > 0 ? m.spend / m.meetings : 0,
    }));
}

function monthLabelHe(mk: string): string {
  const [y, m] = mk.split("-");
  return `${m}/${y.slice(2)}`;
}

const METRICS = [
  { key: "spend" as const, label: "עלות", color: "#14b8a6", money: true },
  { key: "leads" as const, label: "לידים", color: "#6366f1", money: false },
  { key: "scheduled" as const, label: "תיאומים", color: "#ec4899", money: false },
  { key: "meetings" as const, label: "ביצועים", color: "#f5576c", money: false },
];

/** Tiny inline sparkline. */
function Spark({ vals, color }: { vals: number[]; color: string }) {
  if (vals.length < 2) return null;
  const W = 120;
  const H = 30;
  const max = Math.max(...vals, 1);
  const pts = vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * W;
      const y = H - 2 - (v / max) * (H - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="rpt-mt-spark">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} />
      <circle
        cx={W}
        cy={H - 2 - (vals[vals.length - 1] / max) * (H - 4)}
        r={2.5}
        fill={color}
      />
    </svg>
  );
}

function MetricCard({
  metric,
  agg,
}: {
  metric: (typeof METRICS)[number];
  agg: MonthAgg[];
}) {
  const vals = agg.map((m) => m[metric.key]);
  const total = vals.reduce((s, v) => s + v, 0);
  // MoM delta between the last two months that have activity.
  const last = vals[vals.length - 1] ?? 0;
  const prev = vals[vals.length - 2] ?? 0;
  const delta = prev > 0 ? (last - prev) / prev : null;
  const fmt = metric.money ? fmtILS : fmtInt;
  return (
    <div className="rpt-mt-card">
      <div className="rpt-mt-head">
        <span className="rpt-mt-label">{metric.label}</span>
        <span className="rpt-mt-total">{fmt(total)}</span>
        {delta !== null && Math.abs(delta) >= 0.01 && (
          <span
            className={"rpt-mt-delta " + (delta >= 0 ? "is-up" : "is-down")}
            title={`חודש מול חודש קודם: ${fmt(prev)} → ${fmt(last)}`}
          >
            {delta >= 0 ? "▲" : "▼"} {Math.abs(Math.round(delta * 100))}%
          </span>
        )}
      </div>
      <Spark vals={vals} color={metric.color} />
    </div>
  );
}

export default function ReportMonthlyTrend({
  data,
}: {
  data: ProjectReportData;
}) {
  const pal = useChartPalette();
  const rows = data.monthlyRaw;
  const allChannels = useMemo(
    () => [...new Set(rows.map((r) => r.channel))].filter(Boolean).sort(),
    [rows],
  );
  const [selected, setSelected] = useState<Set<string> | null>(null); // null = all
  const [open, setOpen] = useState(false);

  const agg = useMemo(() => aggregate(rows, selected), [rows, selected]);

  if (!rows.length) return null;

  const toggle = (ch: string) => {
    setSelected((cur) => {
      const base = cur ?? new Set(allChannels);
      const next = new Set(base);
      if (next.has(ch)) next.delete(ch);
      else next.add(ch);
      if (next.size === 0) return new Set(allChannels); // never empty
      if (next.size === allChannels.length) return null; // all → null
      return next;
    });
  };
  const filterLabel =
    selected === null
      ? `כל הערוצים (${allChannels.length})`
      : `${selected.size} ערוצים`;

  const cplLines = [
    { key: "costPerLead" as const, label: "עלות לליד", color: "#6366f1" },
    { key: "costPerScheduled" as const, label: "עלות לתיאום", color: "#ec4899" },
    { key: "costPerMeeting" as const, label: "עלות לביצוע", color: "#f5576c" },
  ];
  const chartData = agg.map((m) => ({
    month: monthLabelHe(m.month),
    costPerLead: Math.round(m.costPerLead),
    costPerScheduled: Math.round(m.costPerScheduled),
    costPerMeeting: Math.round(m.costPerMeeting),
  }));

  return (
    <section className="rpt-monthly">
      <div className="rpt-mt-title-row">
        <div className="rpt-mt-section-title">📈 מגמה היסטורית</div>
        {allChannels.length > 1 && (
          <div className="rpt-mt-filter">
            <button
              type="button"
              className="rpt-mt-filter-btn"
              onClick={() => setOpen((o) => !o)}
            >
              סינון לפי ערוץ: {filterLabel} ▾
            </button>
            {open && (
              <div className="rpt-mt-filter-panel">
                <button
                  type="button"
                  className="rpt-mt-filter-opt is-all"
                  onClick={() => setSelected(null)}
                >
                  כל הערוצים
                </button>
                {allChannels.map((ch) => {
                  const on = selected === null || selected.has(ch);
                  return (
                    <label key={ch} className="rpt-mt-filter-opt">
                      <input type="checkbox" checked={on} onChange={() => toggle(ch)} />
                      {ch}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rpt-mt-cards">
        {METRICS.map((m) => (
          <MetricCard key={m.key} metric={m} agg={agg} />
        ))}
      </div>

      {chartData.length >= 2 && (
        <div className="rpt-mt-chart-box">
          <h4>מגמה חודשית — עלויות יחידה</h4>
          <div className="rpt-trend-chart" dir="ltr">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={pal.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: pal.tick, fontSize: 11 }} />
                <YAxis
                  tick={{ fill: pal.tick, fontSize: 11 }}
                  width={52}
                  tickFormatter={(v: number) => fmtILS(v)}
                />
                <Tooltip
                  contentStyle={{
                    background: pal.tooltipBg,
                    border: `1px solid ${pal.tooltipBorder}`,
                    borderRadius: 8,
                    color: pal.tooltipInk,
                    fontSize: 12,
                    direction: "rtl",
                  }}
                  formatter={(value, name) => [fmtILS(Number(value) || 0), String(name)]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {cplLines.map((l) => (
                  <Line
                    key={l.key}
                    type="monotone"
                    dataKey={l.key}
                    name={l.label}
                    stroke={l.color}
                    strokeWidth={2.5}
                    dot={{ r: 3 }}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  );
}
