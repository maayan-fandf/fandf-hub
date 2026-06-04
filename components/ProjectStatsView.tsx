"use client";

import { useMemo, useState } from "react";
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
import type { ProjectMetrics } from "@/lib/appsScript";

/**
 * Client-side stats view. Phase 1: historical trend (monthly mini-charts
 * folded into one chart with selectable metric + channel-multi). Phase
 * 2/3 will add diagnosis, scatter, bars, top-funnel (tasks #59, #60).
 *
 * Data: ProjectMetrics.monthlyRaw — same shape the dashboard uses, one
 * row per (calendar-month × channel) with spend/leads/scheduled/meetings
 * /budget/relevant. Aggregated client-side here so the user can flip
 * channels without a round-trip.
 */

type Props = { project: ProjectMetrics };

type MetricKey = "spend" | "leads" | "scheduled" | "meetings" | "cpl" | "cps";

const METRIC_DEFS: Array<{
  key: MetricKey;
  label: string;
  unit: "₪" | "#";
  /** Derived metrics (cpl/cps) need a divisor to be computed per month. */
  derived?: { numerator: keyof MonthAgg; denominator: keyof MonthAgg };
}> = [
  { key: "spend", label: "עלות", unit: "₪" },
  { key: "leads", label: "לידים", unit: "#" },
  { key: "scheduled", label: "תיאומים", unit: "#" },
  { key: "meetings", label: "ביצועים", unit: "#" },
  {
    key: "cpl",
    label: "עלות לליד",
    unit: "₪",
    derived: { numerator: "spend", denominator: "leads" },
  },
  {
    key: "cps",
    label: "עלות לתיאום",
    unit: "₪",
    derived: { numerator: "spend", denominator: "scheduled" },
  },
];

type MonthAgg = {
  month: string;
  spend: number;
  leads: number;
  scheduled: number;
  meetings: number;
  budget: number;
};

const fmtIls = (n: number) =>
  "₪" + Math.round(n).toLocaleString("he-IL");
const fmtNum = (n: number) => Math.round(n).toLocaleString("he-IL");

function monthSort(a: string, b: string) {
  return a.localeCompare(b);
}

/**
 * Aggregate monthlyRaw to a per-month series, filtered by `channels`
 * (a Set of lowercased channel names, or null for "all channels").
 */
function aggregateMonthly(
  rows: ProjectMetrics["monthlyRaw"],
  channels: Set<string> | null,
): MonthAgg[] {
  const byMonth: Record<string, MonthAgg> = {};
  for (const r of rows) {
    if (channels) {
      const ch = String(r.channel || "").toLowerCase().trim();
      if (!channels.has(ch)) continue;
    }
    const m = r.month;
    if (!m) continue;
    if (!byMonth[m]) {
      byMonth[m] = {
        month: m,
        spend: 0,
        leads: 0,
        scheduled: 0,
        meetings: 0,
        budget: 0,
      };
    }
    byMonth[m].spend += Number(r.spend) || 0;
    byMonth[m].leads += Number(r.leads) || 0;
    byMonth[m].scheduled += Number(r.scheduled) || 0;
    byMonth[m].meetings += Number(r.meetings) || 0;
    byMonth[m].budget += Number(r.budget) || 0;
  }
  return Object.values(byMonth).sort((a, b) => monthSort(a.month, b.month));
}

/** Per-month value for the selected metric. Returns null for "no data"
 *  so derived metrics (cpl, cps) gap the line instead of plotting 0s. */
function metricValue(row: MonthAgg, metric: MetricKey): number | null {
  const def = METRIC_DEFS.find((d) => d.key === metric);
  if (!def) return null;
  if (def.derived) {
    const num = row[def.derived.numerator] as number;
    const den = row[def.derived.denominator] as number;
    if (!den) return null;
    return num / den;
  }
  return row[metric as keyof MonthAgg] as number;
}

export default function ProjectStatsView({ project }: Props) {
  // All channels in the project's monthly data — used for the filter
  // checkboxes. Sorted by total spend desc so the heavy hitters are
  // first.
  const allChannels = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const r of project.monthlyRaw || []) {
      const ch = String(r.channel || "").trim() || "—";
      totals[ch] = (totals[ch] || 0) + (Number(r.spend) || 0);
    }
    return Object.entries(totals)
      .sort(([, a], [, b]) => b - a)
      .map(([ch]) => ch);
  }, [project.monthlyRaw]);

  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(
    () => new Set(allChannels.map((c) => c.toLowerCase())),
  );
  const [metric, setMetric] = useState<MetricKey>("spend");

  const allSelected = selectedChannels.size === allChannels.length;

  const series = useMemo(() => {
    const filtered = allSelected
      ? aggregateMonthly(project.monthlyRaw || [], null)
      : aggregateMonthly(project.monthlyRaw || [], selectedChannels);
    return filtered.map((row) => ({
      month: row.month,
      value: metricValue(row, metric),
    }));
  }, [project.monthlyRaw, selectedChannels, metric, allSelected]);

  // Comparison series ("אחרים") — only when the user has narrowed the
  // filter. Computes the same metric for the OTHER channels, so the
  // chart shows the selected slice in relation to the rest.
  const othersSeries = useMemo(() => {
    if (allSelected) return null;
    const otherSet = new Set(
      allChannels
        .filter((c) => !selectedChannels.has(c.toLowerCase()))
        .map((c) => c.toLowerCase()),
    );
    if (otherSet.size === 0) return null;
    const rows = aggregateMonthly(project.monthlyRaw || [], otherSet);
    return rows.map((row) => ({
      month: row.month,
      value: metricValue(row, metric),
    }));
  }, [project.monthlyRaw, selectedChannels, metric, allSelected, allChannels]);

  // Merge series into one array Recharts expects.
  const chartData = useMemo(() => {
    const byMonth: Record<string, { month: string; selected: number | null; others: number | null }> =
      {};
    for (const r of series) {
      byMonth[r.month] = byMonth[r.month] || {
        month: r.month,
        selected: null,
        others: null,
      };
      byMonth[r.month].selected = r.value;
    }
    if (othersSeries) {
      for (const r of othersSeries) {
        byMonth[r.month] = byMonth[r.month] || {
          month: r.month,
          selected: null,
          others: null,
        };
        byMonth[r.month].others = r.value;
      }
    }
    return Object.values(byMonth).sort((a, b) => monthSort(a.month, b.month));
  }, [series, othersSeries]);

  const toggleChannel = (ch: string) => {
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      const lc = ch.toLowerCase();
      if (next.has(lc)) next.delete(lc);
      else next.add(lc);
      return next;
    });
  };
  const toggleAll = () => {
    setSelectedChannels(
      allSelected ? new Set() : new Set(allChannels.map((c) => c.toLowerCase())),
    );
  };

  const metricDef = METRIC_DEFS.find((d) => d.key === metric)!;
  const isCurrency = metricDef.unit === "₪";

  return (
    <div className="stats-view">
      {/* Hero — totals summary */}
      <section className="stats-section">
        <h2>סיכום תקופה</h2>
        <div className="stats-totals">
          <div className="stats-total-card">
            <div className="stats-total-label">תקציב</div>
            <div className="stats-total-value">{fmtIls(project.totals.budget)}</div>
          </div>
          <div className="stats-total-card">
            <div className="stats-total-label">עלות</div>
            <div className="stats-total-value">{fmtIls(project.totals.spend)}</div>
          </div>
          <div className="stats-total-card">
            <div className="stats-total-label">לידים</div>
            <div className="stats-total-value">{fmtNum(project.totals.leads)}</div>
          </div>
          <div className="stats-total-card">
            <div className="stats-total-label">תיאומים</div>
            <div className="stats-total-value">{fmtNum(project.totals.scheduled)}</div>
          </div>
          <div className="stats-total-card">
            <div className="stats-total-label">ביצועים</div>
            <div className="stats-total-value">{fmtNum(project.totals.meetings)}</div>
          </div>
          {project.totals.costPerLead > 0 && (
            <div className="stats-total-card">
              <div className="stats-total-label">עלות לליד</div>
              <div className="stats-total-value">
                {fmtIls(project.totals.costPerLead)}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Historical trend */}
      <section className="stats-section">
        <h2>📈 מגמה היסטורית</h2>
        <div className="stats-controls">
          <div className="stats-controls-group">
            <label className="stats-controls-label">מטריקה:</label>
            <div className="stats-metric-pills">
              {METRIC_DEFS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={
                    "stats-pill" + (metric === m.key ? " is-active" : "")
                  }
                  onClick={() => setMetric(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="stats-controls-group">
            <label className="stats-controls-label">ערוצים:</label>
            <button
              type="button"
              className={
                "stats-pill" + (allSelected ? " is-active" : "")
              }
              onClick={toggleAll}
            >
              {allSelected ? "✓ הכל" : "סמן הכל"}
            </button>
            {allChannels.map((ch) => {
              const isOn = selectedChannels.has(ch.toLowerCase());
              return (
                <button
                  key={ch}
                  type="button"
                  className={"stats-pill" + (isOn ? " is-active" : "")}
                  onClick={() => toggleChannel(ch)}
                >
                  {ch}
                </button>
              );
            })}
          </div>
        </div>
        <div className="stats-chart-wrap">
          {chartData.length === 0 ? (
            <div className="stats-empty">אין נתונים היסטוריים לטווח הנבחר</div>
          ) : (
            <ResponsiveContainer width="100%" height={360}>
              <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="rgba(127,127,127,0.18)" strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis
                  tick={{ fontSize: 12 }}
                  tickFormatter={(v) => (isCurrency ? "₪" + Math.round(v).toLocaleString("he-IL") : Math.round(v).toLocaleString("he-IL"))}
                />
                <Tooltip
                  formatter={(value) => {
                    if (value == null || typeof value !== "number") return "—";
                    return isCurrency ? fmtIls(value) : fmtNum(value);
                  }}
                  labelStyle={{ direction: "rtl" }}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="selected"
                  name={
                    allSelected
                      ? "סה״כ — " + metricDef.label
                      : "נבחר — " + metricDef.label
                  }
                  stroke="#4338ca"
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                  connectNulls={false}
                />
                {othersSeries && (
                  <Line
                    type="monotone"
                    dataKey="others"
                    name="אחרים"
                    stroke="#94a3b8"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={{ r: 2 }}
                    connectNulls={false}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {/* Phase 2 + 3 placeholders */}
      <section className="stats-section">
        <h2>אבחון מדיה בתשלום</h2>
        <div className="stats-empty">בשלב פיתוח — יוצג בקרוב.</div>
      </section>
      <section className="stats-section">
        <h2>יעילות ערוצים</h2>
        <div className="stats-empty">
          תרשימי scatter + bar — יוצגו בשלב הבא.
        </div>
      </section>
    </div>
  );
}
