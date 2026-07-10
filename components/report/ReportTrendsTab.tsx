"use client";

import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useChartPalette } from "@/lib/chartTheme";
import ReportMonthlyTrend from "@/components/report/ReportMonthlyTrend";
import {
  REPORT_PLATS,
  PLAT_LABELS,
  PLAT_COLORS,
  fmtInt,
  fmtILS,
  fmtPct2,
  fmtDateHe,
  type DailyPoint,
  type ProjectReportData,
  type ReportPlat,
} from "@/lib/reportShared";

/**
 * מגמות tab — the native rebuild of the legacy "מגמה יומית לפי פלטפורמה"
 * section (renderDailyPlatformSection, Index.html:7260): one chart per
 * active platform, a shared metric-chip bar (cost+leads on by default) and
 * quick range buttons. Days with no data are ZERO-FILLED across the
 * selected range so paused days draw down to the axis instead of
 * interpolating a flat line (legacy drawDailyChart:7494).
 */

type MetricId =
  | "cost"
  | "leads"
  | "impressions"
  | "clicks"
  | "ctr"
  | "cvr"
  | "cpm"
  | "cpc"
  | "cpl";

type Family = "cur" | "cnt" | "pct";

const METRICS: {
  id: MetricId;
  label: string;
  color: string;
  family: Family;
  calc: (p: DailyPoint) => number;
}[] = [
  { id: "cost", label: "עלות", color: "#14b8a6", family: "cur", calc: (p) => p.cost },
  { id: "leads", label: "לידים", color: "#6366f1", family: "cnt", calc: (p) => p.leads },
  { id: "impressions", label: "חשיפות", color: "#0ea5e9", family: "cnt", calc: (p) => p.impressions },
  { id: "clicks", label: "קליקים", color: "#8b5cf6", family: "cnt", calc: (p) => p.clicks },
  { id: "ctr", label: "CTR", color: "#ec4899", family: "pct", calc: (p) => (p.impressions > 0 ? p.clicks / p.impressions : 0) },
  { id: "cvr", label: "CVR", color: "#f59e0b", family: "pct", calc: (p) => (p.clicks > 0 ? Math.min(p.leads / p.clicks, 1) : 0) },
  { id: "cpm", label: "CPM", color: "#10b981", family: "cur", calc: (p) => (p.impressions > 0 ? (p.cost / p.impressions) * 1000 : 0) },
  { id: "cpc", label: "CPC", color: "#ef4444", family: "cur", calc: (p) => (p.clicks > 0 ? p.cost / p.clicks : 0) },
  { id: "cpl", label: "עלות לליד", color: "#a855f7", family: "cur", calc: (p) => (p.leads > 0 ? p.cost / p.leads : 0) },
];

const fmtByFamily: Record<Family, (n: number) => string> = {
  cur: (n) => (n > 0 && n < 100 ? `₪${n.toFixed(1)}` : fmtILS(n)),
  cnt: fmtInt,
  pct: fmtPct2,
};

function todayIlIso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(),
  );
}

function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** All calendar days from `from` to `to`, inclusive (both YYYY-MM-DD). */
function daysRange(from: string, to: string): string[] {
  const out: string[] = [];
  let d = from;
  let guard = 0;
  while (d <= to && guard++ < 1000) {
    out.push(d);
    d = shiftIso(d, 1);
  }
  return out;
}

export default function ReportTrendsTab({ data }: { data: ProjectReportData }) {
  const pal = useChartPalette();
  const today = todayIlIso();

  // Availability bounds across all platforms.
  const { minDate, maxDate } = useMemo(() => {
    let min = "";
    let max = "";
    for (const p of REPORT_PLATS) {
      for (const pt of data.daily[p]) {
        if (!min || pt.date < min) min = pt.date;
        if (pt.date > max) max = pt.date;
      }
    }
    return { minDate: min, maxDate: max };
  }, [data.daily]);

  const defaultRange = useMemo(() => {
    if (data.mode !== "live" && data.window.startIso && data.window.endIso) {
      return { from: data.window.startIso, to: data.window.endIso };
    }
    // Live: last 30 calendar days ending today, clamped to availability.
    const to = maxDate && maxDate < today ? maxDate : today;
    const from30 = shiftIso(to, -29);
    return { from: minDate && minDate > from30 ? minDate : from30, to };
  }, [data.mode, data.window, minDate, maxDate, today]);

  const [range, setRange] = useState(defaultRange);
  const [selected, setSelected] = useState<MetricId[]>(["cost", "leads"]);

  const toggleMetric = (id: MetricId) =>
    setSelected((cur) =>
      cur.includes(id)
        ? cur.length > 1
          ? cur.filter((m) => m !== id)
          : cur
        : [...cur, id],
    );

  const quickRanges: { label: string; from: string; to: string }[] = useMemo(() => {
    const thisMonthStart = today.slice(0, 7) + "-01";
    const prevMonthEnd = shiftIso(thisMonthStart, -1);
    const prevMonthStart = prevMonthEnd.slice(0, 7) + "-01";
    const out = [
      { label: "שבוע אחרון", from: shiftIso(today, -6), to: today },
      { label: "30 ימים", from: shiftIso(today, -29), to: today },
      { label: "החודש", from: thisMonthStart, to: today },
      { label: "חודש קודם", from: prevMonthStart, to: prevMonthEnd },
      { label: "3 חודשים", from: shiftIso(today, -89), to: today },
    ];
    if (minDate && maxDate) out.push({ label: "כל הטווח", from: minDate, to: maxDate });
    if (data.mode !== "live" && data.window.startIso)
      out.unshift({
        label: "התקופה הנבחרת",
        from: data.window.startIso,
        to: data.window.endIso,
      });
    return out;
  }, [today, minDate, maxDate, data.mode, data.window]);

  const activePlats = REPORT_PLATS.filter((p) => data.daily[p].length > 0);
  const selectedDefs = METRICS.filter((m) => selected.includes(m.id));
  // Y axes: one per unit family, in selection order — first left, second
  // right, a third family scales independently on a hidden axis.
  const families = [...new Set(selectedDefs.map((m) => m.family))];

  if (!activePlats.length) {
    return (
      <div className="rpt-trends">
        <ReportMonthlyTrend data={data} />
        <div className="rpt-empty">אין נתונים יומיים לפרויקט הזה.</div>
      </div>
    );
  }

  return (
    <div className="rpt-trends">
      {/* Historical monthly trend sits ABOVE the daily platform charts. */}
      <ReportMonthlyTrend data={data} />
      <div className="rpt-trend-controls">
        <div className="rpt-range-btns">
          {quickRanges.map((q) => {
            const active = range.from === q.from && range.to === q.to;
            return (
              <button
                key={q.label}
                type="button"
                className={"rpt-range-btn" + (active ? " is-active" : "")}
                onClick={() => setRange({ from: q.from, to: q.to })}
              >
                {q.label}
              </button>
            );
          })}
          <span className="rpt-range-dates">
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) =>
                e.target.value && setRange((r) => ({ ...r, from: e.target.value }))
              }
            />
            —
            <input
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) =>
                e.target.value && setRange((r) => ({ ...r, to: e.target.value }))
              }
            />
          </span>
        </div>
        <div className="rpt-trend-chips">
          {METRICS.map((m) => {
            const on = selected.includes(m.id);
            return (
              <button
                key={m.id}
                type="button"
                className={"rpt-chip" + (on ? " is-on" : "")}
                style={on ? { borderColor: m.color, color: m.color } : undefined}
                onClick={() => toggleMetric(m.id)}
              >
                <span
                  className="rpt-chip-dot"
                  style={{ background: m.color, opacity: on ? 1 : 0.35 }}
                />
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {activePlats.map((plat) => (
        <PlatTrendChart
          key={plat}
          plat={plat}
          points={data.daily[plat]}
          range={range}
          selectedDefs={selectedDefs}
          families={families}
          pal={pal}
        />
      ))}
    </div>
  );
}

function PlatTrendChart({
  plat,
  points,
  range,
  selectedDefs,
  families,
  pal,
}: {
  plat: ReportPlat;
  points: DailyPoint[];
  range: { from: string; to: string };
  selectedDefs: (typeof METRICS)[number][];
  families: Family[];
  pal: ReturnType<typeof useChartPalette>;
}) {
  const { rows, totals } = useMemo(() => {
    const byDate = new Map(points.map((p) => [p.date, p]));
    const t = { cost: 0, leads: 0, impressions: 0, clicks: 0 };
    const dense = daysRange(range.from, range.to).map((iso) => {
      const p =
        byDate.get(iso) ??
        ({ date: iso, cost: 0, leads: 0, impressions: 0, clicks: 0 } as DailyPoint);
      t.cost += p.cost;
      t.leads += p.leads;
      t.impressions += p.impressions;
      t.clicks += p.clicks;
      const row: Record<string, number | string> = { date: iso };
      for (const m of METRICS) row[m.id] = m.calc(p);
      return row;
    });
    return { rows: dense, totals: t };
  }, [points, range]);

  const hasData = totals.cost > 0 || totals.impressions > 0 || totals.leads > 0;
  const cpl = totals.leads > 0 ? totals.cost / totals.leads : 0;

  return (
    <div className="rpt-trend-card">
      <div className="rpt-plat-head">
        <span className="rpt-plat-dot" style={{ background: PLAT_COLORS[plat] }} />
        <span className="rpt-plat-name">{PLAT_LABELS[plat]}</span>
        <span className="rpt-trend-totals">
          {fmtILS(totals.cost)} · {fmtInt(totals.leads)} לידים
          {cpl > 0 ? ` · ${fmtILS(cpl)} לליד` : ""}
        </span>
      </div>
      {!hasData ? (
        <div className="rpt-empty rpt-empty-sm">אין נתונים בטווח הנבחר.</div>
      ) : (
        <div className="rpt-trend-chart" dir="ltr">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid stroke={pal.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: pal.tick, fontSize: 11 }}
                tickFormatter={(d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`}
                minTickGap={24}
              />
              {families.map((fam, i) => (
                <YAxis
                  key={fam}
                  yAxisId={fam}
                  orientation={i === 0 ? "left" : "right"}
                  hide={i > 1}
                  width={52}
                  tick={{ fill: pal.tick, fontSize: 11 }}
                  tickFormatter={(v: number) =>
                    fam === "pct"
                      ? `${(v * 100).toFixed(1)}%`
                      : fmtInt(v)
                  }
                  domain={[0, "auto"]}
                />
              ))}
              <Tooltip
                contentStyle={{
                  background: pal.tooltipBg,
                  border: `1px solid ${pal.tooltipBorder}`,
                  borderRadius: 8,
                  color: pal.tooltipInk,
                  fontSize: 12,
                  direction: "rtl",
                }}
                labelFormatter={(d) => fmtDateHe(String(d))}
                formatter={(value, name) => {
                  const def = METRICS.find((m) => m.label === String(name));
                  const v = Number(value) || 0;
                  return [def ? fmtByFamily[def.family](v) : String(value ?? ""), name];
                }}
              />
              {selectedDefs.map((m) => (
                <Line
                  key={m.id}
                  yAxisId={m.family}
                  type="monotone"
                  dataKey={m.id}
                  name={m.label}
                  stroke={m.color}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
