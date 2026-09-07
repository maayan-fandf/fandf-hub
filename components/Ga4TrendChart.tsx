"use client";

import { useMemo, useRef, useState } from "react";
import type { Ga4Point } from "@/lib/ga4Report";

/**
 * Daily sessions + key events, as an inline SVG chart with two scales.
 *
 * Deliberately not a bar chart: 28 bars at panel width in RTL reads as
 * noise. Deliberately not plotting the previous period as a second series
 * either — it doubles the ink for a comparison the KPI deltas already
 * carry precisely.
 *
 * TWO AXES, ONE GRID. Key events run one to two orders of magnitude below
 * sessions, so they get their own scale — on a shared axis the line sits
 * flat on the floor and reads as zero. That used to be a footnote under
 * the chart ("הקווים בקנה מידה נפרד"), which is a caption asking the
 * reader to take the drawing on trust. Now each gridline is labelled on
 * BOTH sides — sessions on the left, key events on the right, each in its
 * series' colour — so the separate scales are a thing you can see instead
 * of a thing you are told.
 *
 * HOVER READS THE DAY. A trend line answers "which way" and hides "how
 * much on the 4th". Moving the pointer across the plot snaps to the
 * nearest day and shows both numbers for it. The whole plot is one
 * pointer target rather than 28 hit areas: at this width a day is ~26px
 * and per-point targets would make the readout flicker between
 * neighbours.
 *
 * Client component because of that interaction; everything it draws is
 * computed from props, so the server still renders the finished chart on
 * first paint.
 */

const W = 800;
const H = 172;
/** Room for the tick labels either side of the plot. */
const PAD_L = 46;
const PAD_R = 46;
const PAD_T = 10;
const PAD_B = 22;
/** Gridline count, floor included. */
const TICKS = 4;

function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

function fmtDate(isoDate: string): string {
  const clean = String(isoDate).replace(/-/g, "");
  if (clean.length !== 8) return isoDate;
  return `${clean.slice(6, 8)}/${clean.slice(4, 6)}`;
}

/** Long form for the tooltip — a bare "04/09" is ambiguous once the range
 *  crosses a year boundary, and the tooltip has room. */
function fmtDateLong(isoDate: string): string {
  const clean = String(isoDate).replace(/-/g, "");
  if (clean.length !== 8) return isoDate;
  return `${clean.slice(6, 8)}/${clean.slice(4, 6)}/${clean.slice(0, 4)}`;
}

/**
 * A tick scale whose top is a round number at or above the data's peak.
 * Ticks reading 0 / 119 / 238 / 357 / 477 are arithmetically correct and
 * useless — the point of an axis is that a reader can estimate off it.
 */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (m * mag >= v) return m * mag;
  }
  return 10 * mag;
}

export default function Ga4TrendChart({ points }: { points: Ga4Point[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geom = useMemo(() => {
    const maxSessions = niceMax(Math.max(...points.map((p) => p.sessions), 1));
    const maxKe = niceMax(Math.max(...points.map((p) => p.keyEvents), 1));
    const hasKe = points.some((p) => p.keyEvents > 0);
    const plotW = W - PAD_L - PAD_R;
    const step = points.length > 1 ? plotW / (points.length - 1) : 0;
    const x = (i: number) => PAD_L + i * step;
    const y = (v: number, max: number) =>
      H - PAD_B - (v / max) * (H - PAD_T - PAD_B);
    const path = (pick: (p: Ga4Point) => number, max: number) =>
      points
        .map(
          (p, i) =>
            `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(p), max).toFixed(1)}`,
        )
        .join(" ");
    const line = path((p) => p.sessions, maxSessions);
    return {
      maxSessions,
      maxKe,
      hasKe,
      x,
      y,
      line,
      area: `${line} L${x(points.length - 1).toFixed(1)},${H - PAD_B} L${x(0).toFixed(1)},${H - PAD_B} Z`,
      keLine: hasKe ? path((p) => p.keyEvents, maxKe) : "",
    };
  }, [points]);

  const peak = points.reduce(
    (a, b) => (b.sessions > a.sessions ? b : a),
    points[0],
  );

  /** Pointer x → nearest day. Measured against the rendered width, since
   *  the SVG scales to the panel and viewBox units are not screen px. */
  const onMove = (clientX: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const vx = ((clientX - r.left) / r.width) * W;
    const frac = (vx - PAD_L) / (W - PAD_L - PAD_R);
    const i = Math.round(frac * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  };

  const hp = hover == null ? null : points[hover];
  // Flip the tooltip to the other side of the guide near the edges so it
  // never runs off the panel.
  const hoverFrac = hover == null ? 0 : geom.x(hover) / W;
  const flip = hoverFrac > 0.62;

  const ticks = Array.from({ length: TICKS + 1 }, (_, k) => k / TICKS);

  return (
    <div className="ga4w-chart">
      <div
        className="ga4w-chart-plot"
        ref={wrapRef}
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerDown={(e) => onMove(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="כניסות ואירועי מפתח יומיים"
        >
          {ticks.map((t) => {
            const gy = H - PAD_B - t * (H - PAD_T - PAD_B);
            return (
              <g key={t}>
                <line
                  className={
                    t === 0 ? "ga4w-grid ga4w-grid-base" : "ga4w-grid"
                  }
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={gy}
                  y2={gy}
                />
                <text
                  className="ga4w-tick is-sessions"
                  x={PAD_L - 8}
                  y={gy + 3.5}
                  textAnchor="end"
                >
                  {fmtInt(t * geom.maxSessions)}
                </text>
                {geom.hasKe && (
                  <text
                    className="ga4w-tick is-ke"
                    x={W - PAD_R + 8}
                    y={gy + 3.5}
                    textAnchor="start"
                  >
                    {fmtInt(t * geom.maxKe)}
                  </text>
                )}
              </g>
            );
          })}

          <path className="ga4w-chart-area" d={geom.area} />
          <path className="ga4w-chart-line" d={geom.line} />
          {geom.hasKe && <path className="ga4w-chart-ke" d={geom.keLine} />}

          {hover != null && hp && (
            <g className="ga4w-hover">
              <line
                className="ga4w-hover-guide"
                x1={geom.x(hover)}
                x2={geom.x(hover)}
                y1={PAD_T}
                y2={H - PAD_B}
              />
              <circle
                className="ga4w-hover-dot is-sessions"
                cx={geom.x(hover)}
                cy={geom.y(hp.sessions, geom.maxSessions)}
                r={3.6}
              />
              {geom.hasKe && (
                <circle
                  className="ga4w-hover-dot is-ke"
                  cx={geom.x(hover)}
                  cy={geom.y(hp.keyEvents, geom.maxKe)}
                  r={3.6}
                />
              )}
            </g>
          )}
        </svg>

        {hp && (
          <div
            className={"ga4w-tip" + (flip ? " is-flip" : "")}
            style={{ left: `${hoverFrac * 100}%` }}
            role="status"
          >
            <div className="ga4w-tip-date">{fmtDateLong(hp.date)}</div>
            <div className="ga4w-tip-row">
              <span className="ga4w-leg-swatch is-sessions" aria-hidden />
              כניסות
              <b>{fmtInt(hp.sessions)}</b>
            </div>
            {geom.hasKe && (
              <div className="ga4w-tip-row">
                <span className="ga4w-leg-swatch is-ke" aria-hidden />
                אירועי מפתח
                <b>{fmtInt(hp.keyEvents)}</b>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="ga4w-chart-axis">
        <span>{fmtDate(points[0].date)}</span>
        <span className="ga4w-chart-peak">
          שיא: {fmtInt(peak.sessions)} ב-{fmtDate(peak.date)}
        </span>
        <span>{fmtDate(points[points.length - 1].date)}</span>
      </div>

      {geom.hasKe && (
        <div className="ga4w-chart-legend">
          <span className="ga4w-leg">
            <span className="ga4w-leg-swatch is-sessions" aria-hidden="true" />
            כניסות <span className="ga4w-leg-axis">— ציר שמאל</span>
          </span>
          <span className="ga4w-leg">
            <span className="ga4w-leg-swatch is-ke" aria-hidden="true" />
            אירועי מפתח <span className="ga4w-leg-axis">— ציר ימין</span>
          </span>
          <span className="ga4w-leg-note">
            העבירו את העכבר על הגרף למספרים של יום מסוים
          </span>
        </div>
      )}
    </div>
  );
}
