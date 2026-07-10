"use client";

import { useMemo, useRef, useState } from "react";
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
  buildProjectionPrimitives,
  fmtInt,
  fmtILS,
  type MonthlyChannelRow,
  type MonthlyRow,
  type ProjMetric,
  type ProjectReportData,
} from "@/lib/reportShared";

/**
 * Historical monthly trend — native rebuild of the legacy "מגמה
 * היסטורית" section (drawTrendMini / drawTrendCPL / buildProjection-
 * Primitives, Index.html:10045+). Per-metric small-multiple cards with
 * the current-month PROJECTION ("→ ~X צפי"), the "בפועל: X" actual-so-far
 * chip, month-over-month delta, a sparkline whose current partial month
 * is a HOLLOW projection dot + solid actual dot, and a per-channel pie
 * popover on month hover — plus the unit-cost line chart and a channel
 * filter. Sits ABOVE the daily platform charts.
 */

const PIE_COLORS = [
  "#3366cc",
  "#dc3912",
  "#ff9900",
  "#109618",
  "#990099",
  "#0099c6",
  "#dd4477",
  "#66aa00",
  "#b82e2e",
  "#316395",
];

const METRICS: {
  key: ProjMetric;
  label: string;
  color: string;
  money: boolean;
}[] = [
  { key: "spend", label: "עלות", color: "#14b8a6", money: true },
  { key: "leads", label: "לידים", color: "#6366f1", money: false },
  { key: "scheduled", label: "תיאומים", color: "#ec4899", money: false },
  { key: "meetings", label: "ביצועים", color: "#f5576c", money: false },
];

type MonthAgg = MonthlyRow & {
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
    if (channels && !channels.has(r.channel.toLowerCase())) continue;
    const m =
      byMonth.get(r.month) ??
      ({
        month: r.month,
        spend: 0,
        leads: 0,
        scheduled: 0,
        meetings: 0,
        budget: 0,
        costPerLead: 0,
        costPerScheduled: 0,
        costPerMeeting: 0,
      } as MonthAgg);
    m.spend += r.spend;
    m.leads += r.leads;
    m.scheduled += r.scheduled;
    m.meetings += r.meetings;
    m.budget += r.budget;
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

/* --------------------------- per-channel pie ---------------------------- */

type PiePayload = {
  metricKey: ProjMetric;
  metricLabel: string;
  money: boolean;
  month: string;
  x: number;
  y: number;
};

function MiniPie({
  payload,
  monthlyRaw,
  channelFilter,
  onClose,
}: {
  payload: PiePayload;
  monthlyRaw: MonthlyChannelRow[];
  channelFilter: Set<string> | null;
  onClose: () => void;
}) {
  const byChannel = new Map<string, number>();
  for (const r of monthlyRaw) {
    if (r.month !== payload.month) continue;
    if (channelFilter && !channelFilter.has(r.channel.toLowerCase())) continue;
    const v = Number(r[payload.metricKey]) || 0;
    if (v <= 0) continue;
    const ch = r.channel.trim() || "—";
    byChannel.set(ch, (byChannel.get(ch) ?? 0) + v);
  }
  const entries = [...byChannel.entries()].sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, e) => s + e[1], 0);
  const fmt = payload.money ? fmtILS : fmtInt;
  const r = 60;
  let angle = -90;
  const slices = entries.map(([ch, v], i) => {
    const sweep = total > 0 ? (v / total) * 360 : 0;
    const a0 = (angle * Math.PI) / 180;
    const a1 = ((angle + sweep) * Math.PI) / 180;
    angle += sweep;
    const x0 = r + r * Math.cos(a0);
    const y0 = r + r * Math.sin(a0);
    const x1 = r + r * Math.cos(a1);
    const y1 = r + r * Math.sin(a1);
    const large = sweep > 180 ? 1 : 0;
    const d =
      entries.length === 1
        ? `M ${r} ${r} m -${r} 0 a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 -${r * 2} 0`
        : `M ${r} ${r} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
    return { ch, v, d, color: PIE_COLORS[i % PIE_COLORS.length] };
  });
  return (
    <div
      className="rpt-mt-pie"
      style={{ left: payload.x, top: payload.y }}
      onMouseLeave={onClose}
    >
      <div className="rpt-mt-pie-title">
        <span>
          {payload.metricLabel} · {monthLabelHe(payload.month)}
        </span>
        {total > 0 && <span className="rpt-mt-pie-total">סה״כ {fmt(Math.round(total))}</span>}
      </div>
      {!entries.length ? (
        <div className="rpt-mt-pie-none">אין פירוט ערוצים לחודש זה</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${r * 2} ${r * 2}`} width={120} height={120} aria-hidden>
            {slices.map((s, i) => (
              <path key={i} d={s.d} fill={s.color} />
            ))}
          </svg>
          <div className="rpt-mt-pie-legend">
            {slices.map((s, i) => (
              <div key={i} className="rpt-mt-pie-row">
                <span className="rpt-mt-pie-dot" style={{ background: s.color }} />
                <span className="rpt-mt-pie-ch" title={s.ch}>
                  {s.ch}
                </span>
                <span className="rpt-mt-pie-val">{fmt(Math.round(s.v))}</span>
                <span className="rpt-mt-pie-pct">
                  {(total > 0 ? (s.v / total) * 100 : 0).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------ metric card ----------------------------- */

function MetricCard({
  metric,
  agg,
  prim,
  onHover,
}: {
  metric: (typeof METRICS)[number];
  agg: MonthAgg[];
  prim: ReturnType<typeof buildProjectionPrimitives>;
  onHover: (month: string, x: number, y: number) => void;
}) {
  const fmt = metric.money ? fmtILS : fmtInt;
  const rows = prim.monthly;
  const projected = prim.isCurrentPartial
    ? prim.segmentProjection(metric.key)
    : null;
  const gateFailed = prim.isCurrentPartial && projected === null;

  // Total = archived months + current-month projection (or live-so-far).
  const total = rows.reduce((s, r, i) => {
    if (i === prim.currentIdx && prim.isCurrentPartial) {
      return s + (projected !== null ? projected : prim.liveSoFar(metric.key));
    }
    return s + (r[metric.key] || 0);
  }, 0);

  // MoM delta: last two months WITH activity, excluding the current partial.
  const active = rows.filter(
    (r, i) =>
      !(i === prim.currentIdx && prim.isCurrentPartial) &&
      (r.spend || 0) + (r.leads || 0) + (r.scheduled || 0) + (r.meetings || 0) >
        0,
  );
  let delta: { pct: number; up: boolean; last: string; prev: string } | null = null;
  if (active.length >= 2) {
    const last = active[active.length - 1][metric.key] || 0;
    const prev = active[active.length - 2][metric.key] || 0;
    if (prev > 0) {
      const d = (last - prev) / prev;
      delta = {
        pct: Math.round(Math.abs(d * 100)),
        up: d >= 0,
        last: active[active.length - 1].month,
        prev: active[active.length - 2].month,
      };
    }
  }

  // Sparkline points, clipped to ≤ current month; current partial month
  // is a hollow projection dot (+ solid actual dot if it differs).
  const endMonth =
    prim.periodEndMonth && prim.periodEndMonth < prim.currentMonthKey
      ? prim.periodEndMonth
      : prim.currentMonthKey;
  const pts = rows
    .filter((r) => r.month <= endMonth)
    .map((r, idxInFiltered) => {
      const isCur =
        rows.indexOf(r) === prim.currentIdx && prim.isCurrentPartial;
      const actual = isCur ? prim.liveSoFar(metric.key) : 0;
      const mainVal = isCur
        ? projected !== null
          ? projected
          : actual
        : r[metric.key] || 0;
      return {
        month: r.month,
        val: mainVal,
        isCur,
        projected: isCur && projected !== null,
        actual: isCur && projected !== null && actual > 0 && actual < projected * 0.98 ? actual : null,
        _i: idxInFiltered,
      };
    });

  return (
    <div className="rpt-mt-card">
      <div className="rpt-mt-head">
        <span className="rpt-mt-label">{metric.label}</span>
        <span className="rpt-mt-total">{fmt(Math.round(total))}</span>
        {delta && (
          <span
            className={"rpt-mt-delta " + (delta.up ? "is-up" : "is-down")}
            title={`${monthLabelHe(delta.last)} מול ${monthLabelHe(delta.prev)}`}
          >
            {delta.up ? "▲" : "▼"} {delta.pct}%
          </span>
        )}
      </div>
      {projected !== null && (
        <div className="rpt-mt-proj" title="צפי לסוף החודש">
          → ~{fmt(Math.round(projected))} צפי (חודש זה)
        </div>
      )}
      {gateFailed && <div className="rpt-mt-proj">→ נתונים חלקיים</div>}
      {prim.isCurrentPartial && (
        <div className="rpt-mt-actual" title={`בפועל מתחילת החודש (${prim.dayOfMonth}/${prim.daysInMonth} ימים)`}>
          בפועל: {fmt(Math.round(prim.liveSoFar(metric.key)))}
        </div>
      )}
      <Sparkline pts={pts} color={metric.color} metric={metric} onHover={onHover} />
    </div>
  );
}

function Sparkline({
  pts,
  color,
  metric,
  onHover,
}: {
  pts: { month: string; val: number; isCur: boolean; projected: boolean; actual: number | null }[];
  color: string;
  metric: (typeof METRICS)[number];
  onHover: (month: string, x: number, y: number) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  if (pts.length < 1) return <div className="rpt-mt-empty">אין נתונים</div>;
  const W = 150;
  const H = 46;
  const PAD = 5;
  const max = Math.max(...pts.map((p) => p.val), 1);
  const xOf = (i: number) =>
    pts.length === 1 ? W / 2 : PAD + (i / (pts.length - 1)) * (W - PAD * 2);
  const yOf = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const line = pts.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.val).toFixed(1)}`).join(" ");
  const area = `${PAD},${H - PAD} ${line} ${(W - PAD).toFixed(1)},${H - PAD}`;

  void metric;
  const emit = (i: number) => {
    const rect = ref.current?.getBoundingClientRect();
    onHover(pts[i].month, (rect?.left ?? 0) + xOf(i), rect?.top ?? 0);
  };

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      className="rpt-mt-spark"
      onMouseLeave={() => onHover("", 0, 0)}
    >
      <polygon points={area} fill={color} opacity={0.15} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.8} />
      {pts.map((p, i) => {
        if (p.projected) {
          return (
            <g key={i}>
              <circle cx={xOf(i)} cy={yOf(p.val)} r={3.5} fill="#fff" stroke={color} strokeWidth={2} />
              {p.actual !== null && (
                <circle cx={xOf(i)} cy={yOf(p.actual)} r={2.5} fill={color} />
              )}
            </g>
          );
        }
        return null;
      })}
      {/* hover targets — one column band per month */}
      {pts.map((p, i) => (
        <rect
          key={`h${i}`}
          x={i === 0 ? 0 : (xOf(i - 1) + xOf(i)) / 2}
          y={0}
          width={
            pts.length === 1
              ? W
              : (i === pts.length - 1 ? W : (xOf(i) + xOf(i + 1)) / 2) -
                (i === 0 ? 0 : (xOf(i - 1) + xOf(i)) / 2)
          }
          height={H}
          fill="transparent"
          onMouseEnter={() => emit(i)}
        />
      ))}
    </svg>
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
  const [pie, setPie] = useState<PiePayload | null>(null);

  const channelFilter = useMemo(
    () => (selected ? new Set([...selected].map((c) => c.toLowerCase())) : null),
    [selected],
  );
  const agg = useMemo(() => aggregate(rows, channelFilter), [rows, channelFilter]);
  const prim = useMemo(
    () =>
      buildProjectionPrimitives(
        agg,
        data.totals ?? { spend: 0, leads: 0, scheduled: 0, meetings: 0, budget: 0 },
        data.window,
        data.todayIso,
      ),
    [agg, data.totals, data.window, data.todayIso],
  );

  if (!rows.length) return null;

  const toggle = (ch: string) => {
    setSelected((cur) => {
      const base = cur ?? new Set(allChannels);
      const next = new Set(base);
      if (next.has(ch)) next.delete(ch);
      else next.add(ch);
      if (next.size === 0) return new Set(allChannels);
      if (next.size === allChannels.length) return null;
      return next;
    });
  };
  const filterLabel =
    selected === null ? `כל הערוצים (${allChannels.length})` : `${selected.size} ערוצים`;

  const cplLines = [
    { key: "costPerLead" as const, label: "עלות לליד", color: "#6366f1" },
    { key: "costPerScheduled" as const, label: "עלות לתיאום", color: "#ec4899" },
    { key: "costPerMeeting" as const, label: "עלות לביצוע", color: "#f5576c" },
  ];
  // Unit-cost chart: clip to ≤ min(currentMonth, periodEnd) and project
  // the current partial month's ratios from the clamped count/spend
  // projections (drawTrendCPL). A ratio only projects when both spend and
  // its denominator pass their gates; a month with spend but 0 results
  // gaps the line (null). Wasted-spend ⚠ handled by the null gap.
  const cplEndMonth =
    prim.periodEndMonth && prim.periodEndMonth < prim.currentMonthKey
      ? prim.periodEndMonth
      : prim.currentMonthKey;
  let projCpl: number | null = null;
  let projCps: number | null = null;
  let projCpm: number | null = null;
  if (prim.isCurrentPartial) {
    const pSpend = prim.segmentProjection("spend");
    let pLeads = prim.segmentProjection("leads");
    let pSched = prim.segmentProjection("scheduled");
    let pMeet = prim.segmentProjection("meetings");
    if (pLeads !== null && pSched !== null && pSched > pLeads) pSched = pLeads;
    if (pSched !== null && pMeet !== null && pMeet > pSched) pMeet = pSched;
    if (pSpend !== null && pLeads !== null && pLeads > 0) projCpl = pSpend / pLeads;
    if (pSpend !== null && pSched !== null && pSched > 0) projCps = pSpend / pSched;
    if (pSpend !== null && pMeet !== null && pMeet > 0) projCpm = pSpend / pMeet;
  }
  const ratioOrNull = (
    isCur: boolean,
    proj: number | null,
    spend: number,
    count: number,
  ): number | null => {
    if (isCur && proj !== null) return Math.round(proj);
    if (count > 0) return Math.round(spend / count);
    return null; // 0 results (or wasted spend) → gap the line
  };
  const chartData = prim.monthly
    .filter((m) => m.month <= cplEndMonth)
    .map((m) => {
      const isCur =
        prim.monthly.indexOf(m) === prim.currentIdx && prim.isCurrentPartial;
      return {
        month: monthLabelHe(m.month),
        costPerLead: ratioOrNull(isCur, projCpl, m.spend, m.leads),
        costPerScheduled: ratioOrNull(isCur, projCps, m.spend, m.scheduled),
        costPerMeeting: ratioOrNull(isCur, projCpm, m.spend, m.meetings),
      };
    });

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

      <div className="rpt-mt-charts">
        <div className="rpt-mt-box">
          <h4>מגמה חודשית — מטריקות</h4>
          <div className="rpt-mt-cards">
            {METRICS.map((m) => (
              <MetricCard
                key={m.key}
                metric={m}
                agg={agg}
                prim={prim}
                onHover={(month, x, y) =>
                  setPie(
                    month
                      ? {
                          metricKey: m.key,
                          metricLabel: m.label,
                          money: m.money,
                          month,
                          x,
                          y,
                        }
                      : null,
                  )
                }
              />
            ))}
          </div>
        </div>

        <div className="rpt-mt-box">
          <h4>מגמה חודשית — עלויות יחידה</h4>
          {chartData.length >= 2 ? (
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
          ) : (
            <div className="rpt-empty rpt-empty-sm">אין מספיק חודשים למגמת עלויות.</div>
          )}
        </div>
      </div>

      {pie && (
        <MiniPie
          payload={pie}
          monthlyRaw={rows}
          channelFilter={channelFilter}
          onClose={() => setPie(null)}
        />
      )}
    </section>
  );
}
