"use client";

import { useMemo } from "react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
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
}: {
  channels: ReportChannel[];
  costKey: "costPerLead" | "costPerScheduled";
  countKey: "leads" | "scheduled";
  costLabel: string;
  countLabel: string;
  emptyText: string;
  color: string;
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
          label: icon(c.channel),
          spend: c.spend,
        })),
    [channels, costKey, countKey],
  );
  if (!points.length)
    return <div className="rpt-empty rpt-empty-sm">{emptyText}</div>;
  return (
    <div className="rpt-scatter" dir="ltr">
      <ResponsiveContainer width="100%" height={230}>
        <ScatterChart margin={{ top: 12, right: 16, bottom: 26, left: 8 }}>
          <CartesianGrid stroke={pal.grid} strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="x"
            name={costLabel}
            tick={{ fill: pal.tick, fontSize: 11 }}
            tickFormatter={(v: number) => fmtILS(v)}
            label={{ value: `${costLabel} — ← זול יותר`, position: "bottom", fill: pal.tick, fontSize: 11 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name={countLabel}
            tick={{ fill: pal.tick, fontSize: 11 }}
            width={40}
          />
          <ZAxis range={[180, 180]} />
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
            <LabelList dataKey="label" position="top" style={{ fontSize: 13 }} />
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

function OutcomeBars({ channels }: { channels: ReportChannel[] }) {
  const rows = channels.filter(
    (c) => c.leads + c.scheduled + c.meetings > 0,
  );
  if (!rows.length)
    return <div className="rpt-empty rpt-empty-sm">אין נתוני משפך</div>;
  const max = Math.max(...rows.map((c) => c.leads), 1);
  const SERIES = [
    { key: "leads" as const, label: "לידים", color: "#6366f1" },
    { key: "scheduled" as const, label: "תיאומים", color: "#ec4899" },
    { key: "meetings" as const, label: "ביצועים", color: "#f5576c" },
  ];
  return (
    <div className="rpt-outbar">
      <div className="rpt-outbar-legend">
        {SERIES.map((s) => (
          <span key={s.key}>
            <span className="rpt-outbar-dot" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      {rows.map((c) => (
        <div key={c.channel} className="rpt-outbar-row">
          <span className="rpt-outbar-label" title={c.channel}>
            {icon(c.channel)}
          </span>
          <span className="rpt-outbar-bars">
            {SERIES.map((s) => (
              <span key={s.key} className="rpt-outbar-track">
                <span
                  className="rpt-outbar-fill"
                  style={{
                    width: `${(c[s.key] / max) * 100}%`,
                    background: s.color,
                  }}
                />
                {c[s.key] > 0 && (
                  <span className="rpt-outbar-val">{fmtInt(c[s.key])}</span>
                )}
              </span>
            ))}
          </span>
        </div>
      ))}
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
        <div className="rpt-ch-chart-box">
          <h4>יעילות ערוצים — לידים מול עלות לליד</h4>
          <EffScatter
            channels={channels}
            costKey="costPerLead"
            countKey="leads"
            costLabel="עלות לליד"
            countLabel="לידים"
            emptyText="אין לידים בערוצים פעילים"
            color="#667eea"
          />
          <ScatterLegend channels={channels} costKey="costPerLead" countKey="leads" />
        </div>
        <div className="rpt-ch-chart-box">
          <h4>יעילות ערוצים — תיאומים מול עלות לתיאום</h4>
          <EffScatter
            channels={channels}
            costKey="costPerScheduled"
            countKey="scheduled"
            costLabel="עלות לתיאום"
            countLabel="תיאומים"
            emptyText="אין תיאומי פגישה"
            color="#ec4899"
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
