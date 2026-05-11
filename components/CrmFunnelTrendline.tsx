"use client";

import { useMemo } from "react";

/**
 * Daily trendline showing three series (לידים / תיאומי פגישות /
 * ביצועי פגישות) over the cohort's date range. Pure-SVG line chart —
 * no chart-lib dependency, no canvas. Sensitive to the source chips
 * above (state passed in from CrmSourceAnalysis) so picking a subset
 * of channels narrows the lines accordingly.
 *
 * The cohort is already pre-filtered by the page's monthOverride
 * (server-side, in lib/crmData.ts), so we don't need to filter by
 * date here — just render whatever days the lib gave us.
 */

type DailyTimeSeries = {
  date: string; // YYYY-MM-DD
  bySource: {
    source: string;
    leads: number;
    scheduledMeetings: number;
    meetings: number;
  }[];
}[];

type SeriesPoint = { date: string; value: number };

const SERIES_META = [
  { key: "leads",             label: "לידים",         color: "#6366f1" },
  { key: "scheduledMeetings", label: "תיאומי פגישות", color: "#f59e0b" },
  { key: "meetings",          label: "ביצועי פגישות", color: "#10b981" },
] as const;

export default function CrmFunnelTrendline({
  dailyTimeSeries,
  selectedSources,
}: {
  dailyTimeSeries: DailyTimeSeries;
  selectedSources: Set<string>;
}) {
  // Sum per-day across selected sources. If selection is empty, we
  // render an empty placeholder rather than misleadingly showing the
  // raw totals — matches the pie's empty state above.
  const series = useMemo(() => {
    if (selectedSources.size === 0 || dailyTimeSeries.length === 0) {
      return null;
    }
    const out: Record<string, SeriesPoint[]> = {
      leads: [],
      scheduledMeetings: [],
      meetings: [],
    };
    for (const day of dailyTimeSeries) {
      let leads = 0, scheduledMeetings = 0, meetings = 0;
      for (const s of day.bySource) {
        if (!selectedSources.has(s.source)) continue;
        leads += s.leads;
        scheduledMeetings += s.scheduledMeetings;
        meetings += s.meetings;
      }
      out.leads.push({ date: day.date, value: leads });
      out.scheduledMeetings.push({ date: day.date, value: scheduledMeetings });
      out.meetings.push({ date: day.date, value: meetings });
    }
    return out;
  }, [dailyTimeSeries, selectedSources]);

  if (!series || series.leads.length === 0) return null;

  // Y axis: max value across all three series (so all three plot on
  // the same scale). Pad up by 10% so the peak isn't flush against
  // the top edge.
  const rawMax = Math.max(
    ...series.leads.map((p) => p.value),
    ...series.scheduledMeetings.map((p) => p.value),
    ...series.meetings.map((p) => p.value),
    1,
  );
  const yMax = niceCeiling(rawMax * 1.1);

  // Geometry: SVG is 800×220 viewBox. ~50px right pad for the
  // Y-axis labels, ~26px bottom pad for the X-axis labels.
  const PAD_TOP = 8;
  const PAD_BOTTOM = 26;
  const PAD_START = 14; // RTL: visually the right edge (start side)
  const PAD_END = 48;   // visually the left edge (end side) — reserved for Y axis labels
  const VB_W = 800;
  const VB_H = 220;
  const plotW = VB_W - PAD_START - PAD_END;
  const plotH = VB_H - PAD_TOP - PAD_BOTTOM;
  const n = series.leads.length;

  // X position per data point. Single-point case keeps the line in
  // the middle of the plot (avoids divide-by-zero edge).
  function xAt(i: number): number {
    if (n === 1) return PAD_START + plotW / 2;
    return PAD_START + (i / (n - 1)) * plotW;
  }
  function yAt(v: number): number {
    return PAD_TOP + plotH - (v / yMax) * plotH;
  }

  // Build a polyline path for each series.
  function pathFor(points: SeriesPoint[]): string {
    return points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(2)} ${yAt(p.value).toFixed(2)}`)
      .join(" ");
  }

  // X-axis ticks: show ~6 evenly-spaced date labels (or one per point
  // if there are ≤6).
  const tickCount = Math.min(n, 6);
  const tickIndexes: number[] = [];
  if (n === 1) tickIndexes.push(0);
  else {
    for (let i = 0; i < tickCount; i++) {
      tickIndexes.push(Math.round((i * (n - 1)) / (tickCount - 1)));
    }
  }
  // Y-axis ticks: 4 horizontal gridlines (0, 25%, 50%, 75%, 100% of yMax).
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);

  return (
    <div className="crm-block crm-trend-block">
      <div className="crm-block-title">מגמה לאורך זמן</div>
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="crm-trend-svg"
        role="img"
        aria-label="מגמת לידים, תיאומי פגישות וביצועי פגישות לאורך התקופה"
        preserveAspectRatio="none"
      >
        {/* Y-axis gridlines + labels */}
        {yTicks.map((v) => (
          <g key={v} className="crm-trend-grid">
            <line
              x1={PAD_START}
              x2={VB_W - PAD_END}
              y1={yAt(v)}
              y2={yAt(v)}
            />
            <text
              x={VB_W - PAD_END + 8}
              y={yAt(v) + 4}
              className="crm-trend-axis-label"
              textAnchor="start"
            >
              {Math.round(v)}
            </text>
          </g>
        ))}

        {/* X-axis labels — formatted DD/MM (the dataset is short-cohort,
            usually a single month, so day-month is sufficient). */}
        {tickIndexes.map((i) => {
          const d = series.leads[i].date;
          const [, mm, dd] = d.split("-");
          return (
            <text
              key={i}
              x={xAt(i)}
              y={VB_H - 6}
              className="crm-trend-axis-label"
              textAnchor="middle"
            >
              {dd}/{mm}
            </text>
          );
        })}

        {/* Three series, drawn in reverse so the most-important (leads)
            ends up on top. Add a small hover-target circle per
            data point with a native <title> tooltip. */}
        {SERIES_META.slice().reverse().map(({ key, color }) => {
          const points = series[key as keyof typeof series];
          return (
            <g key={key} className="crm-trend-series" data-series={key}>
              <path
                d={pathFor(points)}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {points.map((p, i) => (
                <circle
                  key={i}
                  cx={xAt(i)}
                  cy={yAt(p.value)}
                  r={3}
                  fill={color}
                  className="crm-trend-point"
                >
                  <title>{`${formatDateLong(p.date)} · ${labelFor(key)}: ${p.value}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      {/* Legend — three pills under the chart, dot + label. Read-only,
          no toggle; the source chips above are the user's filter knob. */}
      <ul className="crm-trend-legend">
        {SERIES_META.map(({ key, label, color }) => {
          const sum = series[key as keyof typeof series].reduce(
            (acc, p) => acc + p.value,
            0,
          );
          return (
            <li key={key}>
              <span
                className="crm-trend-legend-dot"
                style={{ background: color }}
              />
              <span className="crm-trend-legend-label">{label}</span>
              <span className="crm-trend-legend-sum">{sum}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Round up to a "nice" number for axis ceilings — 1/2/5 × 10^n. */
function niceCeiling(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const m = raw / base;
  let nice: number;
  if (m <= 1) nice = 1;
  else if (m <= 2) nice = 2;
  else if (m <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

function labelFor(key: string): string {
  return SERIES_META.find((m) => m.key === key)?.label ?? key;
}

function formatDateLong(iso: string): string {
  // "2026-05-12" → "12 במאי 26"-ish. Keep ASCII-safe: DD/MM/YYYY.
  const [y, mm, dd] = iso.split("-");
  return `${dd}/${mm}/${y}`;
}
