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
import type { DiagnosisCard } from "@/lib/paidDiagnosis";

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

type Props = {
  project: ProjectMetrics;
  /** Server-computed paid-channels diagnosis cards (priority-sorted).
   *  Empty array = no signals fired. */
  diagnosis: DiagnosisCard[];
  /** Periods (YYYY-MM strings) selected at the page level. null /
   *  empty = "all months" (the URL-default state). The "סיכום תקופה"
   *  totals + the historical trend chart respect this filter so
   *  picking 2 specific months shows just their cumulative. */
  selectedPeriods?: string[] | null;
};

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

export default function ProjectStatsView({
  project,
  diagnosis,
  selectedPeriods,
}: Props) {
  // Period summary aggregates from monthlyRaw, NOT project.totals.
  // project.totals is the campaign's CURRENT-row snapshot (live state
  // of in-flight channels), which is what the dashboard's old hero
  // showed — but here the section is labeled "סיכום תקופה" and the
  // page exposes a multi-month period picker, so the right semantic
  // is "cumulative across the selected months". For עוז בלנד the
  // discrepancy was 100× on scheduled (2 vs 111) and 9× on spend
  // (₪47k vs ₪422k) — diagnosed 2026-06-06 via React fiber probe
  // when owner circled תיאומים=2 as visibly wrong.
  //
  // selectedPeriods=null means "all months in monthlyRaw" (matches
  // the URL-default "כל החודשים" picker state). selectedPeriods=[]
  // (explicit empty) also collapses to "all" — there's no UI path
  // to selecting zero periods.
  //
  // Budget falls back to project.totals.budget because monthlyRaw
  // rows don't carry per-month budget (campaign-life budget is a
  // property of the campaign, not a period-cumulative count).
  const periodTotals = useMemo(() => {
    const rows = project.monthlyRaw || [];
    const periodSet =
      selectedPeriods && selectedPeriods.length > 0
        ? new Set(selectedPeriods)
        : null;
    let spend = 0;
    let leads = 0;
    let scheduled = 0;
    let meetings = 0;
    let relevant = 0;
    let matchedRows = 0;
    for (const r of rows) {
      const month = String(r.month || "").trim();
      if (periodSet && !periodSet.has(month)) continue;
      spend += Number(r.spend) || 0;
      leads += Number(r.leads) || 0;
      scheduled += Number(r.scheduled) || 0;
      meetings += Number(r.meetings) || 0;
      relevant += Number((r as { relevant?: number }).relevant) || 0;
      matchedRows++;
    }
    // No monthlyRaw rows (or none in the picked months) → fall back
    // to the campaign snapshot so the card doesn't show zeros for a
    // project that DOES have data, just nothing in the picked range.
    if (matchedRows === 0) {
      return {
        budget: project.totals.budget,
        spend: project.totals.spend,
        leads: project.totals.leads,
        scheduled: project.totals.scheduled,
        meetings: project.totals.meetings,
        relevant: project.totals.relevant || 0,
        costPerLead: project.totals.costPerLead,
        source: "campaign-snapshot" as const,
      };
    }
    return {
      budget: project.totals.budget,
      spend,
      leads,
      scheduled,
      meetings,
      relevant,
      costPerLead: leads > 0 ? spend / leads : 0,
      source: "monthly-cumulative" as const,
    };
  }, [project, selectedPeriods]);

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
      {/* Hero — period totals summary. Aggregated from monthlyRaw so
          the numbers track the page's period selector (not the
          campaign-life snapshot, which doesn't reflect "כל החודשים
          (5)" semantics). */}
      <section className="stats-section">
        <h2>
          סיכום תקופה
          {periodTotals.source === "campaign-snapshot" && (
            <span
              className="stats-total-source-hint"
              title="אין נתונים חודשיים לתקופה שנבחרה — מוצג סיכום הקמפיין במצב נוכחי"
            >
              {" "}· סך הקמפיין
            </span>
          )}
        </h2>
        <div className="stats-totals">
          <div className="stats-total-card">
            <div className="stats-total-label">תקציב</div>
            <div className="stats-total-value">{fmtIls(periodTotals.budget)}</div>
          </div>
          <div className="stats-total-card">
            <div className="stats-total-label">עלות</div>
            <div className="stats-total-value">{fmtIls(periodTotals.spend)}</div>
          </div>
          <div className="stats-total-card">
            <div className="stats-total-label">לידים</div>
            <div className="stats-total-value">{fmtNum(periodTotals.leads)}</div>
          </div>
          <div className="stats-total-card">
            <div className="stats-total-label">תיאומים</div>
            <div className="stats-total-value">{fmtNum(periodTotals.scheduled)}</div>
          </div>
          <div className="stats-total-card">
            <div className="stats-total-label">ביצועים</div>
            <div className="stats-total-value">{fmtNum(periodTotals.meetings)}</div>
          </div>
          {periodTotals.costPerLead > 0 && (
            <div className="stats-total-card">
              <div className="stats-total-label">עלות לליד</div>
              <div className="stats-total-value">
                {fmtIls(periodTotals.costPerLead)}
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

      {/* Phase 2 — paid-channels diagnosis */}
      <section className="stats-section">
        <h2>🟢 אבחון מדיה בתשלום</h2>
        {diagnosis.length === 0 ? (
          <div className="stats-empty">
            אין מספיק נתונים להפעלת האבחון (נדרשים לפחות 3 לידים בתשלום).
          </div>
        ) : (
          <div className="stats-diag-grid">
            {diagnosis.map((card, idx) => (
              <article
                key={idx}
                className={`stats-diag-card stats-diag-${card.tone}`}
              >
                <header className="stats-diag-head">
                  <span aria-hidden>{card.icon}</span> {card.head}
                </header>
                {/* body is HTML — built from server-controlled fragments
                    in lib/paidDiagnosis.ts where every user-supplied
                    value is escaped via esc(). Safe to inject. */}
                <div
                  className="stats-diag-body"
                  dangerouslySetInnerHTML={{ __html: card.body }}
                />
                {card.sample && (
                  <div className="stats-diag-sample">{card.sample}</div>
                )}
                <div
                  className="stats-diag-tip"
                  dangerouslySetInnerHTML={{ __html: "💡 " + card.tip }}
                />
              </article>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}
