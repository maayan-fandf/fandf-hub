"use client";

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { channelIcon } from "@/lib/channelIcon";
import ChannelIcon from "@/components/ChannelIcon";
import { BasisDash, BasisNum } from "@/components/report/BasisBadge";
import { useMeetingBasis } from "@/components/report/MeetingBasisContext";
import { BASIS_COPY } from "@/lib/meetingBasis";
import {
  applyBasisToChannels,
  convTone,
  costPerTone,
  datedUnattributed,
  deltaInfo,
  fmtInt,
  fmtILS,
  totalsForBasis,
  type ProjectReportData,
  type ReportChannel,
  type DeltaInfo,
} from "@/lib/reportShared";

/** Legacy _KPI_PIE_PALETTE_ (Index.html:6617) — the per-channel slice
 *  colors for the funnel-card breakdown popover. */
const KPI_PIE_PALETTE = [
  "#6366f1", "#f59e0b", "#10b981", "#ec4899", "#0ea5e9",
  "#a855f7", "#ef4444", "#14b8a6", "#eab308", "#8b5cf6",
  "#22c55e", "#f97316", "#06b6d4", "#d946ef", "#84cc16",
];

/** Fill of the "לא שויכו לשורה" slice. Neutral slate, outside the channel
 *  palette on purpose: it is a remainder, not a channel, and must not read
 *  as a 16th one. Mid-tone so it holds on both the light and dark popover. */
const UNATTRIBUTED_FILL = "#94a3b8";

/** A pie slice that is not a ReportChannel row — the dated basis's
 *  unattributed remainder. `parent` is its own תיאומים (for the ביצועים
 *  pie's conversion), 0 where no conversion applies. */
type PieExtra = { count: number; parent: number };

/**
 * Per-channel breakdown pie + legend, shown on hover over a funnel card —
 * port of the legacy `_buildKpiPiePopover_` (Index.html:6622). Slices are
 * each channel's share of the card's metric; the legend adds the
 * conversion-from-parent-stage rate (scheduled/leads, meetings/scheduled).
 *
 * `channels` must already hold the page basis's numbers (the caller runs
 * applyBasisToChannels), and `total` must be the card's own figure. Under
 * "לפי מועד הפגישה" that figure is datedTotals, which includes meetings no
 * row could claim (datedSource unmatched + ambiguous: a lead with no
 * source, a channel with no spend row, a generic source that fits several
 * rows); `extra` carries them as a last "לא שויכו לשורה" slice so
 * the slices add up to the number on the card instead of silently leaving
 * a gap in the circle.
 */
function FunnelPie({
  channels,
  metricKey,
  parentKey,
  parentLabel,
  total,
  extra = null,
}: {
  channels: ReportChannel[];
  metricKey: "leads" | "scheduled" | "meetings";
  parentKey: "leads" | "scheduled" | null;
  parentLabel: string;
  total: number;
  extra?: PieExtra | null;
}) {
  if (total <= 0) return null;
  const rows: {
    channel: string;
    count: number;
    parent: number;
    unattributed?: boolean;
  }[] = channels
    .map((c) => ({
      channel: c.channel,
      count: Number(c[metricKey]) || 0,
      parent: parentKey ? Number(c[parentKey]) || 0 : 0,
    }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  // Last, whatever its size — the channels rank against each other, the
  // remainder is not in that ranking.
  if (extra && extra.count > 0) {
    rows.push({
      channel: BASIS_COPY.unattributedRow.label,
      count: extra.count,
      parent: parentKey ? extra.parent : 0,
      unattributed: true,
    });
  }
  if (!rows.length) return null;

  let cum = 0;
  const arcs: { d: string; fill: string; tip: string }[] = [];
  const legend: {
    fill: string;
    /** Emoji-prefixed string. Still needed for the `title` attribute and the
     *  SVG <title> tip, neither of which can hold an element — the visible
     *  legend renders <ChannelIcon> instead, so a channel with a real brand
     *  shows its logo rather than the emoji stand-in. */
    label: string;
    /** The legend row's hover text: `label`, or the explanation of what the
     *  unattributed remainder is. */
    tip: string;
    channel: string;
    count: number;
    pct: string;
    conv: string | null;
  }[] = [];
  rows.forEach((r, i) => {
    const startFrac = cum;
    cum += r.count / total;
    const endFrac = Math.min(cum, 1);
    const frac = endFrac - startFrac;
    const fill = r.unattributed
      ? UNATTRIBUTED_FILL
      : KPI_PIE_PALETTE[i % KPI_PIE_PALETTE.length];
    const pct = ((r.count / total) * 100).toFixed(1);
    const conv =
      parentKey && r.parent > 0
        ? `${((r.count / r.parent) * 100).toFixed(1)}%`
        : null;
    const label = `${channelIcon(r.channel) || "●"} ${r.channel}`.trim();
    if (frac >= 0.005) {
      const a0 = startFrac * 2 * Math.PI - Math.PI / 2;
      const a1 = endFrac * 2 * Math.PI - Math.PI / 2;
      const x0 = (50 + 50 * Math.cos(a0)).toFixed(2);
      const y0 = (50 + 50 * Math.sin(a0)).toFixed(2);
      const x1 = (50 + 50 * Math.cos(a1)).toFixed(2);
      const y1 = (50 + 50 * Math.sin(a1)).toFixed(2);
      const largeArc = frac > 0.5 ? 1 : 0;
      const tip =
        `${label} · ${r.count} (${pct}%)` +
        (conv ? ` · המרה מ${parentLabel}: ${conv}` : "");
      arcs.push({
        d: `M 50 50 L ${x0} ${y0} A 50 50 0 ${largeArc} 1 ${x1} ${y1} Z`,
        fill,
        tip,
      });
    }
    legend.push({
      fill,
      label,
      tip: r.unattributed ? BASIS_COPY.unattributedRow.title : label,
      channel: r.channel,
      count: r.count,
      pct,
      conv,
    });
  });
  if (!arcs.length) return null;

  return (
    <div className="rpt-ff-pop" aria-hidden>
      <div className="rpt-ff-pop-head">
        לפי ערוץ{parentKey ? ` · עם המרה מ${parentLabel}` : ""}
      </div>
      <div className="rpt-ff-pop-body">
        <svg viewBox="0 0 100 100" className="rpt-ff-pop-svg">
          {arcs.map((a, i) => (
            <path key={i} d={a.d} fill={a.fill}>
              <title>{a.tip}</title>
            </path>
          ))}
        </svg>
        <ul className="rpt-ff-pop-legend">
          {legend.map((l, i) => (
            <li key={i}>
              <span className="rpt-ff-pop-dot" style={{ background: l.fill }} />
              <span className="rpt-ff-pop-ch" title={l.tip}>
                <ChannelIcon name={l.channel} fallback="●" /> {l.channel}
              </span>
              <span className="rpt-ff-pop-count">
                {fmtInt(l.count)} ({l.pct}%)
              </span>
              {l.conv ? (
                <span
                  className="rpt-ff-pop-conv"
                  title={`המרה מ${parentLabel}`}
                >
                  ↑ {l.conv}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * CRM funnel flow — native rebuild of renderFunnelFlow (Index.html:6553),
 * the "ביצועים נוכחיים" section: לידים CRM → תיאומי פגישה → ביצועי פגישה
 * with a לידים רלוונטיים sub-node, conversion-rate connectors, cost-per
 * metas, and period-over-period delta badges. Connectors (exact legacy
 * pairs): relevant/leads (↓), scheduled/leads (card1→2), meetings/
 * scheduled (card2→3). Deltas vs prevFunnel, goodDir=up.
 *
 * MEETING BASIS (page-level switch, lib/meetingBasis). The תיאומי פגישה /
 * ביצועי פגישה cards, their עלות לתיאום / עלות לביצוע, the cost tone and
 * the hover pies all follow it; לידים does not (it has no basis).
 *
 *   לפי כניסת ליד   — data.totals, exactly as before the switch existed.
 *   לפי מועד הפגישה — data.datedTotals = Σ ערוצים rows' dated counts + the
 *                     unattributed remainder, so the cards equal the ערוצים
 *                     סה״כ row including its "לא שויכו לשורה" line. On The
 *                     57's September flight (measured 2026-09-16) that is
 *                     49 / 15 against 20 / 6 on lead entry — the same
 *                     spend divided by counts 2.5× larger, so the cost tone
 *                     can move a whole band on a flip. That is the point.
 *
 * What cannot follow under dated:
 *   • ליד→תיאום arrow — dated meetings over leads-by-entry is not a rate:
 *     the numerator includes meetings of leads from earlier months and
 *     leaves out this month's leads who book next month, so it reads as a
 *     conversion no lead cohort ever had and can pass 100%. "—" with the
 *     cross-basis tooltip. תיאום→ביצוע stays: dated over dated.
 *   • ▲/▼ deltas on the two meeting cards — prevFunnel is last month's
 *     ALL CLIENTS חודשי row, lead entry only; there is no dated history to
 *     compare against. Hidden, not badged: the לידים delta beside them is
 *     still valid and stays.
 *   • The ליד-share bar under each card still tapers by count ÷ leads; it
 *     is a shape, not a printed rate, and is clamped at a full bar.
 * A project with no dated source (datedTotals null) shows "—" on both
 * cards and their costs, and no pies — never the lead-entry number under a
 * "לפי מועד הפגישה" switch.
 */

function pct2(r: number | null): string {
  return r !== null ? `${(Math.round(r * 100 * 100) / 100).toString()}%` : "—";
}

function Delta({ d }: { d: DeltaInfo | null }) {
  if (!d) return null;
  if (d.cls === "new") return <span className="rpt-ff-delta is-new">חדש</span>;
  if (d.cls === "none" && d.text === "—")
    return <span className="rpt-ff-delta is-none">—</span>;
  const cls = d.cls === "good" ? "is-good" : d.cls === "bad" ? "is-bad" : "is-none";
  return (
    <span className={`rpt-ff-delta ${cls}`} title={`בתקופה הקודמת: ${fmtInt(d.prev)}`}>
      {d.arrow} {d.text}
    </span>
  );
}

/** `dash` replaces the rate with an explained "—" (BasisDash) — a ratio
 *  the current basis cannot form, as opposed to a plain "—" for a zero
 *  denominator. */
function Arrow({ rate, dash }: { rate: number | null; dash?: ReactNode }) {
  return (
    <div className="rpt-ff-arrow">
      <div className={`rpt-ff-rate is-${dash ? "none" : convTone(rate)}`}>
        {dash ?? pct2(rate)}
      </div>
      <div className="rpt-ff-arrow-line">
        <span className="rpt-ff-arrow-head">←</span>
      </div>
    </div>
  );
}

export default function ReportFunnelFlow({ data }: { data: ProjectReportData }) {
  const { basis } = useMeetingBasis();
  const dated = basis === "dated";
  // Pie rows on the page basis. Under dated only when the ערוצים rows carry
  // dated counts at all (datedSource) — otherwise there is nothing to slice
  // and the cards already show "—".
  const pieChannels = useMemo(
    () =>
      !dated
        ? data.channels
        : data.datedSource
          ? applyBasisToChannels(data.channels, "dated")
          : null,
    [data.channels, data.datedSource, dated],
  );
  const t = data.totals;
  if (!t) return null;
  const leads = t.leads || 0;
  const rel = t.relevant || 0;
  // null ⇒ this basis has no number for the project → "—" (see header).
  const mt = totalsForBasis(data, basis);
  const sched = mt ? mt.scheduled || 0 : null;
  const meet = mt ? mt.meetings || 0 : null;
  const cpl = leads > 0 ? t.spend / leads : 0;
  const cps = sched ? t.spend / sched : 0;
  const cpm = meet ? t.spend / meet : 0;
  const rRel = leads > 0 ? rel / leads : null;
  const rSched = !dated && sched !== null && leads > 0 ? sched / leads : null;
  const rMeet = sched ? (meet ?? 0) / sched : null;
  const prev = data.prevFunnel;
  // The remainder slice exists only on the dated basis (lead-entry rows sum
  // to the lead total by construction).
  const unattr =
    dated && data.datedSource ? datedUnattributed(data.datedSource) : null;
  const noNumber = <BasisDash reason="no-source" basis={basis} />;
  // ליד→תיאום under dated: "no number" when the basis has none, otherwise
  // the cross-basis explanation. undefined = print the rate as always.
  const leadToSchedDash = !dated
    ? undefined
    : sched === null
      ? noNumber
      : <BasisDash reason="cross-basis" />;

  // Per-card share of the top-of-funnel (leads) → drives the proportional
  // funnel share-bar along each card's bottom (CSS `--ff-share`). Clamped so
  // a tiny stage still shows a visible sliver, and at a full bar: meeting
  // EVENTS can outnumber leads (a client books, cancels, rebooks), and under
  // the dated basis they are not even the same cohort. Leads itself is the
  // full bar; a card with no number on this basis gets an empty one.
  const ffShare = (n: number | null): CSSProperties =>
    ({
      "--ff-share":
        n === null ? 0 : leads > 0 ? Math.min(1, Math.max(0.04, n / leads)) : 1,
    }) as CSSProperties;

  const monthLabel =
    data.mode === "month" ? data.window.startIso.slice(0, 7) : "";
  const title =
    data.mode === "month" ? `ביצועים בחודש ${monthLabel}` : "ביצועים נוכחיים";
  const ratioNote =
    prev && prev.ratioApplied < 1
      ? "הערכים של התקופה הקודמת הותאמו פרופורציונלית לפי יחס הימים, כדי להשוות תפוח לתפוח"
      : "";

  return (
    <section className="rpt-ff-section">
      <div className="rpt-ff-title">
        📊 {title}
        {ratioNote && (
          <span className="rpt-ff-note" title={ratioNote}>
            ↔ השוואה מותאמת ליחס ימים
          </span>
        )}
      </div>
      <div className="rpt-funnel-flow">
        {/* Card 1 — לידים CRM (+ relevant sub-node) */}
        <div className="rpt-ff-card is-lead" style={ffShare(leads)}>
          <div className="rpt-ff-label">לידים CRM</div>
          <div className="rpt-ff-value">{fmtInt(leads)}</div>
          <div className="rpt-ff-meta">
            עלות לליד: <b>{fmtILS(cpl)}</b>
          </div>
          <Delta d={prev ? deltaInfo(leads, prev.leads, "up") : null} />
          <div className="rpt-ff-sub">
            <div className="rpt-ff-sub-arrow">
              <span>↓</span>
              <span className={`rpt-ff-rate is-${convTone(rRel)}`}>{pct2(rRel)}</span>
            </div>
            <div className="rpt-ff-sub-card">
              <div className="rpt-ff-sub-label">לידים רלוונטיים</div>
              <div className="rpt-ff-sub-value">{fmtInt(rel)}</div>
            </div>
          </div>
          <FunnelPie
            channels={data.channels}
            metricKey="leads"
            parentKey={null}
            parentLabel="CRM"
            total={leads}
          />
        </div>

        <Arrow rate={rSched} dash={leadToSchedDash} />

        {/* Card 2 — תיאומי פגישה */}
        <div
          className={`rpt-ff-card is-sched rpt-ff-${costPerTone("costPerScheduled", cps)}`}
          style={ffShare(sched)}
        >
          <div className="rpt-ff-label">תיאומי פגישה</div>
          <div className="rpt-ff-value">
            <BasisNum value={sched} basis={basis} />
          </div>
          <div className="rpt-ff-meta">
            עלות לתיאום: <b>{sched === null ? noNumber : fmtILS(cps)}</b>
          </div>
          {!dated && sched !== null && (
            <Delta d={prev ? deltaInfo(sched, prev.scheduled, "up") : null} />
          )}
          {pieChannels && sched !== null && (
            <FunnelPie
              channels={pieChannels}
              metricKey="scheduled"
              // Under dated the legend's "המרה מלידים" would be the same
              // cross-basis ratio the arrow refuses to print.
              parentKey={dated ? null : "leads"}
              parentLabel="לידים"
              total={sched}
              extra={unattr ? { count: unattr.scheduled, parent: 0 } : null}
            />
          )}
        </div>

        <Arrow
          rate={rMeet}
          dash={dated && sched === null ? noNumber : undefined}
        />

        {/* Card 3 — ביצועי פגישה */}
        <div
          className={`rpt-ff-card is-meet rpt-ff-${costPerTone("costPerMeeting", cpm)}`}
          style={ffShare(meet)}
        >
          <div className="rpt-ff-label">ביצועי פגישה</div>
          <div className="rpt-ff-value">
            <BasisNum value={meet} basis={basis} />
          </div>
          <div className="rpt-ff-meta">
            עלות לביצוע: <b>{meet === null ? noNumber : fmtILS(cpm)}</b>
          </div>
          {!dated && meet !== null && (
            <Delta d={prev ? deltaInfo(meet, prev.meetings, "up") : null} />
          )}
          {pieChannels && meet !== null && (
            <FunnelPie
              channels={pieChannels}
              metricKey="meetings"
              parentKey="scheduled"
              parentLabel="תיאומי פגישה"
              total={meet}
              extra={
                unattr
                  ? { count: unattr.meetings, parent: unattr.scheduled }
                  : null
              }
            />
          )}
        </div>
      </div>
    </section>
  );
}
