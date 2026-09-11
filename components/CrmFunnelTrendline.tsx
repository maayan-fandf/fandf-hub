"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

/**
 * Daily trend over the cohort's date range. The bars stack the day's
 * לידים BY MEDIA CHANNEL (same source→color palette as the chips + the
 * source pie above), and תיאומי פגישות / ביצועי פגישות ride on top as
 * thin lines so the funnel-over-time stays readable. Hovering a day pops
 * a card with three mini pies — leads / scheduled / held — each broken
 * down by channel for that day. Pure SVG, no chart-lib dependency.
 *
 * The cohort is already pre-filtered server-side by the page's
 * monthOverride (lib/crmData.ts), and `bySource` is already narrowed to
 * the selected chips by the parent (CrmFunnelClient), so we render
 * whatever days/sources we're handed.
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

const LINE_META = [
  { key: "scheduled", label: "תיאומים", color: "#f59e0b" },
  { key: "held", label: "פגישות", color: "#10b981" },
] as const;

const FALLBACK_COLOR = "#9ca3af";

// SVG geometry — shared with the original line chart so the surrounding
// card sizing is unchanged.
const VB_W = 800;
const VB_H = 220;
const PAD_TOP = 8;
const PAD_BOTTOM = 26;
const PAD_START = 14; // viewBox left (oldest day)
const PAD_END = 48; // viewBox right — reserved for Y-axis labels

export default function CrmFunnelTrendline({
  dailyTimeSeries,
  selectedSources,
  sourceColors,
  title = "מגמה לאורך זמן — לידים לפי ערוץ",
  zeroDays,
  portalHover = false,
  fitWidth = false,
  height,
  legend = true,
}: {
  dailyTimeSeries: DailyTimeSeries;
  selectedSources: Set<string>;
  /** Stable source→hex map (the chips' palette) so a channel reads the
   *  same color in the bars, the hover pies and the legend. */
  sourceColors: Map<string, string>;
  /** null hides the heading — for a host that labels the chart itself. */
  title?: string | null;
  /**
   * Opt-in (the budget desk): mark days with NO leads instead of leaving an
   * empty slot, which reads as "no data" rather than "zero". Expects a series
   * that already holds every calendar day (fillDailySeries). A zero day on or
   * before `flagUntil` gets a red mark; a later one a grey mark — the CRM has
   * not reported it yet, so calling it zero would be a guess.
   */
  zeroDays?: {
    flagUntil: string;
    /** Leads per day INCLUDING ones with no source. A day with none drawn
     *  but some here had leads the bars cannot hold — not a zero day. */
    dayTotals?: Record<string, number>;
    /** Some sources are deselected (the project page's chips), so a day's
     *  hidden leads may simply be filtered out rather than sourceless. */
    filtered?: boolean;
  };
  /** Render the hover card into <body>, for hosts that clip their content
   *  (the budget desk's cards are overflow:hidden). */
  portalHover?: boolean;
  /** Draw at the rendered pixel width instead of stretching the 800-wide
   *  viewBox. The SVG is preserveAspectRatio="none", so a chart much wider
   *  or shorter than 800×220 would otherwise distort its own labels. */
  fitWidth?: boolean;
  /** Pixel height (default 220). */
  height?: number;
  /** false drops the channel legend under the chart — for a host short on
   *  room. The hover card still names every channel, with its counts, for
   *  the hovered day. */
  legend?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [measuredW, setMeasuredW] = useState<number | null>(null);
  const hasDays = dailyTimeSeries.length > 0;

  useEffect(() => {
    if (!fitWidth) return;
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width || 0);
      if (w > 0) setMeasuredW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitWidth, hasDays]);

  // A portaled card is placed in viewport coordinates when a day is
  // hovered; a scroll would leave it floating over the wrong spot.
  useEffect(() => {
    if (!portalHover || hover == null) return;
    const clear = () => setHover(null);
    window.addEventListener("scroll", clear, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", clear, { capture: true });
  }, [portalHover, hover]);

  const model = useMemo(() => {
    if (selectedSources.size === 0 || dailyTimeSeries.length === 0) return null;

    // Channel order: by total leads desc → biggest slice sits at the
    // bottom of each stack and first in every pie/legend.
    const leadTotal = new Map<string, number>();
    const present = new Set<string>();
    for (const day of dailyTimeSeries) {
      for (const s of day.bySource) {
        leadTotal.set(s.source, (leadTotal.get(s.source) || 0) + s.leads);
        if (s.leads || s.scheduledMeetings || s.meetings) present.add(s.source);
      }
    }
    const channels = [...present].sort(
      (a, b) => (leadTotal.get(b) || 0) - (leadTotal.get(a) || 0),
    );

    const days = dailyTimeSeries.map((day) => {
      const bySource = new Map(day.bySource.map((s) => [s.source, s]));
      let leads = 0,
        scheduled = 0,
        held = 0;
      for (const s of day.bySource) {
        leads += s.leads;
        scheduled += s.scheduledMeetings;
        held += s.meetings;
      }
      return { date: day.date, leads, scheduled, held, bySource };
    });

    const periodSched = days.reduce((a, d) => a + d.scheduled, 0);
    const periodHeld = days.reduce((a, d) => a + d.held, 0);

    return { channels, days, leadTotal, periodSched, periodHeld };
  }, [dailyTimeSeries, selectedSources]);

  if (!model) return null;
  const { channels, days, leadTotal, periodSched, periodHeld } = model;
  const n = days.length;
  if (n === 0) return null;

  const colorOf = (src: string) => sourceColors.get(src) || FALLBACK_COLOR;

  // Y axis is scaled to the busiest day's TOTAL leads (the stack height).
  // Scheduled/held lines share that axis — they're smaller, so they read
  // in the lower band, which is fine; the hover pies carry the detail.
  const rawMax = Math.max(...days.map((d) => d.leads), 1);
  const yMax = niceCeiling(rawMax * 1.1);

  // fitWidth: draw at the rendered pixel size so nothing stretches.
  const vbW = fitWidth && measuredW ? measuredW : VB_W;
  const vbH = height ?? VB_H;
  const plotW = vbW - PAD_START - PAD_END;
  const plotH = vbH - PAD_TOP - PAD_BOTTOM;
  const slotW = plotW / n;
  const barW = Math.min(slotW * 0.62, 46);

  const xCenter = (i: number) => PAD_START + slotW * (i + 0.5);
  const yAt = (v: number) => PAD_TOP + plotH - (v / yMax) * plotH;

  const linePath = (key: "scheduled" | "held") =>
    days
      .map(
        (d, i) =>
          `${i === 0 ? "M" : "L"} ${xCenter(i).toFixed(2)} ${yAt(d[key]).toFixed(2)}`,
      )
      .join(" ");

  // X-axis ticks — ~6 evenly spaced day labels. Under fitWidth the chart can
  // be narrow (a phone, the budget desk's strip), and six "dd/mm" labels need
  // ~46px each or they run together ("05/0906/09", seen at 342px). There the
  // count follows the width, and the labels step back evenly from the NEWEST
  // day — the one someone hunting for empty days is looking at.
  const tickIndexes: number[] = [];
  if (n === 1) tickIndexes.push(0);
  else if (fitWidth) {
    const maxTicks = Math.max(2, Math.floor(plotW / 46));
    const step = Math.max(1, Math.ceil((n - 1) / (maxTicks - 1)));
    for (let i = n - 1; i >= 0; i -= step) tickIndexes.push(i);
  } else {
    const tickCount = Math.min(n, 6);
    for (let i = 0; i < tickCount; i++)
      tickIndexes.push(Math.round((i * (n - 1)) / (tickCount - 1)));
  }

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);

  // Hover card placement: clamp the center so the card doesn't spill off
  // either edge of the (full-width) chart. left% maps linearly because
  // the SVG uses preserveAspectRatio="none".
  const hoverDay = hover != null ? days[hover] : null;
  const hoverLeftPct =
    hover != null
      ? Math.min(82, Math.max(18, (xCenter(hover) / vbW) * 100))
      : 50;

  return (
    <div className="crm-block crm-trend-block">
      {title && <div className="crm-block-title">{title}</div>}

      <div className="crm-trend-chartwrap" ref={wrapRef}>
        <svg
          viewBox={`0 0 ${vbW} ${vbH}`}
          className="crm-trend-svg"
          style={height ? { height } : undefined}
          role="img"
          aria-label="מגמת לידים לפי ערוץ מדיה, עם תיאומי פגישות וביצועי פגישות, לאורך התקופה"
          preserveAspectRatio="none"
          onMouseLeave={() => setHover(null)}
        >
          {/* Y gridlines + labels */}
          {yTicks.map((v) => (
            <g key={v} className="crm-trend-grid">
              <line x1={PAD_START} x2={vbW - PAD_END} y1={yAt(v)} y2={yAt(v)} />
              <text
                x={vbW - PAD_END + 8}
                y={yAt(v) + 4}
                className="crm-trend-axis-label"
                textAnchor="start"
              >
                {Math.round(v)}
              </text>
            </g>
          ))}

          {/* X labels */}
          {tickIndexes.map((i) => {
            const [, mm, dd] = days[i].date.split("-");
            return (
              <text
                key={i}
                x={xCenter(i)}
                y={vbH - 6}
                className="crm-trend-axis-label"
                textAnchor="middle"
              >
                {dd}/{mm}
              </text>
            );
          })}

          {/* Hover highlight band behind the hovered day */}
          {hover != null && (
            <rect
              className="crm-trend-hilite"
              x={PAD_START + slotW * hover}
              y={PAD_TOP}
              width={slotW}
              height={plotH}
            />
          )}

          {/* Stacked leads bars, by channel (largest at the bottom) */}
          {days.map((d, i) => {
            let cum = 0;
            const x = xCenter(i) - barW / 2;
            return (
              <g key={i} className="crm-trend-bar-group">
                {channels.map((ch) => {
                  const v = d.bySource.get(ch)?.leads ?? 0;
                  if (v <= 0) return null;
                  const yTop = yAt(cum + v);
                  const h = yAt(cum) - yTop;
                  cum += v;
                  return (
                    <rect
                      key={ch}
                      x={x}
                      y={yTop}
                      width={barW}
                      height={Math.max(h, 0.4)}
                      fill={colorOf(ch)}
                      className="crm-trend-bar"
                    />
                  );
                })}
              </g>
            );
          })}

          {/* Opt-in zero-day marks — see the zeroDays prop. */}
          {zeroDays &&
            days.map((d, i) =>
              d.leads > 0 || (zeroDays.dayTotals?.[d.date] ?? 0) > 0 ? null : (
                <rect
                  key={`z${i}`}
                  x={xCenter(i) - barW / 2}
                  y={yAt(0) - 4}
                  width={barW}
                  height={4}
                  rx={1}
                  className={
                    d.date <= zeroDays.flagUntil
                      ? "crm-trend-zero"
                      : "crm-trend-nodata"
                  }
                />
              ),
            )}

          {/* Scheduled / held lines on top */}
          {LINE_META.map(({ key, color }) => (
            <g key={key}>
              <path
                d={linePath(key)}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={key === "held" ? "4 3" : undefined}
              />
              {days.map((d, i) => (
                <circle
                  key={i}
                  cx={xCenter(i)}
                  cy={yAt(d[key])}
                  r={2.5}
                  fill={color}
                />
              ))}
            </g>
          ))}

          {/* Invisible per-day hover targets (full plot height) */}
          {days.map((d, i) => (
            <rect
              key={i}
              x={PAD_START + slotW * i}
              y={PAD_TOP}
              width={slotW}
              height={plotH}
              fill="transparent"
              className="crm-trend-hit"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>

        {/* Hover card — three channel-segmented pies for the hovered day */}
        {hoverDay && (
          <HoverLayer portal={portalHover} anchor={wrapRef} leftPct={hoverLeftPct}>
            <div className="crm-trend-hover-date">{formatDate(hoverDay.date)}</div>
            {zeroDays &&
              hoverDay.leads === 0 &&
              (() => {
                // Leads that day which no bar shows: sourceless, or (with the
                // chips narrowed) from a deselected source.
                const hidden = zeroDays.dayTotals?.[hoverDay.date] ?? 0;
                const counted = hoverDay.date <= zeroDays.flagUntil;
                return (
                  <div
                    className={`crm-trend-hover-status${
                      hidden === 0 && counted ? " is-zero" : ""
                    }`}
                  >
                    {hidden > 0
                      ? zeroDays.filtered
                        ? `${hidden} לידים ביום הזה לא מוצגים — ממקור שלא נבחר או בלי מקור הגעה`
                        : `${hidden} לידים בלי מקור הגעה ביום הזה — אין להם עמודה`
                      : counted
                        ? "לא נכנסו לידים ביום הזה"
                        : "ה-CRM עוד לא דיווח על היום הזה"}
                  </div>
                );
              })()}
            <div className="crm-trend-pies">
              {(
                [
                  { metric: "leads", label: "לידים", total: hoverDay.leads },
                  { metric: "scheduledMeetings", label: "תיאומים", total: hoverDay.scheduled },
                  { metric: "meetings", label: "פגישות", total: hoverDay.held },
                ] as const
              ).map(({ metric, label, total }) => (
                <div key={metric} className="crm-trend-pie">
                  <MiniPie
                    segments={channels.map((ch) => ({
                      color: colorOf(ch),
                      value: hoverDay.bySource.get(ch)?.[metric] ?? 0,
                    }))}
                    total={total}
                  />
                  <span className="crm-trend-pie-label">{label}</span>
                  <span className="crm-trend-pie-total">{total}</span>
                </div>
              ))}
            </div>
            {/* Per-day channel legend — only channels active that day */}
            <ul className="crm-trend-hover-legend">
              {channels
                .filter((ch) => {
                  const s = hoverDay.bySource.get(ch);
                  return s && (s.leads || s.scheduledMeetings || s.meetings);
                })
                .map((ch) => {
                  const s = hoverDay.bySource.get(ch)!;
                  return (
                    <li key={ch}>
                      <span
                        className="crm-trend-legend-dot"
                        style={{ background: colorOf(ch) }}
                      />
                      <span className="crm-trend-hover-legend-name">{ch}</span>
                      <span className="crm-trend-hover-legend-nums">
                        {s.leads}/{s.scheduledMeetings}/{s.meetings}
                      </span>
                    </li>
                  );
                })}
            </ul>
          </HoverLayer>
        )}
      </div>

      {/* Legend: one swatch per channel (bars) + the two overlay lines. */}
      {legend && (
        <ul className="crm-trend-legend">
          {channels.map((ch) => (
            <li key={ch}>
              <span className="crm-trend-legend-dot" style={{ background: colorOf(ch) }} />
              <span className="crm-trend-legend-label">{ch}</span>
              <span className="crm-trend-legend-sum">{leadTotal.get(ch) || 0}</span>
            </li>
          ))}
          <li className="crm-trend-legend-sep">
            <span className="crm-trend-legend-line" style={{ background: "#f59e0b" }} />
            <span className="crm-trend-legend-label">תיאומים</span>
            <span className="crm-trend-legend-sum">{periodSched}</span>
          </li>
          <li>
            <span
              className="crm-trend-legend-line crm-trend-legend-line-dash"
              style={{ background: "#10b981" }}
            />
            <span className="crm-trend-legend-label">פגישות</span>
            <span className="crm-trend-legend-sum">{periodHeld}</span>
          </li>
        </ul>
      )}
    </div>
  );
}

/**
 * The hover card's positioning shell. Inline (the default) it sits above the
 * chart inside `.crm-trend-chartwrap`, as it always has. With `portal` it
 * renders into <body> at fixed viewport coordinates — the budget desk's
 * cards are overflow:hidden, and an inline card popping above the chart
 * would be cut off at the card's top edge.
 */
function HoverLayer({
  portal,
  anchor,
  leftPct,
  children,
}: {
  portal: boolean;
  anchor: RefObject<HTMLDivElement | null>;
  leftPct: number;
  children: ReactNode;
}) {
  if (!portal) {
    return (
      <div
        className="crm-trend-hover"
        style={{ left: `${leftPct}%` }}
        role="presentation"
      >
        {children}
      </div>
    );
  }
  const r = anchor.current?.getBoundingClientRect();
  if (!r || typeof document === "undefined") return null;
  // ~230px is the card with three pies and a short legend; with less room
  // than that above the chart, open below it instead.
  const below = r.top < 240;
  return createPortal(
    <div
      className={`crm-trend-hover is-portal${below ? " is-below" : ""}`}
      style={{
        left: r.left + (r.width * leftPct) / 100,
        top: below ? r.bottom + 8 : r.top - 8,
      }}
      role="presentation"
    >
      {children}
    </div>,
    document.body,
  );
}

/** Small donut-less pie (56×56). Renders a hollow ring when total = 0. */
function MiniPie({
  segments,
  total,
}: {
  segments: { color: string; value: number }[];
  total: number;
}) {
  const r = 27,
    cx = 28,
    cy = 28;
  if (total <= 0) {
    return (
      <svg viewBox="0 0 56 56" className="crm-trend-pie-svg" aria-hidden>
        <circle cx={cx} cy={cy} r={r} className="crm-trend-pie-empty" />
      </svg>
    );
  }
  const arcs: { d: string; fill: string }[] = [];
  let cum = 0;
  for (const seg of segments) {
    if (seg.value <= 0) continue;
    const start = cum / total;
    cum += seg.value;
    const end = cum / total;
    if (end - start < 0.0001) continue;
    if (end - start >= 0.9999) {
      arcs.push({ d: `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`, fill: seg.color });
      continue;
    }
    const a0 = start * 2 * Math.PI - Math.PI / 2;
    const a1 = end * 2 * Math.PI - Math.PI / 2;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const large = end - start > 0.5 ? 1 : 0;
    arcs.push({
      d: `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`,
      fill: seg.color,
    });
  }
  return (
    <svg viewBox="0 0 56 56" className="crm-trend-pie-svg" aria-hidden>
      {arcs.map((a, i) => (
        <path key={i} d={a.d} fill={a.fill} />
      ))}
    </svg>
  );
}

/** Round up to a "nice" axis ceiling — 1/2/5 × 10^n. */
function niceCeiling(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const m = raw / base;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return nice * base;
}

function formatDate(iso: string): string {
  const [y, mm, dd] = iso.split("-");
  return `${dd}/${mm}/${y}`;
}
