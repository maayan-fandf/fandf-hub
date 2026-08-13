"use client";

import { useState } from "react";
// `import type` ONLY — see the note in Ga4CampaignTree.tsx. lib/ga4Report
// reaches googleapis through lib/sa, and a runtime value import from a
// client component drags node's `net` into the browser bundle and 500s
// the entire project page.
import type { Ga4Demographics as Ga4DemographicsData } from "@/lib/ga4Report";

/** Which metric the bars measure. Users is the default: it is the one
 *  that always has data, since key events among identified users are a
 *  slice of a slice and are often in single digits. */
type DemoMetric = "users" | "keyEvents";

const DEMO_METRICS: { id: DemoMetric; label: string }[] = [
  { id: "users", label: "משתמשים" },
  { id: "keyEvents", label: "אירועי מפתח" },
];

/**
 * Age brackets as grouped bars split by gender, matching the shape used
 * in Meta Ads Manager so the two read the same way side by side.
 *
 * The known-share caption is mandatory, not decorative: only signed-in
 * Google users with ads personalisation get classified, which was 15% on
 * this landing page and 21-32% property-wide. Every bar describes that
 * minority, so the denominator is stated in words and each percentage is
 * explicitly "of the identified users".
 *
 * There is no 13-17 column, unlike Meta's chart — GA4 never classifies
 * under-18s, so its absence here is a schema fact rather than zero data.
 *
 * The metric toggle needs no extra GA4 request: age x gender is already
 * fetched with both totalUsers and keyEvents on the same cells, so the
 * key-event view is a re-read of data the page has, not a second query.
 */
export default function Ga4Demographics({
  d,
  siteKeyEvents = 0,
}: {
  d: Ga4DemographicsData;
  /** Key events for the whole window, for the caption's denominator —
   *  the point being that the identified users hold only a slice. */
  siteKeyEvents?: number;
}) {
  const [metric, setMetric] = useState<DemoMetric>("users");
  const rows = d.rows;

  const demoKeyEvents = d.maleKeyEvents + d.femaleKeyEvents;
  // Nothing to switch to when Google Signals identified nobody who
  // converted — an empty axis is worse than no toggle. This also means
  // the key-event branch below always has a non-zero denominator.
  const canSwitch = demoKeyEvents > 0;
  const showKe = canSwitch && metric === "keyEvents";

  if (rows.length === 0) return null;

  const male = (r: (typeof rows)[number]) => (showKe ? r.maleKeyEvents : r.male);
  const female = (r: (typeof rows)[number]) =>
    showKe ? r.femaleKeyEvents : r.female;

  // Sized to roughly the panel width so the SVG renders near 1:1 rather
  // than being capped narrow and left stranded against one edge — it was
  // 544px inside a 925px block with 381px of dead space beside it. A
  // uniform upscale was not the answer either: it magnifies the 8px axis
  // text along with the bars, which is what made this block "comically
  // big" earlier. Widening the viewBox keeps type at its designed size.
  const W = 880;
  const H = 210;
  const PAD_B = 30;
  const PAD_T = 12;
  // Gutter reserved for the y-axis labels. Without it the plot started
  // at x=0 while the tick text ran to x=28, so the first bracket's bar
  // was drawn straight over "120" / "100" / "80".
  const PAD_L = 46;
  const max = Math.max(...rows.flatMap((r) => [male(r), female(r)]), 1);
  // A "nice" step from the 1/2/5 series, so gridlines land on round
  // numbers AND the top sits just above the tallest bar. Rounding to
  // tens instead put the axis at 120 for a max of 95 — a quarter of the
  // chart was empty headroom. The series starts at 1, so the key-event
  // view's small counts get whole-number ticks rather than fractions.
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const slot = (W - PAD_L) / rows.length;
  // Bar width tracks the slot so a 6-bracket chart and a 3-bracket one
  // both fill their slots; the cap stops a two-bracket chart rendering
  // two slabs.
  const barW = Math.min(48, slot / 2.6);
  const y = (v: number) => PAD_T + (1 - v / top) * (H - PAD_T - PAD_B);

  const share = d.totalUsers > 0 ? d.knownUsers / d.totalUsers : 0;
  const known = Math.max(1, d.knownUsers);
  const keDenom = Math.max(1, demoKeyEvents);

  return (
    <div className="ga4w-block">
      <div className="ga4w-tree-head">
        <h3 className="ga4w-h3">התפלגות גיל ומגדר</h3>
        {canSwitch && (
          <div className="ga4w-viewsw" role="group" aria-label="מדד">
            {DEMO_METRICS.map((m) => (
              <button
                key={m.id}
                type="button"
                className={"ga4w-viewsw-btn" + (m.id === metric ? " is-active" : "")}
                aria-pressed={m.id === metric}
                onClick={() => setMetric(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ga4w-note ga4w-demo-caveat">
        Google מזהה גיל ומגדר רק עבור חלק מהגולשים (מחוברים לחשבון Google עם
        התאמה אישית של מודעות). כאן זוהו {fmtInt(d.knownUsers)} מתוך{" "}
        {fmtInt(d.totalUsers)} משתמשים — {fmtPct(share)}. כל האחוזים הם מתוך
        המזוהים בלבד.
        {showKe && (
          <>
            {" "}
            לכן גם אירועי המפתח כאן נספרים רק עבור המזוהים —{" "}
            {siteKeyEvents > 0
              ? `${fmtInt(demoKeyEvents)} מתוך ${fmtInt(siteKeyEvents)} אירועי המפתח בתקופה`
              : keyEventWord(demoKeyEvents)}
            .
          </>
        )}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="ga4w-demo-chart"
        role="img"
        aria-label={
          showKe ? "אירועי מפתח לפי גיל ומגדר" : "התפלגות גיל ומגדר"
        }
      >
        {Array.from({ length: top / step + 1 }, (_, i) => i * step).map((v) => (
          <g key={v}>
            <line className="ga4w-demo-grid-line" x1={PAD_L} x2={W} y1={y(v)} y2={y(v)} />
            <text className="ga4w-demo-tick" x={PAD_L - 8} y={y(v) + 4}>
              {v}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const cx = PAD_L + i * slot + slot / 2;
          return (
            <g key={r.bucket}>
              <rect
                className="ga4w-demo-bar is-male"
                x={cx - barW - 1}
                y={y(male(r))}
                width={barW}
                height={Math.max(0, y(0) - y(male(r)))}
              >
                <title>
                  {tip("גברים", "גברים מזוהים", r.bucket, showKe, r.maleKeyEvents, r.male)}
                </title>
              </rect>
              <rect
                className="ga4w-demo-bar is-female"
                x={cx + 1}
                y={y(female(r))}
                width={barW}
                height={Math.max(0, y(0) - y(female(r)))}
              >
                <title>
                  {tip("נשים", "נשים מזוהות", r.bucket, showKe, r.femaleKeyEvents, r.female)}
                </title>
              </rect>
              <text className="ga4w-demo-xlbl" x={cx} y={H - 9}>
                {r.bucket}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="ga4w-demo-legend">
        <Leg
          dot="is-male"
          label="גברים"
          denomLabel="גברים מזוהים"
          showKe={showKe}
          users={d.maleUsers}
          keyEvents={d.maleKeyEvents}
          share={showKe ? d.maleKeyEvents / keDenom : d.maleUsers / known}
        />
        <Leg
          dot="is-female"
          label="נשים"
          denomLabel="נשים מזוהות"
          showKe={showKe}
          users={d.femaleUsers}
          keyEvents={d.femaleKeyEvents}
          share={showKe ? d.femaleKeyEvents / keDenom : d.femaleUsers / known}
        />
      </div>
    </div>
  );
}

/**
 * One legend entry. The share is always of the metric on display, and
 * the trailing clause names its own denominator in words — "45 (42%)"
 * beside "398 משתמשים" invites reading the percentage as 45 of 398,
 * which is a different and much smaller number.
 */
function Leg({
  dot,
  label,
  denomLabel,
  showKe,
  users,
  keyEvents,
  share,
}: {
  dot: string;
  label: string;
  denomLabel: string;
  showKe: boolean;
  users: number;
  keyEvents: number;
  share: number;
}) {
  return (
    <div className="ga4w-demo-leg">
      <span className={`ga4w-dot ${dot}`} aria-hidden="true" />
      <strong>{label}</strong>
      <span>{fmtPct(share)}</span>
      {showKe ? (
        <em>
          {keyEventWord(keyEvents)} מתוך {fmtInt(users)} {denomLabel}
        </em>
      ) : (
        <em>
          {fmtInt(users)} {denomLabel}
          {keyEvents > 0 && `, ${keyEventWord(keyEvents)}`}
        </em>
      )}
    </div>
  );
}

/** The key-event tooltip carries its own denominator: 2 key events reads
 *  very differently against 8 identified users than against 140, and the
 *  bar alone cannot show that. */
function tip(
  gender: string,
  denomLabel: string,
  bucket: string,
  showKe: boolean,
  keyEvents: number,
  users: number,
): string {
  if (!showKe) return `${gender} ${bucket}: ${fmtInt(users)}`;
  return `${gender} ${bucket}: ${keyEventWord(keyEvents)} מתוך ${fmtInt(users)} ${denomLabel}`;
}

/**
 * The smallest round step from the 1 / 2 / 5 x 10^n series that keeps
 * the axis to at most MAX_TICKS gridlines.
 *
 * Chosen this way round, rather than by rounding a target step upward:
 * for a tallest bar of 95 the target-based version returned 50 — an axis
 * with two gridlines — while rounding to tens returned an axis top of
 * 120, a quarter of the chart in empty headroom. Smallest-step-that-fits
 * gives 20 (five gridlines, top 100, 5% headroom).
 */
// 6, not 5: at 5 a tallest bar of ~110 rejects step 20 (six gridlines)
// and falls to step 50, topping the axis at 150 and leaving the bar at
// 73% of the plot. Six gridlines read fine in a 154px plot and keep
// headroom near 9%.
const MAX_TICKS = 6;

function niceStep(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  for (let exp = 0; exp < 12; exp++) {
    const mag = Math.pow(10, exp);
    for (const m of [1, 2, 5]) {
      const step = m * mag;
      if (Math.ceil(max / step) <= MAX_TICKS) return step;
    }
  }
  return Math.pow(10, 12);
}

/** "1 אירועי מפתח" is broken Hebrew. */
function keyEventWord(n: number): string {
  return n === 1 ? "אירוע מפתח אחד" : `${fmtInt(n)} אירועי מפתח`;
}

function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
}
