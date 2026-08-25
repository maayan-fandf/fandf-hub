"use client";

import { useMemo } from "react";
import {
  ScatterChart,
  Scatter,
  BarChart,
  Bar,
  Cell,
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
import { channelIcon, channelPlatform } from "@/lib/channelIcon";
import ChannelIcon from "@/components/ChannelIcon";
import PlatformIcon from "@/components/PlatformIcon";
import { fmtInt, fmtILS, type ReportChannel } from "@/lib/reportShared";

/**
 * Channel analytics charts — native rebuild of the legacy report's
 * channel-efficiency visuals below the פירוט ערוצים table:
 * - EffScatter ×3: efficiency scatters (x = cost-per, y = count) per
 *   channel, left = cheaper = better. One per funnel stage — לידים,
 *   תיאומים and (2026-08-25) ביצועים, so the stage the agency is
 *   actually judged on gets the same per-channel efficiency read as
 *   the two above it.
 * - OutcomeBars: grouped bars (לידים / תיאומים / ביצועים per channel)
 *   PLUS the budget-utilization column that used to be its own card.
 *
 * The legacy drawBudgetBar card ("תקציב מול עלות לפי ערוץ") was retired
 * 2026-08-25 at the owner's request — it repeated OutcomeBars' channel
 * axis to say one extra thing, so that thing moved in as a column and
 * the card went away. Nothing was lost: utilization %, the over-budget
 * signal and the absolute ₪ all survive on the merged card.
 */

const icon = (n: string) => channelIcon(n) || "●";

/** The three funnel stages the efficiency scatters chart, as the pair of
 *  ReportChannel keys each one reads. Kept as named types so a new stage
 *  is one entry here rather than a widening in four signatures. */
type CostKey = "costPerLead" | "costPerScheduled" | "costPerMeeting";
type CountKey = "leads" | "scheduled" | "meetings";

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
  costKey: CostKey;
  countKey: CountKey;
  costLabel: string;
  countLabel: string;
  emptyText: string;
  color: string;
  variant: "leads" | "sched" | "held";
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
  /**
   * Dot label: brand mark (or emoji) stacked over the channel name.
   *
   * recharts' default LabelList content is a single <text>, and a logo is
   * an <svg> — it cannot go in one. So this replaces the default and
   * reproduces what position="top" computed: horizontal centre of the
   * symbol, `offset` above it. Geometry is read defensively from either
   * the flattened props or the viewBox, because which of the two carries
   * it is a recharts implementation detail, not a contract.
   *
   * Stacked rather than inline so no text measuring is needed to place
   * the icon — and it matches OutcomeBars' icon-over-name x-axis.
   */
  // `unknown` in, narrowed here: recharts types `viewBox` as a union that
  // includes the polar shape, so declaring the cartesian one on the
  // parameter makes the whole callback unassignable to LabelContentType.
  const renderPointLabel = (raw: unknown) => {
    const props = (raw ?? {}) as {
      x?: number | string;
      y?: number | string;
      width?: number | string;
      offset?: number;
      index?: number;
      viewBox?: { x?: number; y?: number; width?: number };
    };
    const pt = points[Number(props.index)];
    if (!pt) return <g />;
    const vb = props.viewBox ?? {};
    const bx = Number(props.x ?? vb.x) || 0;
    const by = Number(props.y ?? vb.y) || 0;
    const bw = Number(props.width ?? vb.width) || 0;
    const off = Number(props.offset ?? 5) || 5;
    const cx = bx + bw / 2;
    const ty = by - off;
    const plat = channelPlatform(pt.name);
    return (
      <g>
        {plat ? (
          // Clamped to the surface: a point at the very top of the plot puts
          // this at a negative y, where the icon is silently clipped away.
          // The margin below is sized so the clamp shouldn't bite — this is
          // the net, not the plan.
          <g transform={`translate(${cx - 6},${Math.max(0, ty - 22)})`}>
            <PlatformIcon platform={plat} size={12} />
          </g>
        ) : (
          <text
            x={cx}
            y={Math.max(9, ty - 12)}
            textAnchor="middle"
            fontSize={11}
          >
            {icon(pt.name)}
          </text>
        )}
        <text
          x={cx}
          y={ty}
          textAnchor="middle"
          style={{ fontSize: 10, fontWeight: 700, fill: pal.tick }}
        >
          {pt.name}
        </text>
      </g>
    );
  };
  return (
    <div className={`rpt-scatter-zone rpt-scatter-zone-${variant}`} dir="ltr">
      <ResponsiveContainer width="100%" height={268}>
        {/* Extra top/right/bottom margin insets the plot so the corner
            "יעיל"/"פחות יעיל" tags don't collide with edge dots + labels.
            Top grew from 28 to 46 when the dot labels gained a stacked icon:
            a point at the plot's ceiling put that icon ~22px above the old
            margin, i.e. off the surface entirely. Height grew to match so
            the plot itself didn't lose the space. */}
        <ScatterChart margin={{ top: 46, right: 30, bottom: 40, left: 16 }}>
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
            <LabelList dataKey="label" position="top" content={renderPointLabel} />
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
  costKey: CostKey;
  countKey: CountKey;
}) {
  const ranked = channels
    .filter((c) => c[countKey] > 0 && c[costKey] > 0)
    .sort((a, b) => a[costKey] - b[costKey]);
  if (!ranked.length) return null;
  return (
    <div className="rpt-scatter-legend">
      {ranked.map((c, i) => (
        <span key={c.channel} className="rpt-scatter-chip" title={`${c.channel} · ${fmtILS(c[costKey])}`}>
          <b>{i + 1}</b> <ChannelIcon name={c.channel} fallback="●" />{" "}
          <span className="rpt-scatter-chip-name">{c.channel}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * OutcomeBars' legend, hand-built.
 *
 * recharts derives its own payload in Hebrew-ALPHABETICAL order
 * (ב,י,ל,ע,ת — measured, not guessed), which says nothing about the
 * chart, and this version's <Legend> omits the `payload` prop entirely,
 * so `content` is the only lever on the order. Reuses the .rpt-outbar-*
 * classes an earlier hand-built legend left behind in globals.css.
 */
function OutcomeLegend({
  items,
}: {
  items: { label: string; color: string; faded?: boolean }[];
}) {
  return (
    <div
      className="rpt-outbar-legend"
      dir="rtl"
      style={{ justifyContent: "center", marginBottom: 0 }}
    >
      {items.map((it) => (
        <span key={it.label}>
          <i
            className="rpt-outbar-dot"
            style={{
              background: it.color,
              // Matches the remainder bar's own fillOpacity, so the swatch
              // is the same pale the column actually paints.
              opacity: it.faded ? 0.35 : 1,
            }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** Vertical grouped column chart — לידים / תיאומים / ביצועים per channel,
 *  plus the budget-utilization column absorbed from the retired
 *  "תקציב מול עלות לפי ערוץ" card (see the file header).
 *
 *  TWO Y AXES, because counts and shekels share no scale: the left axis
 *  carries the three funnel counts, the right one the money. The money
 *  column is a single STACKED bar — עלות at the bottom, the unspent
 *  remainder pale on top — so the column's fill reads as utilization
 *  exactly like the old horizontal fill-bars did. Over budget turns the
 *  spend segment red and zeroes the remainder, so an overshooting channel
 *  is a solid red column instead of a bar that silently clamps at 100%.
 *
 *  Rows are the UNION of "has funnel" and "has money": טלפוניה has leads
 *  and no spend, a just-launched channel has spend and no leads, and
 *  dropping either would lose a channel the merged card is supposed to
 *  cover. */
function OutcomeBars({ channels }: { channels: ReportChannel[] }) {
  const pal = useChartPalette();
  const rows = channels.filter(
    (c) => c.leads + c.scheduled + c.meetings > 0 || c.budget > 0 || c.spend > 0,
  );
  if (!rows.length)
    return <div className="rpt-empty rpt-empty-sm">אין נתוני משפך או תקציב</div>;
  const data = rows.map((c) => {
    const over = c.budget > 0 && c.spend > c.budget;
    return {
      channel: c.channel,
      name: c.channel,
      leads: c.leads,
      scheduled: c.scheduled,
      meetings: c.meetings,
      spend: c.spend,
      // Pale top of the money column. Zero when there is no budget to
      // compare against (the column is then just the spend) or when the
      // spend has already passed it.
      remain: c.budget > 0 ? Math.max(0, c.budget - c.spend) : 0,
      budget: c.budget,
      over,
      pct: c.budget > 0 ? Math.round((c.spend / c.budget) * 100) : null,
    };
  });
  const SERIES = [
    { key: "leads", label: "לידים", color: "#6366f1" },
    { key: "scheduled", label: "תיאומים", color: "#ec4899" },
    { key: "meetings", label: "ביצועים", color: "#f5576c" },
  ];
  const SPEND_COLOR = "#14b8a6";
  const OVER_COLOR = "#ef4444";
  const MONEY_LABELS = new Set(["עלות", "תקציב"]);
  // Listed in READING order — the legend row below is RTL, so this array is
  // literally what you read right-to-left: תקציב, עלות, לידים, תיאומים,
  // ביצועים. Money leads because the budget column is the frame the funnel
  // counts sit inside. Keep the labels in step with the Bar `name`s — a
  // hand-built legend no longer follows them automatically.
  const LEGEND = [
    { label: "תקציב", color: pal.deemph, faded: true },
    { label: "עלות", color: SPEND_COLOR },
    ...SERIES.map((s) => ({ label: s.label, color: s.color })),
  ];
  // Icon on top, channel name (truncated) below, without long Hebrew names
  // overrunning. Channels we actually buy on (Google Ads, Facebook, Yad2,
  // TikTok, Taboola, Outbrain) get their real brand mark — same rule list
  // and same components the table's ChLabel uses, so a channel wears one
  // face across the whole report. Everything with no brand to show
  // (כתבה, טלפוניה, שילוט…) keeps its emoji.
  const renderTick = (props: {
    x?: number | string;
    y?: number | string;
    payload?: { value?: string | number };
  }) => {
    const px = Number(props.x) || 0;
    const py = Number(props.y) || 0;
    const nm = String(props.payload?.value ?? "");
    const short = nm.length > 12 ? nm.slice(0, 11) + "…" : nm;
    const plat = channelPlatform(nm);
    return (
      <g transform={`translate(${px},${py})`}>
        {plat ? (
          // PlatformIcon renders its own <svg> with a 0 0 24 24 viewBox;
          // nesting it keeps that artwork intact inside the chart's
          // coordinate space. The translate centres the 14px mark (−7)
          // and drops it to the emoji's optical baseline.
          <g transform="translate(-7,3)">
            <PlatformIcon platform={plat} size={14} />
          </g>
        ) : (
          <text textAnchor="middle" y={13} fontSize={14}>
            {icon(nm)}
          </text>
        )}
        <text textAnchor="middle" y={26} fontSize={9} fill={pal.tick}>
          {short}
        </text>
      </g>
    );
  };
  return (
    <div className="rpt-scatter" dir="ltr">
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={data} margin={{ top: 18, right: 4, bottom: 26, left: 8 }} barCategoryGap="16%">
          <CartesianGrid stroke={pal.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="channel" tick={renderTick} interval={0} height={40} />
          <YAxis
            yAxisId="count"
            tick={{ fill: pal.tick, fontSize: 11 }}
            width={34}
            allowDecimals={false}
          />
          {/* Money axis. Abbreviated to ₪NNk so long budgets (₪17,391)
              don't eat the plot width the funnel columns need. */}
          <YAxis
            yAxisId="ils"
            orientation="right"
            tick={{ fill: pal.tick, fontSize: 10 }}
            width={44}
            tickFormatter={(v: number) =>
              v >= 1000 ? `₪${Math.round(v / 1000)}k` : fmtILS(v)
            }
          />
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
            labelFormatter={(_l, p) => {
              const d = p && p[0] ? (p[0].payload as (typeof data)[number]) : null;
              if (!d) return "";
              // Carry the utilization into the tooltip title — it's the one
              // number the retired card put on screen that no single column
              // segment states outright.
              return d.budget > 0
                ? `${d.name} · ${d.pct}% מהתקציב (${fmtILS(d.budget)})`
                : d.name;
            }}
            formatter={(v, n, item) => {
              const label = String(n);
              if (label === "תקציב") {
                // The bar's own value is the unspent REMAINDER — that's what
                // stacks on top of עלות. The tooltip still names the whole
                // budget, which is the number anyone reading it expects.
                const row = (item as { payload?: (typeof data)[number] })
                  ?.payload;
                return [fmtILS(row?.budget ?? 0), label];
              }
              return MONEY_LABELS.has(label)
                ? [fmtILS(Number(v) || 0), label]
                : [fmtInt(Number(v) || 0), label];
            }}
          />
          <Legend content={<OutcomeLegend items={LEGEND} />} />
          {SERIES.map((s) => (
            <Bar
              key={s.key}
              yAxisId="count"
              dataKey={s.key}
              name={s.label}
              fill={s.color}
              radius={[3, 3, 0, 0]}
              maxBarSize={18}
            >
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
          {/* Money column: spend (teal, red when over) stacked under the
              unspent remainder (pale), so the filled proportion IS the
              utilization. Per-channel color needs Cells — a flat `fill`
              can't turn red for one channel and not another — but `fill`
              is still set, because the Cells are invisible to anything
              that asks the Bar for its color. */}
          <Bar
            yAxisId="ils"
            dataKey="spend"
            name="עלות"
            stackId="bud"
            fill={SPEND_COLOR}
            maxBarSize={18}
          >
            {data.map((d) => (
              <Cell key={d.channel} fill={d.over ? OVER_COLOR : SPEND_COLOR} />
            ))}
          </Bar>
          <Bar
            yAxisId="ils"
            dataKey="remain"
            name="תקציב"
            stackId="bud"
            fill={pal.deemph}
            fillOpacity={0.35}
            radius={[3, 3, 0, 0]}
            maxBarSize={18}
          >
            {/* Sits on the remainder (the stack's top segment) so the %
                lands above the whole column — including when the remainder
                is zero and the top segment is the red overshoot. */}
            <LabelList
              dataKey="pct"
              position="top"
              formatter={(v) => (v == null || v === "" ? "" : `${v}%`)}
              style={{ fill: pal.tick, fontSize: 10, fontWeight: 700 }}
            />
          </Bar>
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
        <div className="rpt-ch-chart-box rpt-scatter-box rpt-scatter-box-held">
          <h4>
            <span className="rpt-scatter-h4-tag">🤝 ביצועים ·</span> יעילות
            ערוצים — ביצועים מול עלות לביצוע
          </h4>
          <EffScatter
            channels={channels}
            costKey="costPerMeeting"
            countKey="meetings"
            costLabel="עלות לביצוע"
            countLabel="ביצועים"
            emptyText="אין פגישות שהתקיימו"
            color="#f5576c"
            variant="held"
            xTitle="עלות לביצוע (₪) — שמאלה = יעיל יותר"
            yTitle="כמות ביצועים — למעלה = יותר"
          />
          <ScatterLegend channels={channels} costKey="costPerMeeting" countKey="meetings" />
        </div>
        <div className="rpt-ch-chart-box">
          <h4>לידים, תיאומים וביצועים מול תקציב לפי ערוץ</h4>
          <OutcomeBars channels={channels} />
        </div>
      </div>
    </div>
  );
}
