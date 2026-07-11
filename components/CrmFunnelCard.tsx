import {
  getCrmFunnelForProject,
  canonicalMediaChannel,
  type CrmFunnel,
} from "@/lib/crmData";
import {
  getAllClientsCurrentForProject,
  getAllClientsMonthlyForProject,
} from "@/lib/allClients";
import { getProjectSlug } from "@/lib/campaignMatch";
import { getSpendInRange } from "@/lib/platformDailySpend";
import { driveFolderOwner } from "@/lib/sa";
import CrmFunnelClient from "./CrmFunnelClient";

/** Canonical channels that have real daily spend in the GADS2/FB daily file
 *  (programmatic) — their free-range cost is summed actual spend, not the
 *  pro-rated monthly fee used for everything else. */
const PROGRAMMATIC_CHANNELS = new Set([
  "facebook",
  "google-search",
  "google-discovery",
  "taboola",
  "outbrain",
]);

/**
 * Server wrapper — fetches the CRM funnel cohort and hands the full
 * payload to the client component. All five views (KPI tiles, status
 * funnel, objections × source matrix, objection pie, trendline) are
 * client-side rendered so the section's master chip filter can
 * re-aggregate every surface against the selected source mix without
 * re-fetching.
 *
 * Returns null when the project has no Keys.CRM mapping or the source
 * tab has zero matches — caller wraps in <Suspense fallback={null}> so
 * projects without CRM data silently collapse.
 */
/** Split an inclusive ISO range [from,to] into per-calendar-month segments,
 *  each carrying how many of its days fall inside the range and how many days
 *  the whole month has — the basis for pro-rating fixed monthly cost. */
function monthSegments(
  from: string,
  to: string,
): { month: string; daysInRange: number; daysInMonth: number }[] {
  const out: { month: string; daysInRange: number; daysInMonth: number }[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return out;
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth(); // 0-based
  while (true) {
    const monthStart = new Date(Date.UTC(y, m, 1));
    const monthEnd = new Date(Date.UTC(y, m + 1, 0)); // last day of month
    const daysInMonth = monthEnd.getUTCDate();
    const segStart = monthStart > start ? monthStart : start;
    const segEnd = monthEnd < end ? monthEnd : end;
    const daysInRange =
      Math.round((segEnd.getTime() - segStart.getTime()) / 86400000) + 1;
    const month = `${y}-${String(m + 1).padStart(2, "0")}`;
    if (daysInRange > 0) out.push({ month, daysInRange, daysInMonth });
    if (y === end.getUTCFullYear() && m === end.getUTCMonth()) break;
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return out;
}

export default async function CrmFunnelCard({
  company,
  project,
  monthFilter,
  dateRange,
  view = "full",
}: {
  company: string;
  project: string;
  /** Splits the card for the native rail: "funnel" (CRM section) vs
   *  "analysis" (התנגדויות ומסע). Default "full" keeps every current caller
   *  (classic project page, /morning) rendering the whole card. */
  view?: "full" | "funnel" | "analysis";
  /** Threaded from the page's `?monthOverride=YYYY-MM` so this card
   *  matches whatever month the dashboard iframe is rendering. Empty
   *  means "no filter — show all rows we have." */
  monthFilter?: string;
  /** Free from–to range (`?from=&to=`) — takes priority over monthFilter.
   *  Channel cost is pro-rated to the selected days: past months from the
   *  monthly חודשי spend (÷ days-in-month × days-in-range), the current
   *  month from the daily budget (קצב יומי × days-in-range). */
  dateRange?: { from: string; to: string };
}) {
  // Default the cohort to the project's flight-date window (התחלה→סיום
  // from ALL CLIENTS) so the funnel matches the report header's date
  // range. Skipped when an explicit monthFilter is set (the dashboard's
  // month-rewind view takes priority). getAllClientsCurrentForProject is
  // request-cached, so this read is deduped with the alerts section.
  let projectWindow: { from: string; to: string } | undefined;
  // Per-channel media spend over the flight window — the SAME ALL CLIENTS
  // rows we read for the window also carry `spend` per `מזהה BMBY`
  // channel. Canonicalize each to the cost-join key so crmData can
  // attribute it onto the CRM lead sources (the anda model). Flight-window
  // mode only; the month-rewind view (monthFilter) shows the funnel
  // without cost for now.
  let spendByChannel: Record<string, number> | undefined;
  if (dateRange?.from && dateRange?.to) {
    // Free range. Two cost sources by channel type:
    //   • PROGRAMMATIC (FB / Google / Taboola / Outbrain) — actual daily
    //     spend summed over the range from the GADS2/FB daily file (budget
    //     is irrelevant; we want what was really spent).
    //   • NON-programmatic (yad2 / מדלן / כתבה / phone …) — the monthly
    //     spent cost (ALL CLIENTS `עלות`) pro-rated: ÷ days-in-month ×
    //     days-of-that-month-in-range, summed across the months in the range.
    projectWindow = { from: dateRange.from, to: dateRange.to };
    const owner = driveFolderOwner();
    const spend: Record<string, number> = {};
    // Non-programmatic: pro-rate monthly עלות, month by month.
    for (const seg of monthSegments(dateRange.from, dateRange.to)) {
      const mo = await getAllClientsMonthlyForProject({
        subjectEmail: owner,
        project,
        yearMonth: seg.month,
      }).catch(() => []);
      for (const r of mo) {
        const ch = canonicalMediaChannel(r.channel);
        if (ch && !PROGRAMMATIC_CHANNELS.has(ch) && r.spend)
          spend[ch] =
            (spend[ch] || 0) +
            (r.spend / Math.max(1, seg.daysInMonth)) * seg.daysInRange;
      }
    }
    // Programmatic: real spend over the exact range (channel split built-in).
    const slug = await getProjectSlug(owner, project).catch(() => null);
    if (slug) {
      const byProject = await getSpendInRange(
        owner,
        dateRange.from,
        dateRange.to,
      ).catch(() => ({}) as Record<string, Record<string, number>>);
      const ps = byProject[slug];
      if (ps) {
        if (ps.facebook) spend["facebook"] = (spend["facebook"] || 0) + ps.facebook;
        if (ps.google) spend["google-search"] = (spend["google-search"] || 0) + ps.google;
        if (ps.taboola) spend["taboola"] = (spend["taboola"] || 0) + ps.taboola;
        if (ps.outbrain) spend["outbrain"] = (spend["outbrain"] || 0) + ps.outbrain;
      }
    }
    if (Object.keys(spend).length) spendByChannel = spend;
  } else if (!monthFilter) {
    const acRows = await getAllClientsCurrentForProject({
      subjectEmail: driveFolderOwner(),
      project,
    }).catch(() => []);
    let from = "";
    let to = "";
    const spend: Record<string, number> = {};
    for (const r of acRows) {
      if (r.startIso && (!from || r.startIso < from)) from = r.startIso;
      if (r.endIso && (!to || r.endIso > to)) to = r.endIso;
      const ch = canonicalMediaChannel(r.channel);
      if (ch && r.spend) spend[ch] = (spend[ch] || 0) + r.spend;
    }
    if (from && to) projectWindow = { from, to };
    if (Object.keys(spend).length) spendByChannel = spend;
  } else {
    // Month-rewind view: the "current" rows only cover the flight window,
    // so pull THAT month's per-channel spend from the ALL CLIENTS monthly
    // (חודשי) rows instead, keyed the same canonical way.
    const moRows = await getAllClientsMonthlyForProject({
      subjectEmail: driveFolderOwner(),
      project,
      yearMonth: monthFilter,
    }).catch(() => []);
    const spend: Record<string, number> = {};
    for (const r of moRows) {
      const ch = canonicalMediaChannel(r.channel);
      if (ch && r.spend) spend[ch] = (spend[ch] || 0) + r.spend;
    }
    if (Object.keys(spend).length) spendByChannel = spend;
  }

  const funnel = await getCrmFunnelForProject({
    company,
    project,
    // A free range supersedes the month-rewind filter — the funnel then
    // windows on projectWindow (the range) for leads/scheduled/held.
    monthFilter: dateRange?.from && dateRange?.to ? undefined : monthFilter,
    projectWindow,
    spendByChannel,
  }).catch(() => null);
  if (!funnel || funnel.leads === 0) return null;
  return <CrmFunnelClient funnel={funnel} view={view} />;
}

// Re-export so callers (alerts, etc.) keep importing from one place.
export type { CrmFunnel };
