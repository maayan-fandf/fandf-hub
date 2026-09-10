import type { CrmFunnel } from "@/lib/crmData";

/**
 * Client-safe pieces of the CRM daily-leads chart, shared by its two hosts:
 * the project page's CRM card (CrmFunnelClient) and the budget desk's
 * per-project strip (BudgetCrmDaily). No server imports — both bundle this.
 */

/** Media-channel colors — large + well-separated so channels don't recycle
 *  the same hue. (Was a 10-color palette → the 11th channel collided with
 *  the 1st, and objections reused these same colors. A project here can
 *  have ~13+ sources.) Lives here, not in CrmFunnelClient, so the budget
 *  desk colors a project's sources exactly as that project's own page does. */
export const CHANNEL_PALETTE = [
  "#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9",
  "#8b5cf6", "#14b8a6", "#ef4444", "#84cc16", "#f97316",
  "#06b6d4", "#d946ef", "#22c55e", "#eab308", "#3b82f6",
  "#fb7185", "#a855f7", "#0d9488", "#65a30d", "#e11d48",
];

/** source → color, indexed by the funnel's `allSources` (lead count desc) —
 *  the same assignment CrmFunnelClient makes. */
export function paletteFor(allSources: string[]): Map<string, string> {
  const m = new Map<string, string>();
  allSources.forEach((s, i) => m.set(s, CHANNEL_PALETTE[i % CHANNEL_PALETTE.length]));
  return m;
}

export type CrmDailySeries = CrmFunnel["dailyTimeSeries"];

export type CrmDaily =
  | {
      status: "ok";
      platform: string;
      /** The window the funnel resolved (the project's flight), ISO. */
      from: string;
      to: string;
      /** Newest lead date for THIS project — one input to the horizon. */
      dataTo: string;
      /** Which feed the funnel was routed to ("sheet" | "warehouse"). The
       *  two sync on their own schedules, so each has its own horizon. */
      source: string;
      /** Sources by lead count, desc — indexes the palette. */
      allSources: string[];
      days: CrmDailySeries;
      leads: number;
      scheduled: number;
      held: number;
      /** Leads in `leads` that no bar can hold: the daily series drops rows
       *  with no מקור הגעה or no parseable date (lib/crmData.ts, the
       *  `if (d && src)` guards). Surfaced so a day made only of such leads
       *  is not silently read as a zero day. */
      unsourced: number;
      /** Leads per day counting sourceless ones too (CrmFunnel.
       *  dailyLeadTotals) — the zero-day test reads THIS, not the bars. */
      dayTotals: Record<string, number>;
    }
  /** Mapped in Keys, but not one lead in the window — the loudest case. */
  | { status: "no-leads"; platform: string; from: string; to: string }
  | { status: "no-crm" }
  | { status: "unsupported"; platform: string }
  | { status: "error"; message: string };

export type CrmDailyBundle = {
  /** lowercase tab (slug) → that project's series. */
  byTab: Record<string, CrmDaily>;
  /**
   * horizonKey(platform, source) → the newest lead day that FEED holds, for
   * any project (lib/crmData getCrmFeedNewestDays), pushed later by any desk
   * project's own last lead.
   *
   * The freshness line. One project's own last-lead date cannot tell "the
   * CRM feed is behind" from "this project got nothing" — the project page's
   * "נתונים עד" tooltip concedes exactly that. The feed as a whole can: if
   * BMBY has leads through yesterday and this project's last one is five
   * days old, those five days are real zeros. (First built from the desk
   * projects alone; a feed with one routed project then measured only that
   * project, and its empty days drew grey — found in review, 2026-09-10.)
   *
   * The horizon day ITSELF is not one of them — see lastReportedDay.
   */
  horizon: Record<string, string>;
  ms: number;
  error?: string;
};

export function horizonKey(platform: string, source: string): string {
  return `${platform}:${source || "sheet"}`;
}

/**
 * The last day a zero can be called a zero: the day BEFORE the feed's
 * newest lead, and never later than yesterday (today is not over).
 *
 * Not the horizon day itself, because that day is almost always PARTIAL —
 * a lead dated D exists because a sync ran DURING D, not after it. Measured
 * 2026-09-10: the warehouse last synced 09-09 04:36 IL, and 7 BMBY leads
 * carried 09-09 against 192 on 09-08. Counting 09-09 would have painted a
 * false red day on nearly every BMBY row. A feed that syncs through the
 * night loses nothing by this: its newest lead is today, and the rule
 * lands on yesterday either way.
 *
 * `horizon` may be empty (no project on the feed had a lead) — then only
 * the today rule applies.
 */
export function lastReportedDay(horizon: string, today: string): string {
  const yesterday = isoAddDays(today, -1);
  if (!horizon) return yesterday;
  const beforeHorizon = isoAddDays(horizon, -1);
  return beforeHorizon < yesterday ? beforeHorizon : yesterday;
}

/** Freshest horizon across a platform's feeds — for a project with no
 *  funnel, where the feed it WOULD have been routed to is unknown. */
export function platformHorizon(
  horizon: Record<string, string>,
  platform: string,
): string {
  let best = "";
  for (const [k, v] of Object.entries(horizon)) {
    if (k.startsWith(`${platform}:`) && v > best) best = v;
  }
  return best;
}

export function isoAddDays(iso: string, n: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Every calendar day in [from, to], in order, with an empty entry wherever
 * the CRM had nothing.
 *
 * The chart places bars by array POSITION, and the funnel's series only
 * holds days that had a lead — so without this a day with no leads simply
 * vanishes and its neighbours close the gap. That is the one thing the
 * budget desk's strip exists to show.
 */
export function fillDailySeries(
  days: CrmDailySeries,
  from: string,
  to: string,
): CrmDailySeries {
  if (!from || !to || to < from) return [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out: CrmDailySeries = [];
  // The 800-day cap only guards a malformed window (a real flight is weeks
  // to months). It is anchored at `to`, so if it ever bites it drops the
  // OLDEST days — never the recent ones this exists to show.
  const floor = isoAddDays(to, -799);
  for (let d = from > floor ? from : floor; d <= to; d = isoAddDays(d, 1)) {
    out.push(byDate.get(d) ?? { date: d, bySource: [] });
  }
  return out;
}
