"use client";

import { useMemo, useState, type ReactNode } from "react";
import { channelIcon } from "@/lib/channelIcon";
import ChannelIcon from "@/components/ChannelIcon";
import { pacingChannelKey } from "@/lib/budgetTypes";
import ReportChannelCharts from "@/components/report/ReportChannelCharts";
import CopyAmountButton from "@/components/CopyAmountButton";
import GoogleAdsIcon from "@/components/GoogleAdsIcon";
import FacebookAdsIcon from "@/components/FacebookAdsIcon";

/** Ads-manager deep links (Keys accounts → platform URL) for the pacing
 *  copy-and-open control + the internal quick-links row. Built by the Apps
 *  Script (getProjectAdLinks). `sheetUrl` = the "דוח ביצועים" Google Sheet. */
export type ReportAdLinks = {
  gAdsUrl: string;
  fbAdsUrl: string;
  sheetUrl?: string;
};
import {
  computeChannelPacing,
  costHeatStyle,
  convTone,
  pickChannelAlerts,
  diagnosePaidChannels,
  applyBasisToChannels,
  datedUnattributed,
  fmtInt,
  fmtILS,
  fmtDateHe,
  type MonthLeadSource,
  type PaidDiagCard,
  type ProjectReportData,
  type ReportChannel,
} from "@/lib/reportShared";
import { BASIS_COPY } from "@/lib/meetingBasis";
import { useMeetingBasis } from "@/components/report/MeetingBasisContext";
import { BasisDash } from "@/components/report/BasisBadge";

/**
 * ערוצים tab — the native rebuild of the legacy 📋 פירוט ערוצים table
 * (Index.html:5770): 12 sortable columns (תקציב + קצב יומי live-mode only),
 * cost-per heat coloring, conversion-rate tones, totals
 * row, the pacing cell with the 12% configured-vs-required rule
 * (⬇/⬆/🔍 + ✓טיפלתי snooze sharing the iframe/budget-desk dismissal
 * keys), campaign live/paused dots, flight chips + mini-gantt, and the
 * pickAlerts strip, and the לידים cell's CRM-vs-pixel tooltip + ⚠️.
 * Free ranges render too (2026-08-26) — the rows are folded across the
 * months the range spans by reportData's buildRangeReportChannels, and
 * `rangeNote` below discloses which cells are summed and which pro-rated.
 * Not yet ported: spend-divergence ⚠️ (its pixelCostFullRange came from a
 * GADS+FB aggregation the native pipeline doesn't carry), CPL-trend ▲▼,
 * end-date-mismatch ⚠️, per-campaign tooltip detail.
 *
 * MEETING BASIS (2026-09-16). The תיאומים / ביצועים columns follow the
 * PAGE-LEVEL switch in the sticky header (MeetingBasisToggle, read here
 * through useMeetingBasis) — this tab no longer has a toggle of its own.
 * Before, it carried a local "לפי כניסת ליד | לפי מועד הפגישה" pair that
 * nothing else on the page could see: flipping it moved this table and
 * nothing else, while the קמפיינים joins were dated-only and the overview
 * lead-only. On The 57 in September the google-search row read 0 · 0 while
 * the keyword "גיא ודורון לוי מתחם האלף" under it read 3 · 1 — one client's
 * four meetings, counted on two bases on one page.
 * Lead-entry rows are the payload's own `scheduled` / `meetings`; dated rows
 * swap in `datedScheduled` / `datedMeetings` (applyBasisToChannels), and the
 * swap happens ONCE, before sort / filter / totals / charts / diagnosis, so
 * none of them can disagree with the cells.
 */

export type PacingDismissal = {
  snooze_until: string;
  dismissed_at: string;
  reason: string;
};

/** "emoji name" channel label (legacy channelIcon returned both; the
 *  hub port returns just the emoji). Kept as a STRING helper for the
 *  places that need one — `title` attributes and chart series labels
 *  cannot hold a React element. */
const chLabel = (name: string) =>
  `${channelIcon(name) || "●"} ${name}`.trim();

/** Rendered form of the same label: real brand logo for Google, Meta,
 *  Instagram, TikTok, Taboola and Outbrain, emoji for everything with no
 *  brand to show. */
function ChLabel({ name }: { name: string }) {
  return (
    <span className="rpt-ch-lbl">
      <ChannelIcon name={name} fallback="●" /> {name}
    </span>
  );
}

/**
 * CRM-vs-pixel gap tooltip for the לידים cell — the port of the legacy
 * `leadsCellTooltip` (Index.html:6243). Surfaces the pixel number on EVERY
 * row that HAS a pixel measurement, not just the diverging ones, so the gap
 * is readable at a glance.
 *
 * "Has a measurement" is `pixelLeads != null`, not `> 0`: channels with no
 * pixel at all (yad2, שילוט, phone…) leave לידים פיקסל BLANK and arrive here
 * as undefined, while a channel that is pixel-tracked and fired nothing
 * arrives as a real 0 — google-search-brand and google-discovery on לוריא,
 * 4 and 3 CRM leads against 0 events. That zero is the single most useful
 * thing this tooltip can say, so it gets its own line rather than being
 * suppressed alongside the untracked channels.
 *
 * Internal-only by construction: `pixelLeads` is stripped from the client
 * payload (NativeProjectRail), so a client render lands on the undefined
 * branch for every row.
 */
function leadsTooltip(c: ReportChannel): string | undefined {
  const pix = c.pixelLeads;
  if (pix == null || !Number.isFinite(pix) || pix < 0) return undefined;
  let gap = "";
  if (c.leads > 0) {
    // On the ROUNDED pixel count, the one printed on the line above. Google
    // reports fractional conversions (eastern, Sept: 15.9), so the raw
    // difference printed as "+1.9000000000000004" beside "פיקסל: 16" and
    // "CRM: 14" — three numbers that did not add up on the same tooltip.
    const diff = Math.round(pix) - c.leads;
    const pct = Math.round((diff / c.leads) * 100);
    const sign = diff > 0 ? "+" : diff < 0 ? "−" : "";
    gap = `\nפער: ${sign}${Math.abs(pct)}%  (${sign}${Math.abs(diff)})`;
  }
  const zero =
    pix === 0 && c.leads > 0
      ? "\n⚠️ הפיקסל לא רשם אף אירוע בערוץ שאמור להיות מתויג — בדוק התקנה."
      : "";
  return (
    `CRM: ${fmtInt(c.leads)} לידים\n` +
    `פיקסל: ${fmtInt(pix)} אירועים${gap}${zero}`
  );
}

/**
 * "(11 חדשים)" after a לידים count that includes returning inquiries.
 *
 * `לידים CRM` sums whatever the project tab's formula sums — on most tabs
 * new + returning (+ duplicates). אחוזת אפרידר's פייסבוק, September: 26
 * against the CRM section's 11, because 15 were people already in the CRM.
 * Shown only when some of the count is NOT new; an all-new count, or none
 * read (lib/crmSheetSplits), leaves the cell as it was.
 */
function NewLeads({ leads, fresh }: { leads: number; fresh?: number }) {
  if (fresh == null || !(fresh >= 0) || fresh >= leads) return null;
  return (
    <span
      className="rpt-ch-newleads"
      title={
        `${fmtInt(fresh)} פניות חדשות. ` +
        `${fmtInt(leads - fresh)} הנותרות הן פניות חוזרות או כפולות של לקוחות שכבר היו ב-CRM ` +
        `— נספרות בסה״כ ובעלות לליד, אבל לא בפילוח המקורות של ה-CRM.`
      }
    >
      ({fmtInt(fresh)} חדשים)
    </span>
  );
}

/**
 * "(1 בוטלו)" after a תיאומים count that includes cancelled meetings.
 *
 * The sheet's `תיאום וביטול` is scheduled + cancelled by definition, and the
 * table's תיאומים is that column on the live lead-entry basis — so a
 * channel reading 4 may hold a meeting that will never happen. Shown only
 * when there IS a cancellation; the number comes from the formula's own
 * cancellation terms (lib/crmSheetSplits), so it is always part of the 4.
 */
function CancelledPart({ scheduled, cancelled }: { scheduled: number; cancelled?: number }) {
  if (cancelled == null || !(cancelled > 0) || cancelled > scheduled) return null;
  return (
    <span
      className="rpt-ch-newleads"
      title={
        `${fmtInt(cancelled)} מתוך ${fmtInt(scheduled)} התיאומים בוטלו. ` +
        `"תיאומים" כאן הוא עמודת "תיאום וביטול" בגיליון — היא סופרת גם פגישות שבוטלו, ` +
        `וכך גם העלות לתיאום.`
      }
    >
      ({fmtInt(cancelled)} בוטלו)
    </span>
  );
}

/** Gap between the pixel count and the CRM count, either way, at which the
 *  לידים cell gets its ⚠️. */
const DIVERGE_PCT = 0.3;
/** …and never for fewer leads apart than this, so 5 vs 7 on a quiet channel
 *  (40% on two leads) does not raise the same flag as 16 vs 23. */
const DIVERGE_MIN_GAP = 3;
/** Below this many CRM leads a ratio is noise whatever it says. */
const DIVERGE_MIN_LEADS = 5;

/**
 * ⚠️ beside the לידים number when the pixel and the CRM disagree.
 *
 * Was a port of the legacy `leadsDivergenceIndicator` (Index.html:6294):
 * flag only when pixel/CRM fell under 0.7 or over 1.8, tuned to a portfolio
 * median of 1.14. That missed exactly the gap an account manager noticed by
 * eye — 16 CRM leads against 23 pixel events on a google-discovery row, +44%,
 * no mark (Maayan, 2026-09-23).
 *
 * Re-measured over every ALL CLIENTS row with ≥5 CRM leads and a pixel count
 * (658 rows, 2026-09-23): the ratio's median is 1.00 now, not 1.14, and the
 * middle half sits between 0.89 and 1.14. So the rule is symmetric around
 * 1, and the flag goes on the outer quarter: a gap of 30% or more either
 * way, and at least 3 leads apart. That marks 25% of rows (the old rule
 * marked 19%) and catches the +44% it used to miss.
 *
 * `pix <= 0` is excluded on purpose and the reason differs by case now that
 * blank and 0 are distinguishable: a BLANK (undefined) channel has no pixel
 * to malfunction, while a measured 0 is reported by leadsTooltip's own
 * warning line instead — this ⚠️ stays reserved for ratio anomalies, where
 * a ratio needs two real numbers to be meaningful.
 */
function leadsDivergence(c: ReportChannel): string | undefined {
  const raw = c.pixelLeads;
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return undefined;
  if (c.leads < DIVERGE_MIN_LEADS) return undefined;
  // Rounded, like every other place the pixel count is printed: Google
  // reports fractional conversions, and the gap must agree with the number
  // on the line above it.
  const pix = Math.round(raw);
  const gap = pix - c.leads;
  const pct = gap / c.leads;
  if (Math.abs(gap) < DIVERGE_MIN_GAP || Math.abs(pct) < DIVERGE_PCT) {
    return undefined;
  }
  const shown = Math.round(Math.abs(pct) * 100);
  const msg =
    gap > 0
      ? `הפיקסל רשם ${shown}% יותר אירועים ממה שהגיע ל-CRM. בדרך כלל כפילויות בפיקסל, או לידים שלא נקלטו או סוננו ב-CRM.`
      : `הפיקסל רשם ${shown}% פחות אירועים ממה שהגיע ל-CRM — הוא אמור לתפוס לפחות אותו דבר. בדוק שהפיקסל מותקן נכון ושהאירועים נרשמים.`;
  return (
    `פער CRM מול פיקסל:\n` +
    `CRM: ${fmtInt(c.leads)} לידים\n` +
    `פיקסל: ${fmtInt(pix)} אירועים\n` +
    `פער: ${gap > 0 ? "+" : "−"}${shown}%  (${gap > 0 ? "+" : "−"}${Math.abs(gap)})\n${msg}`
  );
}

type DayPt = { date: string; cost: number; leads: number };

/** A google channel LABEL that denotes the discovery/PMax/demand-gen
 *  family (vs search). Mirrors reportData's googleCampaignKind so the
 *  channel-row → daily-series mapping agrees with how the campaigns were
 *  bucketed. A plain "google" label matches NEITHER this nor a search
 *  token — it's treated as the non-discovery (search) side when a
 *  discovery row exists, else as all-google (see hasGoogleDiscovery). */
const GOOGLE_DISCOVERY_LABEL_RE = /discover|p-?max|demand|dgen|display/i;

/** Zero-filled daily series clamped to the last date that actually has
 *  data, so the sparkline doesn't trail into future zeros — mirrors the
 *  legacy `_buildAdTrendlinePopover_` windowing (Index.html:6890). */
function windowDaily(
  series: { date: string; cost: number; leads: number }[],
  startIso: string,
  endIso: string,
): DayPt[] {
  if (!series.length || !startIso || !endIso) return [];
  const byDate = new Map(series.map((p) => [p.date, p]));
  const inWin = series.filter((p) => p.date >= startIso && p.date <= endIso);
  if (!inWin.length) return [];
  let lastData = "";
  for (const p of inWin)
    if ((p.cost > 0 || p.leads > 0) && p.date > lastData) lastData = p.date;
  const end = lastData && lastData >= startIso ? lastData : endIso;
  const out: DayPt[] = [];
  const cur = new Date(`${startIso}T00:00:00Z`);
  const endD = new Date(`${end}T00:00:00Z`);
  let guard = 0;
  while (cur <= endD && guard++ < 400) {
    const iso = cur.toISOString().slice(0, 10);
    const p = byDate.get(iso);
    out.push({ date: iso, cost: p?.cost ?? 0, leads: p?.leads ?? 0 });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

const ddmm = (iso: string) => {
  const [, m, d] = iso.split("-");
  return d && m ? `${d}/${m}` : iso;
};

/** Hover popover: two independently auto-scaled SVG line-sparklines
 *  (daily cost teal + leads purple) across the report window. Port of
 *  the legacy `_buildAdTrendlinePopover_` (Index.html:6885) — shown on
 *  google/facebook rows only (the platform daily feed covers those). */
function ChannelTrendPop({
  channel,
  series,
}: {
  channel: string;
  series: DayPt[];
}) {
  const W = 240;
  const H = 42;
  const PAD = 2;
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;
  const maxCost = series.reduce((m, r) => Math.max(m, r.cost), 0);
  const maxLeads = series.reduce((m, r) => Math.max(m, r.leads), 0);
  const xAt = (i: number) =>
    series.length <= 1
      ? PAD + innerW / 2
      : PAD + (i / (series.length - 1)) * innerW;
  const yOf = (v: number, max: number) =>
    max <= 0 ? PAD + innerH : PAD + innerH - (v / max) * innerH;
  const path = (key: "cost" | "leads", max: number) =>
    series
      .map(
        (r, i) =>
          (i === 0 ? "M" : "L") +
          xAt(i).toFixed(1) +
          " " +
          yOf(r[key], max).toFixed(1),
      )
      .join(" ");
  const totalCost = series.reduce((s, r) => s + r.cost, 0);
  const totalLeads = series.reduce((s, r) => s + r.leads, 0);
  return (
    <div className="rpt-chtrend-pop" aria-hidden="true">
      <div className="rpt-chtrend-head">
        {channel} · {ddmm(series[0].date)} ←{" "}
        {ddmm(series[series.length - 1].date)}
      </div>
      <div className="rpt-chtrend-row">
        <span className="rpt-chtrend-label">💸 עלות</span>
        <svg viewBox={`0 0 ${W} ${H}`} className="rpt-chtrend-svg">
          <path
            d={path("cost", maxCost)}
            fill="none"
            style={{ stroke: "var(--teal)" }}
            strokeWidth={1.6}
          />
        </svg>
        <span className="rpt-chtrend-total">{fmtILS(totalCost)}</span>
      </div>
      <div className="rpt-chtrend-row">
        <span className="rpt-chtrend-label">🎯 לידים</span>
        <svg viewBox={`0 0 ${W} ${H}`} className="rpt-chtrend-svg">
          <path
            d={path("leads", maxLeads)}
            fill="none"
            style={{ stroke: "var(--violet)" }}
            strokeWidth={1.6}
          />
        </svg>
        <span className="rpt-chtrend-total">{fmtInt(totalLeads)}</span>
      </div>
    </div>
  );
}

type FadeState = "active" | "dismissed" | "resurfaced";

function ilToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(),
  );
}

/** Days from `today` to `endIso`, inclusive of both. 0 once the flight is
 *  over, which callers read as "no runway to spread money across". */
function daysLeftOf(endIso: string, today: string): number {
  const end = Date.parse(endIso);
  const now = Date.parse(today);
  if (!Number.isFinite(end) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.round((end - now) / 86400000) + 1);
}

function ilDayOf(ts: string): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(ms),
  );
}

/** Port of the shared computeFadeState semantics (BudgetGrid /
 *  legacy `_pacingFadeState`): same-IL-day stays dismissed; overnight
 *  passed AND the gap still fires → resurfaced; expired/restored →
 *  active. `local` is this session's optimistic override. */
function fadeStateOf(
  d: PacingDismissal | undefined,
  today: string,
  local: "on" | "off" | undefined,
  gapStillOff: boolean,
): FadeState {
  if (local === "off") return "active";
  if (local === "on") return "dismissed";
  if (!d) return "active";
  if (!d.snooze_until || d.snooze_until < today) return "active";
  const day = d.dismissed_at ? ilDayOf(d.dismissed_at) : "";
  if (day && day < today && gapStillOff) return "resurfaced";
  return "dismissed";
}

type SortKey =
  | "channel"
  | "budget"
  | "spend"
  | "leads"
  | "cpl"
  | "r1"
  | "scheduled"
  | "cps"
  | "r2"
  | "meetings"
  | "cpm"
  | "daily";

const r1Of = (c: ReportChannel) => (c.leads > 0 ? c.scheduled / c.leads : null);
const r2Of = (c: ReportChannel) =>
  c.scheduled > 0 ? c.meetings / c.scheduled : null;

const SORT_VAL: Record<SortKey, (c: ReportChannel) => number | string> = {
  channel: (c) => c.channel.toLowerCase(),
  budget: (c) => c.budget,
  spend: (c) => c.spend,
  leads: (c) => c.leads,
  cpl: (c) => (c.costPerLead > 0 ? c.costPerLead : -1),
  r1: (c) => r1Of(c) ?? -1,
  scheduled: (c) => c.scheduled,
  cps: (c) => (c.costPerScheduled > 0 ? c.costPerScheduled : -1),
  r2: (c) => r2Of(c) ?? -1,
  meetings: (c) => c.meetings,
  cpm: (c) => (c.costPerMeeting > 0 ? c.costPerMeeting : -1),
  daily: (c) => c.dailyRate,
};

const STATUS_DOT: Record<
  ReportChannel["campaignStatus"],
  { cls: string; title: string } | null
> = {
  none: null,
  active: { cls: "is-ok", title: "קמפיין פעיל" },
  paused: { cls: "is-off", title: "קמפיין מושהה" },
  mixed: { cls: "is-mixed", title: "חלק מהקמפיינים מושהים" },
};

/** A conversion-rate cell. `dash` replaces the ratio outright — for a ratio
 *  that has no honest value on the current meeting basis: המרה לתיאום under
 *  "dated" divides meetings counted by meeting DATE by leads counted by
 *  ENTRY, so a row whose meetings belong to last month's leads reads a
 *  rate above 100%, or a rate on a row with no leads this period at all.
 *  Plain "—" stays what it always was: no denominator. */
function ConvCell({ r, dash }: { r: number | null; dash?: ReactNode }) {
  if (dash) return <td className="rpt-conv rpt-conv-none">{dash}</td>;
  const tone = convTone(r);
  return (
    <td className={`rpt-conv rpt-conv-${tone}`}>
      {r !== null ? `← ${(Math.round(r * 10000) / 100).toString()}%` : "—"}
    </td>
  );
}

/**
 * The diagnosis rule that divides תיאומים by לידים (📉 איכות לידים נמוכה).
 * Under "dated" that is the same cross-basis ratio as המרה לתיאום, so the
 * card would call a channel low-quality on a number the table itself shows
 * as "—". Filtered here, after diagnosePaidChannels, to keep reportShared's
 * port of the legacy rules untouched (basis-design §6 U7). Known edge: the
 * rules cap at 3 cards BEFORE this filter, so a dated view that drops a
 * 📉 card shows one card fewer instead of promoting a 4th, and a view whose
 * only card was 📉 shows none rather than the ✅ all-clear.
 */
const isQualityLeakCard = (c: PaidDiagCard) =>
  c.icon === "📉" || c.head.startsWith("איכות לידים נמוכה");

/** Hebrew takes the singular at exactly one ("1 תיאומים" is wrong). */
const heCount = (n: number, one: string, many: string) =>
  n === 1 ? one : `${fmtInt(n)} ${many}`;

/**
 * The dated caption's two "not in any row" sentences, scheduled side first.
 * The old caption named only the ביצועים, so a reader comparing the
 * תיאומים total with the overview card had nothing to explain the gap —
 * and the scheduled side is never the smaller one: ביצועים ⊆ תיאומים on
 * every dated source (both count the same events; held adds a confirmed
 * outcome), so the held count rides in brackets instead of its own clause.
 */
function unplacedSentence(
  pair: { scheduled: number; meetings: number },
  kind: "unmatched" | "ambiguous" | "unsourced",
  basis: "lead" | "dated",
): string {
  const s = pair.scheduled;
  const m = pair.meetings;
  if (s <= 0 && m <= 0) return "";
  const one = s === 1;
  const subject =
    s <= 0
      ? // Held with nothing scheduled cannot happen on today's sources; say
        // what is there rather than print "0 תיאומים (מתוכם …)".
        heCount(m, "ביצוע אחד", "ביצועים")
      : one
        ? `תיאום אחד${m > 0 ? " שהתקיים" : ""}`
        : `${fmtInt(s)} תיאומים${m > 0 ? ` (מתוכם ${heCount(m, "ביצוע אחד", "ביצועים")})` : ""}`;
  const single = s <= 0 ? m === 1 : one;
  // Lead-entry meetings are not "in the period" — they belong to leads that
  // entered in it, and may themselves fall after it.
  const when = basis === "dated" ? "בתקופה" : "של לידים מהתקופה";
  if (kind === "unmatched") {
    return single
      ? `${subject} ${when} שייך לערוץ שאינו בטבלה.`
      : `${subject} ${when} שייכים לערוצים שאינם בטבלה.`;
  }
  if (kind === "unsourced") {
    return single
      ? `${subject} ${when} נרשם ב-CRM ללא מקור הגעה, ולכן לא שויך לאף שורה.`
      : `${subject} ${when} נרשמו ב-CRM ללא מקור הגעה, ולכן לא שויכו לאף שורה.`;
  }
  return single
    ? `${subject} ${when} נרשם במקור כללי שאינו מבחין בין שורות הטבלה, ולכן לא שויך לאף שורה.`
    : `${subject} ${when} נרשמו במקור כללי שאינו מבחין בין שורות הטבלה, ולכן לא שויכו לאף שורה.`;
}

/**
 * Past month (owner decision D1) whose lead-entry meeting columns could NOT
 * be recounted live and still show ALL CLIENTS' חודשי numbers — why, in one
 * sentence. "" when nothing needs saying.
 *
 * The חודשי row is pasted at month end, and lead-entry keeps growing after
 * that as the month's leads book more meetings, so a frozen row reads lower
 * than the קמפיינים joins and the CRM card beside it, which are recounted
 * live. The label is what stops that gap reading as a bug.
 *
 * "no-crm" is labelled only when the project evidently HAS a CRM (the
 * reader named its platform, or the dated read found one): a project with no
 * CRM mapping at all has only ALL CLIENTS to show, in every month, and a
 * caption on each of them would be noise, not disclosure.
 */
function frozenMonthSentence(
  mls: MonthLeadSource,
  hasCrm: boolean,
): string {
  if (mls.source !== "frozen") return "";
  const frozen =
    "תיאומים וביצועים לפי כניסת ליד בחודש הזה הם המספרים שנרשמו ב-ALL CLIENTS בסוף החודש ולא התעדכנו מאז";
  switch (mls.frozenReason) {
    case "salesforce":
      // Not a failure: Salesforce has no warehouse to recount from, so D1
      // keeps its month-end row on purpose. Still said, because the CRM card
      // one scroll away reads Salesforce's CURRENT stages.
      return `ב-Salesforce ${frozen} — אין מקור שממנו אפשר לספור אותם מחדש.`;
    case "no-warehouse":
      // Two different causes share this reason. Sehel's Sheet route really
      // does record lead statuses. BMBY records meeting events — the same
      // project's covered months ARE recounted — so there it is the D3
      // fallback: the warehouse does not cover this month (הוד השרון's
      // lead feed stops at 05-31, so July lands here). Blaming the CRM
      // would also contradict the CRM card's warehouseFallback badge on
      // the same page.
      return mls.platform === "bmby"
        ? `${frozen} — במחסן הנתונים אין לפרויקט נתוני פגישות של BMBY שמכסים את החודש הזה, ולכן אין ממנו ספירה עדכנית.`
        : `${frozen} — מקור ה-CRM של הפרויקט מתעד סטטוס של לידים ולא אירועי פגישה, ולכן אין ממנו ספירה עדכנית.`;
    case "low-coverage": {
      const pct =
        mls.totalCrmLeads > 0
          ? Math.round((mls.attributedLeads / mls.totalCrmLeads) * 100)
          : 0;
      return `${frozen} — מקורות הלידים ב-CRM תואמים לשורות הטבלה רק ב-${pct}% מהלידים (${fmtInt(mls.attributedLeads)} מתוך ${fmtInt(mls.totalCrmLeads)}), מעט מדי לפיצול עדכני לפי שורה.`;
    }
    case "no-crm":
    default:
      return hasCrm ? `${frozen} — לא ניתן היה לקרוא מה-CRM ספירה עדכנית.` : "";
  }
}

/** תקציב חודשי strip — the 4 budget-desk summary cells (יעד E3 / חולק /
 *  פער / ימים), collapsible. Ports renderBudgetStripBody's summary row
 *  (Index.html:9386); the suggestion engine lives on the budget desk. */
function BudgetStrip({
  s,
  shift = 0,
}: {
  s: NonNullable<ProjectReportData["budgetSummary"]>;
  /** Net change from budget cells edited since this page was rendered.
   *  Applied as a shift rather than a re-sum on purpose: `s.allocated` is
   *  the sheet's total across EVERY channel, while the table may be
   *  filtered to a few — re-summing the visible rows would quietly answer
   *  a different question. A shift stays correct whatever is on screen. */
  shift?: number;
}) {
  const [open, setOpen] = useState(false);
  const allocated = s.allocated + shift;
  const delta = s.delta + shift;
  const driftAbs = Math.abs(delta);
  const tone = !s.e3 ? "unknown" : driftAbs < 100 ? "ok" : "drift";
  const stateLabel =
    tone === "ok" ? "מסונכרן" : tone === "unknown" ? "אין יעד" : `פער ${fmtILS(driftAbs)}`;
  return (
    <div className="rpt-bstrip">
      <button
        type="button"
        className="rpt-bstrip-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>💰</span>
        <span className="rpt-bstrip-title">תקציב חודשי</span>
        <span className={`rpt-bstrip-state is-${tone}`}>{stateLabel}</span>
        <span className="rpt-bstrip-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="rpt-bstrip-body">
          <div className="rpt-bstrip-cell">
            <div className="rpt-bstrip-lbl">יעד (E3)</div>
            <div className="rpt-bstrip-val">{s.e3 > 0 ? fmtILS(s.e3) : "—"}</div>
          </div>
          <div className="rpt-bstrip-cell">
            <div className="rpt-bstrip-lbl">חולק</div>
            <div className="rpt-bstrip-val">{fmtILS(allocated)}</div>
          </div>
          <div className={`rpt-bstrip-cell rpt-bstrip-delta is-${tone}`}>
            <div className="rpt-bstrip-lbl">פער</div>
            <div className="rpt-bstrip-val">
              {delta > 0 ? "+" : delta < 0 ? "−" : ""}
              {fmtILS(driftAbs)}
            </div>
          </div>
          <div className="rpt-bstrip-cell">
            <div className="rpt-bstrip-lbl">ימים שנותרו</div>
            <div className="rpt-bstrip-val">
              {s.remainingDays} / {s.totalDays}
            </div>
          </div>
          <a className="rpt-bstrip-link" href="/morning/budgets">
            שולחן התקציבים ↗
          </a>
        </div>
      )}
    </div>
  );
}

/** Inline-editable תקציב cell (media/felix) — writes col G on the
 *  project tab via /api/campaigns/budget lookup mode (distribute across
 *  merged sub-campaign rows when needed), with the same drift guard the
 *  budget desk uses. */
function BudgetCell({
  tabSlug,
  channel,
  budget,
  distribute,
  onSaved,
}: {
  tabSlug: string;
  channel: string;
  budget: number;
  distribute: boolean;
  /** Fired only after the write lands, so the rest of the table can move
   *  with the number. Not on keystroke and not optimistically: a rejected
   *  write must not leave חולק / פער claiming money the sheet never took. */
  onSaved?: (channel: string, next: number) => void;
}) {
  const [value, setValue] = useState(budget);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(Math.round(budget)));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState("");

  const save = async () => {
    setEditing(false);
    const next = Math.round(Number(draft.replace(/[^\d.-]/g, "")));
    if (!Number.isFinite(next) || next === Math.round(value)) {
      setDraft(String(Math.round(value)));
      return;
    }
    setState("saving");
    setErr("");
    try {
      const res = await fetch("/api/campaigns/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: tabSlug,
          channel,
          value: next,
          expectedBudget: Math.round(value),
          distribute,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setValue(next);
      setDraft(String(next));
      onSaved?.(channel, next);
      setState("saved");
      setTimeout(() => setState("idle"), 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setDraft(String(Math.round(value)));
      setState("error");
    }
  };

  if (editing) {
    return (
      <input
        className="rpt-budcell-input"
        type="text"
        inputMode="numeric"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setDraft(String(Math.round(value)));
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className={"rpt-budcell-btn is-" + state}
      title={
        state === "error"
          ? `שגיאה: ${err}`
          : distribute
            ? "לחצו לעריכה — יחולק יחסית בין תתי-הקמפיינים · נשמר ל-Google Sheet"
            : "לחצו לעריכה — נשמר ל-Google Sheet"
      }
      onClick={() => {
        setDraft(String(Math.round(value)));
        setEditing(true);
      }}
    >
      {fmtILS(value)}
      {state === "saving" && " …"}
      {state === "saved" && " ✓"}
      {state === "error" && " ⚠️"}
    </button>
  );
}

function ChannelGantt({
  channels,
  window,
  currentKey,
}: {
  channels: ReportChannel[];
  window: { startIso: string; endIso: string };
  currentKey: string;
}) {
  const ps = Date.parse(window.startIso);
  const pe = Date.parse(window.endIso);
  const span = Math.max(1, pe - ps);
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - ps) / span) * 100));
  const todayMs = Date.parse(ilToday());
  const todayPct = todayMs >= ps && todayMs <= pe ? pct(todayMs) : null;
  const rows = channels.filter((c) => c.startIso && c.endIso);
  if (!rows.length) return null;
  return (
    <div className="rpt-gantt">
      <div className="rpt-gantt-head">
        טווח הפרויקט · {fmtDateHe(window.startIso)} – {fmtDateHe(window.endIso)}
      </div>
      {rows.map((c) => {
        const left = pct(Date.parse(c.startIso));
        const width = Math.max(1.5, pct(Date.parse(c.endIso)) - left);
        const util =
          c.budget > 0
            ? Math.min(100, (c.spend / c.budget) * 100)
            : c.spend > 0
              ? 100
              : 0;
        const over = c.budget > 0 && c.spend > c.budget;
        const cur = c.channel.toLowerCase() === currentKey;
        return (
          <div key={c.channel} className={"rpt-gantt-row" + (cur ? " is-cur" : "")}>
            <span className="rpt-gantt-label" title={c.channel}>
              <ChLabel name={c.channel} />
            </span>
            <span className="rpt-gantt-track">
              {todayPct !== null && (
                <span
                  className="rpt-gantt-today"
                  style={{ insetInlineStart: `${todayPct}%` }}
                  title="היום"
                />
              )}
              <span
                className={"rpt-gantt-bar" + (over ? " is-over" : "")}
                style={{ insetInlineStart: `${left}%`, width: `${width}%` }}
              >
                <span className="rpt-gantt-fill" style={{ width: `${util}%` }} />
              </span>
            </span>
            <span className="rpt-gantt-meta">
              {fmtDateHe(c.startIso).slice(0, 5)}–{fmtDateHe(c.endIso).slice(0, 5)}{" "}
              · {fmtILS(c.spend)} / {c.budget > 0 ? fmtILS(c.budget) : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function ReportChannelsTab({
  data,
  pacingDismissals,
  canEditBudget = false,
  adLinks = null,
}: {
  data: ProjectReportData;
  pacingDismissals: Record<string, PacingDismissal>;
  canEditBudget?: boolean;
  adLinks?: ReportAdLinks | null;
}) {
  /**
   * Flight-window chrome: the תקציב + קצב יומי columns, the pacing cell and
   * the irregular-dates warning. All four are statements about an approved
   * MONTHLY budget being burned down over a known flight window, so they
   * mean nothing for a completed month and nothing for a free range — a
   * range has no budget of its own to pace against, and its rows carry ALL
   * CLIENTS flight dates that will never equal the window the user picked.
   * Live mode only, therefore.
   */
  const flightCols = data.mode === "live";
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [localDismiss, setLocalDismiss] = useState<Record<string, "on" | "off">>(
    {},
  );
  const [ganttFor, setGanttFor] = useState<string | null>(null);
  // Channel filter (multi-select). null = all channels shown. Mirrors the
  // legacy `applyChannelsTableFilter` — hides rows + recomputes totals only;
  // the four charts stay on the full channel set.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  /** channel → budget saved to the sheet during this page's life. Lives
   *  here rather than inside BudgetCell because the strip and the row's
   *  קצב יומי read it too. Cleared by any real page load, when the server
   *  brings the sheet's own numbers back. */
  const [budgetEdits, setBudgetEdits] = useState<Record<string, number>>({});
  const today = useMemo(ilToday, []);
  /**
   * Which basis the תיאומים / ביצועים columns count on — the PAGE's, not
   * this tab's (see the file header). `basis` is already the effective one:
   * lead-entry when the project has no dated source anywhere on the page.
   *
   * What each basis means for these rows (measured, basis-design §2.1):
   *   "lead"  — לפי כניסת ליד. The payload's own `scheduled` / `meetings`.
   *             BMBY: every meeting EVENT — cancelled ones included in
   *             תיאומים — owned by a lead that entered in the period, at
   *             whatever date the meeting itself falls (The57!N11 =
   *             SUMIFS(CRM!R בוטלו) + SUMIFS(CRM!N תואמו)). Sehel: every
   *             meeting of a client registered in the period. Salesforce:
   *             LEADS of the period by current stage — the one source whose
   *             unit is leads. The old toggle's tooltip described all three
   *             as "leads whose meeting took place", which none of them is.
   *   "dated" — לפי מועד הפגישה. `datedScheduled` / `datedMeetings`: meeting
   *             events dated inside the period, whenever their lead came.
   *
   * `dated` requires this table's own dated source. The page can be on
   * "dated" without one — the קמפיינים joins alone are enough to enable the
   * switch — and then the meeting cells are "—" with the no-source tooltip
   * (`meetingsMissing`), never the lead-entry numbers under a "לפי מועד
   * הפגישה" header: that silent fallback is exactly the disagreement the
   * page-level switch exists to remove.
   */
  const { basis } = useMeetingBasis();
  const datedSource = data.datedSource;
  const dated = basis === "dated" && !!datedSource;
  const meetingsMissing = basis === "dated" && !datedSource;

  /**
   * The caption under the controls row, as one string — "" when there is
   * nothing to say, so the line can be skipped entirely rather than
   * rendered empty. It lives BELOW the controls row, not inside it: as a
   * flex item on its own line it re-flowed the row and pushed the channel
   * filter to a second line, so the filter appeared to jump every time the
   * old toggle was clicked — including on projects with no caveat at all,
   * where the element was empty but still occupied a row.
   *
   * Lead-entry, in order:
   *   1. A past month that could not be recounted live says so and why
   *      (frozenMonthSentence — owner decision D1 replaced the frozen חודשי
   *      literals with the live warehouse count wherever one exists).
   *   2. Sehel's ביצועים, and which caveat depends on who counted the row.
   *      ALL CLIENTS (the live row, a frozen month, a pro-rated range)
   *      mirrors Sehel's J column and so counts past meetings still at "לא
   *      ידוע". What the hub counts itself — a live-recounted month, a
   *      CRM-attributed range — counts "הלקוח הגיע לפגישה" only (D2).
   *   3. A live-recounted month's meetings no row could claim — a source
   *      with no row, one several rows share, or no source at all. They are
   *      in no row and not in `totals` (lead-entry totals are Σ rows by
   *      design), but the CRM card, which is windowed on the same month,
   *      does count them — this is the sentence that reconciles the two.
   * The CRM is named by monthLeadSource in month mode, else only by
   * datedSource, so a Sehel project with no sehel_meetings (Carmei-Gat,
   * Bnei-Ayish) outside month mode gets no Sehel caveat — it has no
   * hub-counted meetings to caveat either.
   */
  const mls = data.mode === "month" ? (data.monthLeadSource ?? null) : null;
  const basisNote = useMemo(() => {
    if (meetingsMissing) return "";
    if (!dated) {
      const parts: string[] = [];
      if (mls) {
        const f = frozenMonthSentence(mls, !!mls.platform || !!datedSource);
        if (f) parts.push(f);
      }
      const platform = mls?.platform ?? datedSource?.platform ?? null;
      if (platform === "sehel") {
        // A range counts its own meetings only off warehouse EVENTS: a
        // Sheet-routed Sehel range's CRM maps are a status snapshot of
        // leads (rangeBasis.leadRule), not "הלקוח הגיע לפגישה" events.
        const hubCounted = mls
          ? mls.source === "warehouse"
          : data.mode === "range" &&
            data.rangeBasis?.outcomes === "crm" &&
            data.rangeBasis.leadRule === "registration-cohort";
        parts.push(
          hubCounted
            ? BASIS_COPY.sehelLeadHeldStrict
            : BASIS_COPY.sehelLeadHeldAllClients,
        );
      }
      if (mls?.source === "warehouse") {
        const u = unplacedSentence(mls.unattributed, "unmatched", "lead");
        if (u) parts.push(u);
        const a = unplacedSentence(mls.ambiguous, "ambiguous", "lead");
        if (a) parts.push(a);
        if (mls.unsourced) {
          const n = unplacedSentence(mls.unsourced, "unsourced", "lead");
          if (n) parts.push(n);
        }
      }
      return parts.join(" ");
    }
    if (!datedSource) return "";
    const parts: string[] = [];
    if (datedSource.heldConfidence === "partial") {
      parts.push(
        "חלק מהפגישות ללא סטטוס סופי — הביצועים הם רצפה, לא ספירה מלאה.",
      );
    }
    const unmatched = unplacedSentence(
      {
        scheduled: datedSource.unmatchedScheduled,
        meetings: datedSource.unmatchedMeetings,
      },
      "unmatched",
      "dated",
    );
    if (unmatched) parts.push(unmatched);
    const ambiguous = unplacedSentence(
      {
        scheduled: datedSource.ambiguousScheduled,
        meetings: datedSource.ambiguousMeetings,
      },
      "ambiguous",
      "dated",
    );
    if (ambiguous) parts.push(ambiguous);
    return parts.join(" ");
  }, [dated, meetingsMissing, datedSource, mls, data.mode, data.rangeBasis]);

  /**
   * Internal only (canEditBudget is false for clients and the client
   * preview): what ALL CLIENTS' חודשי row said for a month the table now
   * recounts live, so whoever reconciles the page against the sheet sees
   * both numbers instead of assuming one of them is wrong. Skipped when the
   * two agree — the sentence would only say "nothing changed".
   */
  const frozenWasNote = useMemo(() => {
    if (!canEditBudget || dated || meetingsMissing) return "";
    if (mls?.source !== "warehouse") return "";
    let s = 0;
    let m = 0;
    for (const c of data.channels) {
      s += c.scheduled;
      m += c.meetings;
    }
    if (s === mls.frozen.scheduled && m === mls.frozen.meetings) return "";
    return `לשם השוואה: בגיליון ALL CLIENTS רשומים לחודש הזה ${heCount(mls.frozen.scheduled, "תיאום אחד", "תיאומים")} · ${heCount(mls.frozen.meetings, "ביצוע אחד", "ביצועים")} — המספרים מסוף החודש, לפני הספירה העדכנית.`;
  }, [canEditBudget, dated, meetingsMissing, mls, data.channels]);

  /**
   * What a free range's numbers actually are, said out loud.
   *
   * Range rows mix two kinds of money: platforms with a daily feed are
   * summed exactly over the chosen days, everything else is a share of a
   * monthly figure. Presenting both as one column without saying so would
   * let a pro-rated יד2 estimate be read as a measurement — and it is the
   * one number here nobody can check against a platform. Same for the
   * funnel columns, which come from the CRM windowed on the range rather
   * than from ALL CLIENTS.
   *
   * The outcomes sentence follows the meeting basis. It used to say
   * "נספרים מה-CRM לפי תאריכי הטווח" for every column under a table whose
   * default claimed לפי כניסת ליד, while the CRM maps behind it were a third
   * thing (cohort ∩ dated on BMBY warehouse projects, pure meeting date on
   * Sehel ones). Those maps are lead-entry now (lib/crmData: owner-lead on
   * BMBY, registration cohort on Sehel), and the dated columns
   * come from the same getDatedChannelMeetings read as every other mode —
   * which, unlike the maps, does not depend on the CRM sources attributing
   * well enough to switch `outcomes` to "crm", so a pro-rated range still
   * has real dated meetings.
   */
  const rangeNote = useMemo(() => {
    const rb = data.rangeBasis;
    if (data.mode !== "range" || !rb) return "";
    const parts: string[] = [];
    if (rb.prorated.length) {
      parts.push(
        `עלות ${rb.realSpend.length ? "עבור " + rb.prorated.join(", ") : ""} מחושבת יחסית למספר הימים בטווח מתוך העלות החודשית ב-ALL CLIENTS — הערכה, לא מדידה.`,
      );
    }
    if (rb.realSpend.length) {
      parts.push(
        `עלות עבור ${rb.realSpend.join(", ")} נסכמת מהוצאה יומית אמיתית בטווח.`,
      );
    }
    const unattributable =
      "לא ניתן היה לשייך את מקורות ה-CRM לשורות הטבלה";
    if (dated) {
      parts.push(
        rb.outcomes === "crm"
          ? BASIS_COPY.rangeOutcomes.dated
          : `לידים מחושבים יחסית למספר הימים — ${unattributable}. תיאומים וביצועים נספרים לפי מועד הפגישה בטווח.`,
      );
    } else if (meetingsMissing) {
      // The meeting cells are "—" and say why on hover; the sentence speaks
      // only for the column that still has numbers.
      parts.push(
        rb.outcomes === "crm"
          ? "לידים נספרים מה-CRM ללידים שנכנסו בטווח."
          : `לידים מחושבים יחסית למספר הימים — ${unattributable}.`,
      );
    } else {
      // A status snapshot (Sheet-routed Sehel, BMBY D3 fallback) fills the
      // same columns with LEADS by current stage; say so in the sentence
      // that would otherwise call them lead-entry meeting events.
      parts.push(
        rb.outcomes !== "crm"
          ? `לידים, תיאומים וביצועים מחושבים יחסית למספר הימים — ${unattributable}.`
          : rb.leadRule === "status-snapshot"
            ? BASIS_COPY.rangeOutcomesSnapshot[
                rb.warehouseFallback ? "warehouseFallback" : "statusSnapshot"
              ]
            : BASIS_COPY.rangeOutcomes.lead,
      );
    }
    const un = rb.unattributedLeads + rb.ambiguousLeads;
    if (un > 0 && rb.totalCrmLeads > 0) {
      parts.push(
        `${fmtInt(un)} מתוך ${fmtInt(rb.totalCrmLeads)} לידים ב-CRM לא שויכו לאף שורה.`,
      );
    }
    return parts.join(" ");
  }, [data.mode, data.rangeBasis, dated, meetingsMissing]);

  /**
   * The rows on the page's basis — the ONE substitution everything below
   * reads (budget edits, sort, filter, totals, cells, charts, diagnosis).
   *
   * With no dated source under "dated" the meeting fields are ZEROED rather
   * than left holding lead-entry numbers, the same contract as
   * applyBasisToCreatives: the cells render "—" from `meetingsMissing`, and
   * zeros keep every derived reader — a sort by תיאומים, the charts, the
   * ⭐ card quoting עלות לתיאום — from quietly presenting the other basis.
   */
  const basisChannels = useMemo(() => {
    if (dated) return applyBasisToChannels(data.channels, "dated");
    if (meetingsMissing) {
      return data.channels.map((c) => ({
        ...c,
        scheduled: 0,
        meetings: 0,
        cancelledScheduled: undefined,
        costPerScheduled: 0,
        costPerMeeting: 0,
      }));
    }
    return data.channels;
  }, [data.channels, dated, meetingsMissing]);

  /**
   * Budget cells write to the sheet, and the numbers DERIVED from a budget
   * have to move with them — otherwise an edit looks like it did nothing
   * and the reader is left comparing a new תקציב against an old קצב יומי
   * and an old חולק. Everything downstream (sort, filter, the totals row,
   * the utilization bars) reads this list, so it all follows for free.
   *
   * קצב יומי is applied as a SHIFT on the sheet's own rate rather than
   * recomputed as (budget − spend) ÷ days:
   *
   *     old = (B − H) / D        new = (B′ − H) / D = old + (B′ − B) / D
   *
   * The spend term cancels, which matters because the sheet's H is not
   * always the עלות shown beside it — on a platform-fed row the hub shows
   * the platform's measured spend while the sheet keeps its own. Deriving
   * the rate from scratch would silently import that difference into a
   * number the sheet owns; shifting it changes only what we actually know
   * changed.
   *
   * D is the row's own remaining flight, not the project's: channels end on
   * different dates, and the strip's ימים שנותרו is a project-level figure.
   * A row whose flight is already over keeps its rate — there are no days
   * left to spread new money over, and dividing by zero to invent one would
   * be worse than leaving it alone until the sheet recomputes.
   */
  const channels = useMemo(() => {
    if (!Object.keys(budgetEdits).length) return basisChannels;
    return basisChannels.map((c) => {
      const next = budgetEdits[c.channel];
      if (next == null || next === c.budget) return c;
      const daysLeft = daysLeftOf(c.endIso, today);
      return {
        ...c,
        budget: next,
        dailyRate:
          daysLeft > 0 ? c.dailyRate + (next - c.budget) / daysLeft : c.dailyRate,
      };
    });
  }, [basisChannels, budgetEdits, today]);

  /** Net change against the SERVER's budgets — never against the edited
   *  list, which would compound on a second edit of the same channel. */
  const budgetShift = useMemo(() => {
    let sum = 0;
    for (const c of data.channels) {
      const next = budgetEdits[c.channel];
      if (next != null) sum += next - c.budget;
    }
    return sum;
  }, [data.channels, budgetEdits]);
  // Does this project break google into a discovery row? If so, a
  // non-discovery google row is the search-only side of the split; if
  // not, a lone "google" row still represents all-google. Computed from
  // the full channel set so channel-filtering can't flip it.
  const hasGoogleDiscovery = channels.some(
    (c) => c.platform === "google" && GOOGLE_DISCOVERY_LABEL_RE.test(c.channel),
  );
  const sorted = useMemo(() => {
    if (!sort) return channels;
    // המרה לתיאום prints "—" under "dated" (see ConvCell), so it sorts as
    // "no value" there too — otherwise a click would order the table by a
    // ratio the reader cannot see. Array sort is stable, so the rows simply
    // keep their order.
    const val =
      sort.key === "r1" && basis === "dated" ? () => -1 : SORT_VAL[sort.key];
    return [...channels].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (typeof av === "string" || typeof bv === "string")
        return String(av).localeCompare(String(bv)) * sort.dir;
      return ((av as number) - (bv as number)) * sort.dir;
    });
  }, [channels, sort, basis]);
  const visible = useMemo(
    () =>
      selected === null ? sorted : sorted.filter((c) => selected.has(c.channel)),
    [sorted, selected],
  );

  if (!channels.length) {
    return <div className="rpt-empty">אין שורות ערוצים לפרויקט בתקופה הזו.</div>;
  }

  const alerts = pickChannelAlerts(channels, chLabel);
  const datesIrregular =
    flightCols &&
    !!data.window.startIso &&
    !!data.window.endIso &&
    channels.some(
      (c) =>
        c.startIso &&
        c.endIso &&
        (c.startIso !== data.window.startIso || c.endIso !== data.window.endIso),
    );

  // Totals reflect the *visible* (filtered) rows — matches the legacy
  // recomputeChannelsTableTotals so the bottom line agrees with the rows.
  const totals = visible.reduce(
    (t, c) => {
      t.budget += c.budget;
      t.spend += c.spend;
      t.leads += c.leads;
      t.scheduled += c.scheduled;
      t.meetings += c.meetings;
      t.daily += c.dailyRate;
      return t;
    },
    { budget: 0, spend: 0, leads: 0, scheduled: 0, meetings: 0, daily: 0 },
  );

  /**
   * "לא שויכו לשורה" — dated meetings in the period that no row could claim
   * (datedSource.unmatched* + ambiguous*), as a row of the סה״כ block.
   *
   * Without it the dated סה״כ was Σ attributed rows only, silently short of
   * the project's dated total: the overview card (ProjectReportData.
   * datedTotals, defined by computeDatedTotals as Σ rows + exactly this
   * remainder) and the table under it disagreed by the meetings of every
   * lead with no source or a source the table splits into several rows. With
   * the row added into סה״כ, the table's total IS the card's number.
   *
   * Shown only with no channel filter: the remainder belongs to no channel,
   * so it cannot belong to any filtered subset either, and a filtered total
   * is meant to add up its visible rows. Hidden when both counts are 0 — a
   * row of zeros is noise, and the total is unchanged without it.
   *
   * Lead-entry has no such row, on purpose: there the overview card is
   * `data.totals`, which is Σ rows in every mode — an ALL CLIENTS row set
   * adds up to its own total, and a live-recounted month keeps its
   * unclaimed meetings out of totals the same way (they are named in
   * basisNote instead). Adding a row would make the table disagree with the
   * card.
   */
  const unattributed =
    dated && datedSource && selected === null
      ? datedUnattributed(datedSource)
      : null;
  const showUnattributed =
    !!unattributed && (unattributed.scheduled > 0 || unattributed.meetings > 0);
  if (unattributed && showUnattributed) {
    totals.scheduled += unattributed.scheduled;
    totals.meetings += unattributed.meetings;
  }

  // One budget-utilization bar per row, spanning the תקציב + עלות cells: the
  // TRACK length ∝ this channel's budget (biggest budget in view = full width,
  // small budget = short bar), and it's FILLED to the actual spend on the same
  // scale (red when over budget). The bar is split across the two equal-width
  // cells — `a`/`b` are this cell's slice of the combined [0,1] bar: in RTL the
  // right cell (תקציב) is [0,.5], the left cell (עלות) is [.5,1]. Only in the
  // non-month view where both cells exist.
  const maxBudget = Math.max(1, ...visible.map((c) => c.budget));
  // Fill COLOUR = the channel's pacing health (green on-pace → red badly off),
  // so the bar reads good/bad at a glance. The fill LENGTH is still the spend,
  // the track LENGTH is still the budget. Neutral slate when there's no pacing
  // verdict yet (e.g. no configured daily budget to compare against).
  const paceFill = (cls: string): string => {
    switch (cls) {
      case "pacing-on":
        return "rgba(34,197,94,0.5)"; // green — on pace
      case "pacing-mild":
        return "rgba(234,179,8,0.5)"; // amber — slight drift
      case "pacing-warn":
        return "rgba(249,115,22,0.55)"; // orange — off pace
      case "pacing-severe":
        return "rgba(239,68,68,0.5)"; // red — badly off / budget exhausted
      default:
        return "rgba(100,116,139,0.36)"; // slate — no pacing verdict
    }
  };
  const spanBar = (
    budget: number,
    spend: number,
    a: number,
    b: number,
    paceCls: string,
  ): { backgroundImage: string } | undefined => {
    const budgetR = Math.min(budget / maxBudget, 1);
    if (budgetR <= 0) return undefined;
    const spendR = Math.min(spend / maxBudget, budgetR); // fill clamped into track
    const loc = (r: number) => Math.max(0, Math.min((r - a) / (b - a), 1)) * 100;
    const bL = loc(budgetR);
    const sL = loc(spendR);
    if (bL <= 0) return undefined;
    const track = "rgba(148,163,184,0.16)"; // neutral track = budget extent
    const fill = paceFill(paceCls);
    return {
      backgroundImage: `linear-gradient(to left, ${fill} ${sL}%, ${track} ${sL}%, ${track} ${bL}%, transparent ${bL}%)`,
    };
  };

  const toggleChannel = (ch: string) =>
    setSelected((cur) => {
      const base = cur ?? new Set(channels.map((c) => c.channel));
      const next = new Set(base);
      if (next.has(ch)) next.delete(ch);
      else next.add(ch);
      // Empty or full selection both mean "all" — snap back to null.
      if (next.size === 0 || next.size === channels.length) return null;
      return next;
    });
  const allChecked = selected === null;
  const filterLabel =
    selected === null
      ? "כל הערוצים"
      : selected.size === 1
        ? chLabel([...selected][0])
        : `${selected.size} ערוצים נבחרו`;
  // The total's "(N חדשים)" only when every visible row with leads carries
  // its own — a sum over some rows beside a total over all would read as
  // the project's new-lead count and be short of it.
  const totalNewLeads = visible.every((c) => c.leads <= 0 || c.newLeads != null)
    ? visible.reduce((n, c) => n + (c.newLeads ?? 0), 0)
    : undefined;
  // Same rule for "(N בוטלו)". Under the dated basis no row carries one
  // (applyBasisToChannels drops it), so this is undefined there by itself.
  const totalCancelled = visible.every((c) => c.scheduled <= 0 || c.cancelledScheduled != null)
    ? visible.reduce((n, c) => n + (c.cancelledScheduled ?? 0), 0)
    : undefined;
  const tCpl = totals.leads > 0 ? totals.spend / totals.leads : 0;
  const tCps = totals.scheduled > 0 ? totals.spend / totals.scheduled : 0;
  const tCpm = totals.meetings > 0 ? totals.spend / totals.meetings : 0;
  const tR1 = totals.leads > 0 ? totals.scheduled / totals.leads : null;
  const tR2 = totals.scheduled > 0 ? totals.meetings / totals.scheduled : null;

  const onSort = (key: SortKey) =>
    setSort((cur) =>
      cur?.key === key
        ? { key, dir: cur.dir === 1 ? -1 : 1 }
        : { key, dir: key === "channel" ? 1 : -1 },
    );

  const Th = ({ k, label }: { k: SortKey; label: string }) => (
    <th
      role="button"
      tabIndex={0}
      onClick={() => onSort(k)}
      className={sort?.key === k ? "is-sorted" : undefined}
      title="מיון"
    >
      {label}
      {sort?.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );

  const dismissPacing = async (c: ReportChannel, restore: boolean) => {
    const key = pacingChannelKey(data.slug, c.channel);
    setLocalDismiss((cur) => ({ ...cur, [key]: restore ? "off" : "on" }));
    try {
      const res = await fetch("/api/campaigns/budget-dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: data.slug,
          channel: c.channel,
          platform: c.platform,
          baselineDaily: c.configuredDaily ?? 0,
          restore,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      // Roll back the optimistic state on failure.
      setLocalDismiss((cur) => ({ ...cur, [key]: restore ? "on" : "off" }));
    }
  };

  const diagCards =
    basis === "dated"
      ? diagnosePaidChannels(channels).filter((c) => !isQualityLeakCard(c))
      : diagnosePaidChannels(channels);

  /**
   * The "—" each meeting-derived cell shows when the current basis has no
   * honest number for it. Built once and reused by every row and the סה״כ
   * line, so all of them carry the same tooltip.
   *   noSource   — "dated" with no dated source for this table.
   *   r1Dash     — המרה לתיאום under "dated": cross-basis when the table has
   *                dated meetings (they would be divided by entry-dated
   *                leads), no-source when it has none at all.
   *   r2Dash     — המרה לביצוע stays a real ratio under "dated" (dated ÷
   *                dated), so it is dashed only when there is no source.
   */
  const noSource = meetingsMissing ? (
    <BasisDash reason="no-source" basis="dated" />
  ) : null;
  const r1Dash =
    basis !== "dated"
      ? undefined
      : noSource ?? <BasisDash reason="cross-basis" />;
  const r2Dash = noSource ?? undefined;

  return (
    <div className="rpt-channels">
      {/* Internal quick-links (classic-report parity) — the performance-report
          Google Sheet + the Google/Facebook ads managers. Gated by
          canEditBudget (media/manager, not client/preview) and hidden in the
          client view (see .rpt-clientview rule). */}
      {canEditBudget &&
        adLinks &&
        (adLinks.sheetUrl || adLinks.gAdsUrl || adLinks.fbAdsUrl) && (
          <div className="rpt-ch-quicklinks">
            {adLinks.sheetUrl && (
              <a
                className="rpt-ch-qlink is-sheet"
                href={adLinks.sheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="פתח את גיליון דוח הביצועים (Google Sheets)"
              >
                <span aria-hidden>📊</span> דוח ביצועים
              </a>
            )}
            {adLinks.gAdsUrl && (
              <a
                className="rpt-ch-qlink is-gads"
                href={adLinks.gAdsUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="פתח את הקמפיינים ב-Google Ads"
              >
                <GoogleAdsIcon size="1em" /> Google Ads
              </a>
            )}
            {adLinks.fbAdsUrl && (
              <a
                className="rpt-ch-qlink is-fbads"
                href={adLinks.fbAdsUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="פתח את הקמפיינים ב-Facebook Ads"
              >
                <FacebookAdsIcon size="1em" /> Facebook Ads
              </a>
            )}
          </div>
        )}
      {alerts.length > 0 && (
        <div className="rpt-ch-alerts">
          {alerts.map((a, i) => (
            <div key={i} className={`rpt-ch-alert is-${a.type}`}>
              {a.text}
            </div>
          ))}
        </div>
      )}

      {data.budgetSummary && (
        <BudgetStrip s={data.budgetSummary} shift={budgetShift} />
      )}

      {diagCards.length > 0 && (
        <div className="rpt-paid-diag">
          {diagCards.map((c, i) => (
            <div key={i} className={`rpt-pd-card is-${c.tone}`}>
              <div className="rpt-pd-head">
                {c.icon} {c.head}
              </div>
              <div dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />
              {c.sample && <div className="rpt-pd-sample">{c.sample}</div>}
              {c.tipHtml && (
                <div className="rpt-pd-tip" dangerouslySetInnerHTML={{ __html: `💡 ${c.tipHtml}` }} />
              )}
            </div>
          ))}
        </div>
      )}

      {ganttFor !== null && (
        <ChannelGantt
          channels={channels}
          window={data.window}
          currentKey={ganttFor}
        />
      )}

      {/* The meeting-basis toggle that used to open this row moved to the
          page header (MeetingBasisToggle) — its tooltip also described the
          lead-entry count as "leads whose meeting took place", which is not
          what any CRM source counts (see `basis` above; the corrected copy
          is BASIS_TITLES in lib/meetingBasis). The row keeps the filter. */}
      {channels.length > 1 && (
        <div className="rpt-ch-tablecontrols">
          <span className="rpt-ch-tablecontrols-lbl">סינון לפי ערוץ:</span>
          <div className="rpt-mt-filter">
            <button
              type="button"
              className="rpt-mt-filter-btn"
              onClick={() => setFilterOpen((o) => !o)}
              aria-expanded={filterOpen}
            >
              {filterLabel} ▾
            </button>
            {filterOpen && (
              <>
                <div
                  className="rpt-ch-filter-backdrop"
                  onClick={() => setFilterOpen(false)}
                />
                <div className="rpt-mt-filter-panel" role="listbox">
                  <label className="rpt-mt-filter-opt is-all">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={(el) => {
                        // Indeterminate only for a partial selection; a full
                        // deselect (empty set) reads as a clean unchecked box.
                        if (el)
                          el.indeterminate =
                            selected !== null && selected.size > 0;
                      }}
                      // Proper master toggle: when everything is shown, clicking
                      // clears the selection (empty set → no rows); otherwise it
                      // re-selects all. Previously it always set null, so clicking
                      // it while all were selected did nothing.
                      onChange={() =>
                        setSelected(allChecked ? new Set<string>() : null)
                      }
                    />
                    <b>כל הערוצים</b>
                  </label>
                  {channels.map((c) => {
                    const on = selected === null || selected.has(c.channel);
                    return (
                      <label key={c.channel} className="rpt-mt-filter-opt">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleChannel(c.channel)}
                        />
                        <ChLabel name={c.channel} />
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {rangeNote && <p className="rpt-basis-note">📅 {rangeNote}</p>}
      {basisNote && <p className="rpt-basis-note">{basisNote}</p>}
      {frozenWasNote && <p className="rpt-basis-note">{frozenWasNote}</p>}

      <div className="rpt-ch-table-wrap">
        <table className="rpt-ch-table">
          <thead>
            <tr>
              <Th k="channel" label="ערוץ" />
              {flightCols && <Th k="budget" label="תקציב" />}
              <Th k="spend" label="עלות" />
              <Th k="leads" label="לידים" />
              <Th k="cpl" label="עלות לליד" />
              <Th k="r1" label="המרה לתיאום" />
              <Th k="scheduled" label="תיאומים" />
              <Th k="cps" label="עלות לתיאום" />
              <Th k="r2" label="המרה לביצוע" />
              <Th k="meetings" label="ביצועים" />
              <Th k="cpm" label="עלות לביצוע" />
              {flightCols && <Th k="daily" label="קצב יומי" />}
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => {
              const subs = c.subCampaigns.filter((s) => s.name);
              const dot = STATUS_DOT[c.campaignStatus];
              // For Google, pick the campaign-kind-split daily series so
              // discovery and non-discovery rows get DISTINCT trends
              // (data.daily.google is the COMBINED series — showing it on
              // both rows made them identical). A discovery-labelled row →
              // discovery series. A non-discovery google row → the
              // search-only series WHEN discovery is a separate row (the
              // two rows then partition google cleanly, e.g. אנדה's
              // "google" + "Google-discovery"); otherwise a lone "google"
              // row keeps the combined all-google series.
              const gk = data.dailyGoogleByKind;
              // `c.daily` is this row's OWN campaigns (matched by its סוג
              // tokens — the same set `configuredDaily` sums), so prefer it
              // whenever the server could build it. The google-by-kind split
              // below was the narrow version of this fix and stays as the
              // fallback for rows with no tokens to match on; facebook had no
              // equivalent at all, which is why every facebook row showed the
              // whole platform's spend under its own name.
              const trendSource =
                c.daily?.length
                  ? c.daily
                  : c.platform === "google"
                    ? gk && GOOGLE_DISCOVERY_LABEL_RE.test(c.channel)
                      ? gk.discovery
                      : gk && hasGoogleDiscovery
                        ? gk.search
                        : (data.daily?.google ?? [])
                    : (data.daily?.facebook ?? []);
              const trendDaily =
                (c.platform === "google" || c.platform === "facebook") &&
                c.spend > 0 &&
                // No trend at all when the cost is partly estimated (free
                // ranges, where the daily feed cannot see some of a row's
                // months). Its own matched series would total less than the
                // cell and the platform fallback above totals more — with
                // nothing that reconciles, the honest popover is none.
                !c.spendEstimated
                  ? windowDaily(
                      trendSource,
                      data.window.startIso,
                      data.window.endIso,
                    )
                  : [];
              const chipDiffers =
                datesIrregular &&
                c.startIso &&
                c.endIso &&
                (c.startIso !== data.window.startIso ||
                  c.endIso !== data.window.endIso);
              const pacing = flightCols
                ? computeChannelPacing(c)
                : null;
              const gapStillOff =
                pacing?.action === "lower" || pacing?.action === "raise";
              const paceKey = pacingChannelKey(data.slug, c.channel);
              const fade = fadeStateOf(
                pacingDismissals[paceKey],
                today,
                localDismiss[paceKey],
                !!gapStillOff,
              );
              const chKey = c.channel.toLowerCase();
              const leadsWarn = leadsDivergence(c);
              return (
                <tr key={c.channel}>
                  <td
                    className={
                      "rpt-ch-name" +
                      (trendDaily.length >= 2 ? " has-trend" : "")
                    }
                  >
                    <span className="rpt-ch-label"><ChLabel name={c.channel} /></span>
                    {dot && (
                      <span
                        className={`rpt-ch-dot ${dot.cls}`}
                        title={dot.title}
                      />
                    )}
                    {subs.length > 1 && (
                      <span
                        className="rpt-ch-subs"
                        title={subs
                          .map(
                            (s) =>
                              `${s.name}: ${fmtILS(s.spend)} · ${fmtInt(s.leads)} לידים`,
                          )
                          .join("\n")}
                      >
                        ({subs.length})
                      </span>
                    )}
                    {chipDiffers && (
                      <button
                        type="button"
                        className={
                          "rpt-ch-datechip" +
                          (ganttFor === chKey ? " is-open" : "")
                        }
                        title="חלון התאריכים של הערוץ — לחצו לתרשים"
                        onClick={() =>
                          setGanttFor((cur) => (cur === chKey ? null : chKey))
                        }
                      >
                        📅 {fmtDateHe(c.startIso).slice(0, 5)}–
                        {fmtDateHe(c.endIso).slice(0, 5)}
                      </button>
                    )}
                    {trendDaily.length >= 2 && (
                      <ChannelTrendPop channel={c.channel} series={trendDaily} />
                    )}
                  </td>
                  {flightCols && (
                    <td
                      className="rpt-budcell rpt-money-cell"
                      style={spanBar(c.budget, c.spend, 0, 0.5, pacing?.cls ?? "")}
                    >
                      {canEditBudget && data.tabSlug ? (
                        <BudgetCell
                          tabSlug={data.tabSlug}
                          channel={c.channel}
                          budget={c.budget}
                          distribute={subs.length > 1}
                          onSaved={(ch, next) =>
                            setBudgetEdits((m) => ({ ...m, [ch]: next }))
                          }
                        />
                      ) : (
                        fmtILS(c.budget)
                      )}
                    </td>
                  )}
                  <td
                    className="rpt-money-cell"
                    style={
                      flightCols
                        ? spanBar(c.budget, c.spend, 0.5, 1, pacing?.cls ?? "")
                        : undefined
                    }
                  >
                    {fmtILS(c.spend)}
                  </td>
                  <td title={leadsTooltip(c)}>
                    {fmtInt(c.leads)}
                    <NewLeads leads={c.leads} fresh={c.newLeads} />
                    {leadsWarn && (
                      <span className="rpt-ch-diverge" title={leadsWarn}>
                        ⚠️
                      </span>
                    )}
                  </td>
                  <td style={costHeatStyle("costPerLead", c.costPerLead)}>
                    {c.costPerLead > 0 ? fmtILS(c.costPerLead) : "—"}
                  </td>
                  <ConvCell r={r1Of(c)} dash={r1Dash} />
                  <td>
                    {noSource ?? (
                      <>
                        {fmtInt(c.scheduled)}
                        <CancelledPart scheduled={c.scheduled} cancelled={c.cancelledScheduled} />
                      </>
                    )}
                  </td>
                  <td
                    style={costHeatStyle("costPerScheduled", c.costPerScheduled)}
                  >
                    {noSource ??
                      (c.costPerScheduled > 0 ? fmtILS(c.costPerScheduled) : "—")}
                  </td>
                  <ConvCell r={r2Of(c)} dash={r2Dash} />
                  <td>{noSource ?? fmtInt(c.meetings)}</td>
                  <td style={costHeatStyle("costPerMeeting", c.costPerMeeting)}>
                    {noSource ??
                      (c.costPerMeeting > 0 ? fmtILS(c.costPerMeeting) : "—")}
                  </td>
                  {flightCols && (
                    <td
                      className={
                        "rpt-pace" +
                        (pacing?.cls ? ` ${pacing.cls}` : "") +
                        (fade === "dismissed" ? " is-handled" : "")
                      }
                      title={pacing?.lines.join("\n") || undefined}
                    >
                      {fade === "dismissed" && (
                        <span className="rpt-pace-mark" title="טופל">
                          ✓
                        </span>
                      )}
                      {gapStillOff && fade !== "dismissed" && (
                        <span
                          className="rpt-pace-alert"
                          title="התקציב היומי בפלטפורמה לא תואם את הנדרש — נדרש עדכון"
                        >
                          ⚠️
                        </span>
                      )}
                      <span className="rpt-pace-num">
                        {c.dailyRate ? fmtILS(c.dailyRate) : "—"}
                      </span>
                      {pacing?.action === "lower" && (
                        <span className="rpt-pace-action" aria-label="הורד תקציב"> ⬇</span>
                      )}
                      {pacing?.action === "raise" && (
                        <span className="rpt-pace-action" aria-label="העלה תקציב"> ⬆</span>
                      )}
                      {pacing?.action === "investigate" && (
                        <span className="rpt-pace-action" aria-label="בדוק delivery"> 🔍</span>
                      )}
                      {gapStillOff && fade !== "dismissed" && (
                        <button
                          type="button"
                          className="rpt-pace-btn"
                          title="טיפלתי — שקט עד מחר; אם עדיין יישאר פער בין התקציב המוגדר לנדרש, ההתראה תחזור מחר"
                          onClick={() => dismissPacing(c, false)}
                        >
                          ✓{fade === "resurfaced" ? " (חזר)" : ""}
                        </button>
                      )}
                      {fade === "dismissed" && (
                        <button
                          type="button"
                          className="rpt-pace-btn"
                          title="בטל טיפול"
                          onClick={() => dismissPacing(c, true)}
                        >
                          ↩︎
                        </button>
                      )}
                      {canEditBudget &&
                        c.dailyRate > 0 &&
                        (() => {
                          const url =
                            c.platform === "google"
                              ? adLinks?.gAdsUrl
                              : c.platform === "facebook"
                                ? adLinks?.fbAdsUrl
                                : "";
                          if (!url) return null;
                          const openUrl =
                            c.platform === "google"
                              ? `${url}${url.includes("#") ? "" : `#fandf-filter=${encodeURIComponent(data.slug)}`}`
                              : url;
                          return (
                            <CopyAmountButton
                              amount={String(Math.round(c.dailyRate))}
                              // Google: copy the slug too, so it can be pasted
                              // into Google Ads' own search (its URL can't
                              // pre-filter). FB: the fbAdsUrl already filters by
                              // the project slug, so the clipboard only needs
                              // the number — no slug (matches BudgetGrid).
                              copyId={
                                c.platform === "facebook" ? undefined : data.slug
                              }
                              url={openUrl}
                              variant="ghost"
                              label="⧉"
                            />
                          );
                        })()}
                    </td>
                  )}
                </tr>
              );
            })}
            {unattributed && showUnattributed && (
              // Not a channel: no spend, no leads, so every money and ratio
              // cell is left EMPTY rather than "—" — nothing is missing
              // there, the columns just don't apply. It sits above סה״כ
              // because סה״כ adds it in (see `unattributed`).
              <tr className="rpt-basis-unattr-row">
                <td title={BASIS_COPY.unattributedRow.title}>
                  <span className="rpt-ch-label">
                    {BASIS_COPY.unattributedRow.label}
                  </span>
                </td>
                {flightCols && <td />}
                <td />
                <td />
                <td />
                <td />
                <td>{fmtInt(unattributed.scheduled)}</td>
                <td />
                <td />
                <td>{fmtInt(unattributed.meetings)}</td>
                <td />
                {flightCols && <td />}
              </tr>
            )}
            <tr className="rpt-ch-totals">
              <td>
                <b>סה״כ</b>
              </td>
              {flightCols && (
                <td>
                  <b>{fmtILS(totals.budget)}</b>
                </td>
              )}
              <td>
                <b>{fmtILS(totals.spend)}</b>
              </td>
              <td>
                <b>{fmtInt(totals.leads)}</b>
                <NewLeads leads={totals.leads} fresh={totalNewLeads} />
              </td>
              <td style={costHeatStyle("costPerLead", tCpl)}>
                <b>{tCpl > 0 ? fmtILS(tCpl) : "—"}</b>
              </td>
              <ConvCell r={tR1} dash={r1Dash} />
              <td>
                <b>{noSource ?? fmtInt(totals.scheduled)}</b>
                {!noSource && (
                  <CancelledPart scheduled={totals.scheduled} cancelled={totalCancelled} />
                )}
              </td>
              <td style={costHeatStyle("costPerScheduled", tCps)}>
                <b>{noSource ?? (tCps > 0 ? fmtILS(tCps) : "—")}</b>
              </td>
              <ConvCell r={tR2} dash={r2Dash} />
              <td>
                <b>{noSource ?? fmtInt(totals.meetings)}</b>
              </td>
              <td style={costHeatStyle("costPerMeeting", tCpm)}>
                <b>{noSource ?? (tCpm > 0 ? fmtILS(tCpm) : "—")}</b>
              </td>
              {flightCols && (
                <td>
                  <b>{totals.daily ? fmtILS(totals.daily) : "—"}</b>
                </td>
              )}
            </tr>
          </tbody>
        </table>
      </div>

      <ReportChannelCharts
        channels={channels}
        meetingsUnavailable={
          meetingsMissing ? BASIS_COPY.dashNoSource.dated : undefined
        }
      />
    </div>
  );
}
