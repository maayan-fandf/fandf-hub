"use client";

import { useMemo } from "react";
import {
  ScatterChart,
  Scatter,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LabelList,
} from "recharts";
import { useChartPalette } from "@/lib/chartTheme";
import { channelIcon } from "@/lib/channelIcon";
import { fmtInt, fmtILS, type ReportChannel } from "@/lib/reportShared";

/**
 * Channel analytics charts — native rebuild of the legacy report's
 * channel-efficiency visuals below the פירוט ערוצים table:
 * - drawScatterLeads / drawScatterScheduled: efficiency scatters
 *   (x = cost-per, y = count) per channel, left = cheaper = better.
 * - drawBudgetBar: custom fill-bars (spend-vs-budget utilization per
 *   channel, teal, red-striped when over).
 * - drawLeadsBar: grouped bars (לידים / תיאומים / ביצועים per channel).
 */

const icon = (n: string) => channelIcon(n) || "●";

function EffScatter({
  channels,
  costKey,
  countKey,
  costLabel,
  countLabel,
  emptyText,
  color,
  variant,
  xTitle,
  yTitle,
}: {
  channels: ReportChannel[];
  costKey: "costPerLead" | "costPerScheduled";
  countKey: "leads" | "scheduled";
  costLabel: string;
  countLabel: string;
  emptyText: string;
  color: string;
  variant: "leads" | "sched";
  xTitle: string;
  yTitle: string;
}) {
  const pal = useChartPalette();
  const points = useMemo(
    () =>
      channels
        .filter((c) => c[countKey] > 0 && c[costKey] > 0)
        .sort((a, b) => a[costKey] - b[costKey])
        .map((c) => ({
          x: c[costKey],
          y: c[countKey],
          name: c.channel,
          label: `${icon(c.channel)} ${c.channel}`.trim(),
          spend: c.spend,
        })),
    [channels, costKey, countKey],
  );
  if (!points.length)
    return <div className="rpt-empty rpt-empty-sm">{emptyText}</div>;
  return (
    <div className={`rpt-scatter-zone rpt-scatter-zone-${variant}`} dir="ltr">
      <ResponsiveContainer width="100%" height={244}>
        <ScatterChart margin={{ top: 16, right: 18, bottom: 34, left: 14 }}>
          <CartesianGrid stroke={pal.grid} strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="x"
            name={costLabel}
            tick={{ fill: pal.tick, fontSize: 11 }}
            tickFormatter={(v: number) => fmtILS(v)}
            label={{ value: xTitle, position: "bottom", fill: pal.tick, fontSize: 10, dy: 4 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name={countLabel}
            tick={{ fill: pal.tick, fontSize: 11 }}
            width={46}
            label={{
              value: yTitle,
              angle: -90,
              position: "insideLeft",
              fill: pal.tick,
              fontSize: 10,
              style: { textAnchor: "middle" },
            }}
          />
          <ZAxis range={[160, 160]} />
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            contentStyle={{
              background: pal.tooltipBg,
              border: `1px solid ${pal.tooltipBorder}`,
              borderRadius: 8,
              color: pal.tooltipInk,
              fontSize: 12,
              direction: "rtl",
            }}
            formatter={(value, name) => {
              if (String(name) === costLabel)
                return [fmtILS(Number(value) || 0), costLabel];
              return [fmtInt(Number(value) || 0), countLabel];
            }}
            labelFormatter={() => ""}
          />
          <Scatter data={points} fill={color}>
            <LabelList
              dataKey="label"
              position="top"
              style={{ fontSize: 10, fontWeight: 700, fill: pal.tick }}
            />
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Legend chips ranked cheapest-first (1 = best). */
function ScatterLegend({
  channels,
  costKey,
  countKey,
}: {
  channels: ReportChannel[];
  costKey: "costPerLead" | "costPerScheduled";
  countKey: "leads" | "scheduled";
}) {
  const ranked = channels
    .filter((c) => c[countKey] > 0 && c[costKey] > 0)
    .sort((a, b) => a[costKey] - b[costKey]);
  if (!ranked.length) return null;
  return (
    <div className="rpt-scatter-legend">
      {ranked.map((c, i) => (
        <span key={c.channel} className="rpt-scatter-chip" title={`${c.channel} · ${fmtILS(c[costKey])}`}>
          <b>{i + 1}</b> {icon(c.channel)}
        </span>
      ))}
    </div>
  );
}

function BudgetBars({ channels }: { channels: ReportChannel[] }) {
  const rows = channels.filter((c) => c.budget > 0 || c.spend > 0);
  if (!rows.length)
    return <div className="rpt-empty rpt-empty-sm">אין נתוני תקציב</div>;
  const maxAmount = Math.max(...rows.map((c) => Math.max(c.budget, c.spend)), 1);
  return (
    <div className="rpt-budbar-list">
      {rows.map((c) => {
        const pct = c.budget > 0 ? c.spend / c.budget : 0;
        const over = c.spend > c.budget && c.budget > 0;
        const trackScale = (Math.max(c.budget, c.spend) / maxAmount) * 100;
        const fillPct = c.budget > 0 ? Math.min(pct, 1) * 100 : 0;
        return (
          <div key={c.channel} className="rpt-budbar-row">
            <span className="rpt-budbar-label" title={c.channel}>
              {icon(c.channel)}
            </span>
            <span className="rpt-budbar-slot">
              <span
                className={"rpt-budbar-track" + (over ? " is-over" : "")}
                style={{ width: `${trackScale.toFixed(1)}%` }}
                title={`${c.channel} · עלות ${fmtILS(c.spend)} / תקציב ${fmtILS(c.budget)}${over ? " · ⚠️ חריגה" : ""}`}
              >
                <span className="rpt-budbar-fill" style={{ width: `${fillPct}%` }}>
                  {c.budget > 0
                    ? `${Math.round(pct * 100)}%`
                    : fmtILS(c.spend)}
                </span>
              </span>
            </span>
            <span className="rpt-budbar-num">
              {fmtILS(c.spend)} / {fmtILS(c.budget)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Vertical grouped column chart — לידים / תיאומים / ביצועים per channel
 *  (drawLeadsBar). Channel-icon x-axis, three colored columns with value
 *  labels + a top legend, matching the dashboard. */
function OutcomeBars({ channels }: { channels: ReportChannel[] }) {
  const pal = useChartPalette();
  const rows = channels.filter((c) => c.leads + c.scheduled + c.meetings > 0);
  if (!rows.length)
    return <div className="rpt-empty rpt-empty-sm">אין נתוני משפך</div>;
  const data = rows.map((c) => ({
    channel: icon(c.channel),
    name: c.channel,
    leads: c.leads,
    scheduled: c.scheduled,
    meetings: c.meetings,
  }));
  const SERIES = [
    { key: "leads", label: "לידים", color: "#6366f1" },
    { key: "scheduled", label: "תיאומים", color: "#ec4899" },
    { key: "meetings", label: "ביצועים", color: "#f5576c" },
  ];
  return (
    <div className="rpt-scatter" dir="ltr">
      <ResponsiveContainer width="100%" height={230}>
        <BarChart data={data} margin={{ top: 16, right: 8, bottom: 4, left: 8 }} barCategoryGap="20%">
          <CartesianGrid stroke={pal.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="channel" tick={{ fontSize: 15 }} interval={0} />
          <YAxis tick={{ fill: pal.tick, fontSize: 11 }} width={34} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: pal.grid, opacity: 0.25 }}
            contentStyle={{
              background: pal.tooltipBg,
              border: `1px solid ${pal.tooltipBorder}`,
              borderRadius: 8,
              color: pal.tooltipInk,
              fontSize: 12,
              direction: "rtl",
            }}
            labelFormatter={(_l, p) =>
              p && p[0] ? String((p[0].payload as { name?: string }).name ?? "") : ""
            }
            formatter={(v, n) => [fmtInt(Number(v) || 0), String(n)]}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {SERIES.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[3, 3, 0, 0]} maxBarSize={22}>
              <LabelList
                dataKey={s.key}
                position="top"
                formatter={(v) => {
                  const n = Number(v) || 0;
                  return n > 0 ? fmtInt(n) : "";
                }}
                style={{ fill: pal.tick, fontSize: 10 }}
              />
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function ReportChannelCharts({
  channels,
}: {
  channels: ReportChannel[];
}) {
  if (!channels.length) return null;
  return (
    <div className="rpt-ch-charts">
      <div className="rpt-ch-chart-grid">
        <div className="rpt-ch-chart-box rpt-scatter-box rpt-scatter-box-leads">
          <h4>
            <span className="rpt-scatter-h4-tag">👥 לידים ·</span> יעילות ערוצים —
            לידים מול עלות לליד
          </h4>
          <EffScatter
            channels={channels}
            costKey="costPerLead"
            countKey="leads"
            costLabel="עלות לליד"
            countLabel="לידים"
            emptyText="אין לידים בערוצים פעילים"
            color="#667eea"
            variant="leads"
            xTitle="עלות לליד (₪) — שמאלה = יעיל יותר"
            yTitle="כמות לידים — למעלה = יותר"
          />
          <ScatterLegend channels={channels} costKey="costPerLead" countKey="leads" />
        </div>
        <div className="rpt-ch-chart-box rpt-scatter-box rpt-scatter-box-sched">
          <h4>
            <span className="rpt-scatter-h4-tag">📅 תיאומי פגישה ·</span> יעילות
            ערוצים — תיאומים מול עלות לתיאום
          </h4>
          <EffScatter
            channels={channels}
            costKey="costPerScheduled"
            countKey="scheduled"
            costLabel="עלות לתיאום"
            countLabel="תיאומים"
            emptyText="אין תיאומי פגישה"
            color="#ec4899"
            variant="sched"
            xTitle="עלות לתיאום (₪) — שמאלה = יעיל יותר"
            yTitle="כמות תיאומים — למעלה = יותר"
          />
          <ScatterLegend channels={channels} costKey="costPerScheduled" countKey="scheduled" />
        </div>
        <div className="rpt-ch-chart-box">
          <h4>תקציב מול עלות לפי ערוץ</h4>
          <BudgetBars channels={channels} />
        </div>
        <div className="rpt-ch-chart-box">
          <h4>לידים, תיאומים וביצועים לפי ערוץ</h4>
          <OutcomeBars channels={channels} />
        </div>
      </div>
    </div>
  );
}
