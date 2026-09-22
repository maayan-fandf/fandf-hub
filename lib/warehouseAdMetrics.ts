import { cache } from "react";
import { orExactFilter, supabaseConfigured, supabaseFetch } from "@/lib/supabase";

/**
 * Per-ad DAILY metrics read from the Supabase warehouse, as a FALLBACK for
 * the `facebook-ads-metrics` Supermetrics tab.
 *
 * Why this exists. That tab is the only source of the Facebook ad CARDS —
 * lib/reportCreatives builds `fbAds` from it and nothing else, so every
 * number, every card and every cost history on the קמפיינים tab lives or
 * dies with it. On 2026-09-22 it was found completely empty: no rows, not
 * even a header, while its query in the workbook's registry reported
 * "Refreshed successfully by trigger" at 07:07 that morning. `facebook-ads-
 * assets 365` went the same way at 07:09. The connector cleared both tabs,
 * wrote nothing, and called it a success — the identical failure that took
 * the assets tab out on 2026-08-25 and prompted lib/warehouseCreatives.
 *
 * That one restored IMAGERY onto cards that still existed. This restores the
 * cards themselves, from `meta_ad_insights_daily` — Nadav's nightly Meta
 * sync, which owns the same facts and does not depend on Supermetrics. The
 * two compose: with both tabs empty the ads come from here and their
 * pictures from there, and the cards render complete.
 *
 * PRECEDENCE: the sheet always wins. The caller only asks when the tab
 * produced NO rows for the project at all (fillAdsFromWarehouse), so a
 * healthy tab never reaches this file and a partially-populated one is left
 * exactly as it is — a half-warehouse, half-sheet card set would mix two
 * lookback windows and two definitions of a lead in one table.
 *
 * NOT covered, deliberately: the KPI totals. Those come from the
 * `Facebook-adsets` tab, which has its own query and was refreshing normally
 * through both outages. If it ever empties too, the tab's headline numbers
 * go with it and this fallback will not fill them.
 */

/** Campaign names resolved to ids per call. A project runs a handful; the cap
 *  only stops a mis-matched slug from firing a long tail of lookups. */
const MAX_CAMPAIGNS = 24;

/** Safety valve on the daily read. A busy project runs ~15 ads × 365 days
 *  ≈ 5,500 rows; this clears that several times over. */
const MAX_ROWS = 20000;

/** Rows per page. PostgREST caps a response at 1,000 whatever we ask for. */
const PAGE_SIZE = 1000;

/**
 * Clocks on the read — one per page, one for the whole thing. This runs
 * inside a project page's render, and the report is already slow; a
 * degraded-path extra must never be what keeps the page waiting.
 *
 * Both were sized against the table under load on 2026-09-22, when single-row
 * reads were taking 18s and filtered ones were ending in "canceling statement
 * due to statement timeout" after two minutes. Giving up costs the Facebook
 * cards, which is exactly the state the page is in without this file at all.
 */
const PAGE_TIMEOUT_MS = 12000;
const TOTAL_BUDGET_MS = 25000;

/** Lookback, mirroring the tab this replaces (`last365daysinc`). The card
 *  hover reads the whole span as an ad's cost history, so a shorter window
 *  would quietly shorten every ad's history the moment the fallback engages.
 *  What actually comes back is usually shorter — see the lead floor below. */
const LOOKBACK_DAYS = 365;

export type WarehouseAdMetric = {
  /** YYYY-MM-DD, as the sheet's parsed `date` is. */
  date: string;
  /** Meta ad-account id. The sheet carries the account NAME, so the caller
   *  maps it through the workbook's `Accounts lookup` tab. */
  accountId: string;
  campaign: string;
  ad: string;
  impressions: number;
  clicks: number;
  cost: number;
  leads: number;
};

export type WarehouseAdMetrics = {
  rows: WarehouseAdMetric[];
  /**
   * The first day the rows cover — the lead floor (see leadFloor). It is
   * usually LATER than the report's own window start, so the caller has to
   * say so on the page: the KPI band above the cards is summed from the
   * ad-set tab over the whole window and would otherwise be compared against
   * a card grid that silently starts weeks later. "" when there are no rows.
   */
  from: string;
};

type MetaAction = { action_type?: string | null; value?: number | string | null };

type InsightRow = {
  ad_id: string | null;
  date: string | null;
  ad_name: string | null;
  account_id: string | null;
  campaign_name: string | null;
  spend: number | string | null;
  impressions: number | string | null;
  clicks: number | string | null;
  /** Meta's raw action list for the day. The lead count is read from HERE —
   *  see leadsOf — not from the table's own leads_* columns. */
  actions: MetaAction[] | null;
  synced_at: string | null;
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * THE lead count for a day of an ad: Meta's own `lead` action.
 *
 * NOT `leads_website + leads_onfacebook`, and not `conversions`. Those
 * columns count the same lead under every action type Meta reports it as, so
 * they come out at roughly DOUBLE — measured 2026-09-22 over 878 campaign-
 * days since 09-01: a website lead is counted as both `lead` and
 * `offsite_conversion.fb_pixel_lead`, an on-Facebook one as both `lead` and
 * `onsite_conversion.lead_grouped`. Against the ad-set tab (the same figure
 * the KPI row shows), `lead` matched on 162 of 180 September campaign-days
 * while the columns matched 93 — and on 2026-08-19/20/23, three days taken at
 * random, `lead` gave 79/81/80 against the tab's 79/81/80.
 *
 * The residual disagreement is definitional, not a bug: the Supermetrics
 * query reports on CONVERSION time (`ACTION_REPORT_TIME_conversion`) and the
 * sync takes Meta's default, so a lead can land on a different day either
 * side. Over a window it washes out; over one day it need not.
 */
function leadsOf(actions: MetaAction[] | null): number {
  if (!Array.isArray(actions)) return 0;
  let n = 0;
  for (const a of actions) if (a?.action_type === "lead") n += num(a.value);
  return n;
}

/** Israel-local today, YYYY-MM-DD — the same clock the rest of the hub
 *  counts days on, so the lookback floor doesn't shift with the server's. */
function todayIsrael(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function lookbackFloor(): string {
  const d = new Date(`${todayIsrael()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - LOOKBACK_DAYS);
  return d.toISOString().slice(0, 10);
}

/** A day is covered once ACTION_COVERAGE of the days from there on carry
 *  action data. Short of 1 on purpose: a real day can pass with no action of
 *  any kind on a small project, and the sync's own last two or three days are
 *  still filling in. */
const ACTION_COVERAGE = 0.8;

/**
 * The first day of this project's rows from which lead numbers can be
 * believed — everything before it is dropped.
 *
 * The sync only started storing Meta's action list part-way through its life:
 * measured over the whole table on 2026-09-22, the share of rows carrying
 * leads runs 0% through April, 2% in May, 5% in June, 15% in July, 77% in
 * August and 98% in September, with the step change on 2026-08-09. Rows older
 * than that carry spend, impressions and clicks but nothing about leads, and
 * serving them would draw a year of cost with a zero beside it — which does
 * not read as "unknown", it reads as "we spent this and got nothing", on the
 * cards, in the CPL that picks the winner, and in every month of the history
 * panel.
 *
 * Measured per project rather than from a date written into the code, so the
 * span grows by itself when the sync backfills, and so a project whose own
 * account was covered earlier keeps its longer history (eastern's rows carry
 * actions from 2026-07-06, and every one of its 79 days since then matches
 * the ad-set tab's lead count exactly).
 *
 * The coverage test, rather than simply the earliest day with an action, is
 * what stops ONE stray early row from dragging the floor back over months
 * that have no lead data at all. Counted over days with spend: a day nobody
 * spent on says nothing about coverage either way.
 */
function leadFloor(rows: readonly InsightRow[]): string {
  const byDay = new Map<string, { spend: boolean; actions: boolean }>();
  for (const r of rows) {
    const d = String(r.date ?? "").slice(0, 10);
    if (!d) continue;
    const cur = byDay.get(d) ?? { spend: false, actions: false };
    if (num(r.spend) > 0) cur.spend = true;
    if (Array.isArray(r.actions) && r.actions.length) cur.actions = true;
    byDay.set(d, cur);
  }
  const days = [...byDay.keys()].sort();
  let spendDays = 0;
  let coveredDays = 0;
  let floor = "";
  // Walk backwards: at each day, (covered / spending) is the coverage of the
  // whole span from that day to the newest. The earliest day that clears the
  // bar — and has action data of its own — is the floor.
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    const day = byDay.get(d)!;
    if (day.spend) spendDays++;
    if (day.spend && day.actions) coveredDays++;
    if (!day.actions) continue;
    if (spendDays === 0 || coveredDays / spendDays >= ACTION_COVERAGE) floor = d;
  }
  return floor;
}

/**
 * Paged read with a clock. Deliberately NOT supabaseRowsAll: that one retries
 * a failed page five times with backoff, which is right for an export that
 * must not come back short and wrong here — a page that timed out means the
 * table is busy, and retrying it four more times inside a page render only
 * makes the user wait longer for the same nothing.
 *
 * Returns whatever whole pages it got. A short read is safe for every use the
 * caller makes of it: the rows are newest-first, so a cut-off costs the
 * oldest history, and the lead floor is computed from what came back.
 */
async function readPages(path: string): Promise<InsightRow[]> {
  const out: InsightRow[] = [];
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  for (let start = 0; start < MAX_ROWS; start += PAGE_SIZE) {
    const left = deadline - Date.now();
    if (left <= 0) {
      console.warn(
        `[getWarehouseAdMetrics] out of time after ${out.length} rows — serving what arrived`,
      );
      break;
    }
    let page: InsightRow[];
    try {
      const res = await supabaseFetch(path, {
        extraHeaders: { Range: `${start}-${start + PAGE_SIZE - 1}` },
        signal: AbortSignal.timeout(Math.min(PAGE_TIMEOUT_MS, left)),
      });
      if (!res.ok) {
        console.warn(
          `[getWarehouseAdMetrics] HTTP ${res.status} after ${out.length} rows: ${(await res.text()).slice(0, 160)}`,
        );
        break;
      }
      const j = await res.json();
      page = Array.isArray(j) ? (j as InsightRow[]) : [];
    } catch (e) {
      console.warn(
        `[getWarehouseAdMetrics] page at ${start} failed after ${out.length} rows: ${e instanceof Error ? e.message : String(e)}`,
      );
      break;
    }
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * Daily per-ad rows for the given campaign NAMES, in the same shape the
 * metrics tab is parsed into.
 *
 * Campaign names arrive already project-matched (the caller takes them off
 * rows that passed `mine()`), so this does no slug matching of its own, and
 * the name it returns is the SHEET's spelling — the one every card key in
 * reportCreatives is built from. Matched with `orExactFilter`, which quotes
 * and escapes: these names carry commas, quotes and Hebrew, and dropping one
 * raw into a PostgREST list is exactly the kind of thing that fails silently
 * on one project and works on nineteen.
 */
export const getWarehouseAdMetrics = cache(
  async (campaignNames: readonly string[]): Promise<WarehouseAdMetrics> => {
    const empty: WarehouseAdMetrics = { rows: [], from: "" };
    if (!supabaseConfigured() || !campaignNames.length) return empty;
    try {
      const names = [...new Set(campaignNames.filter(Boolean))].slice(0, MAX_CAMPAIGNS);
      if (campaignNames.length > MAX_CAMPAIGNS) {
        console.warn(
          `[getWarehouseAdMetrics] ${campaignNames.length} campaigns capped at ${MAX_CAMPAIGNS} — the caller orders them newest-first, so the dropped ones are the oldest`,
        );
      }
      const rows = await readPages(
        `meta_ad_insights_daily?select=ad_id,date,ad_name,account_id,campaign_name,` +
          `spend,impressions,clicks,actions,synced_at` +
          `&or=(${orExactFilter("campaign_name", names)})` +
          // ALWAYS date-bounded: an unbounded ordered read of this table is
          // slow enough to hit the statement timeout (measured 2026-09-22).
          `&date=gte.${lookbackFloor()}` +
          // And ALWAYS ordered, on a unique key — (date, ad_id) is unique in
          // this table. PostgREST pages by offset, so an unordered read
          // returns rows twice and misses others: the same August read came
          // back with 725 duplicated rows, 725 missing ones and ₪18,296
          // (3.4%) of phantom spend.
          //
          // NEWEST FIRST, because the read can be cut off at MAX_ROWS and the
          // cut has to fall on the history nobody is looking at. Ordered by
          // ad_id it fell on the highest ad ids — Meta issues them in
          // ascending order, so a truncated read would have dropped exactly
          // the ads running right now.
          `&order=date.desc,ad_id.asc`,
      );
      if (rows.length >= MAX_ROWS) {
        console.warn(
          `[getWarehouseAdMetrics] hit the ${MAX_ROWS}-row cap for ${names.length} campaign(s) — the oldest days are missing from the card history`,
        );
      }

      // One row per (ad, day). The table holds exactly that today — all
      // 183,599 rows are distinct on (ad_id, date) — so this is a guard, not
      // a repair: if a re-sync ever does leave two rows for a day, summing
      // them would silently inflate the ad's cost. Newest sync wins.
      const byKey = new Map<string, { row: InsightRow; synced: string }>();
      for (const r of rows) {
        const date = String(r.date ?? "").slice(0, 10);
        const ad = String(r.ad_name ?? "").trim();
        const campaign = String(r.campaign_name ?? "").trim();
        if (!date || !ad || !campaign) continue;
        const k = `${r.ad_id ?? ad}|${date}`;
        const synced = String(r.synced_at ?? "");
        const cur = byKey.get(k);
        if (!cur || synced > cur.synced) byKey.set(k, { row: r, synced });
      }

      const floor = leadFloor([...byKey.values()].map((v) => v.row));
      if (!floor) return empty;

      const out: WarehouseAdMetric[] = [];
      for (const { row: r } of byKey.values()) {
        const date = String(r.date ?? "").slice(0, 10);
        if (date < floor) continue;
        out.push({
          date,
          accountId: String(r.account_id ?? "").trim(),
          campaign: String(r.campaign_name ?? "").trim(),
          ad: String(r.ad_name ?? "").trim(),
          impressions: num(r.impressions),
          clicks: num(r.clicks),
          cost: num(r.spend),
          leads: leadsOf(r.actions),
        });
      }
      return { rows: out, from: floor };
    } catch (e) {
      // A fallback that throws is worse than no fallback: the caller is
      // already in the degraded path, and an empty tab is survivable while a
      // 500 on the whole קריאייטיבים tab is not.
      console.warn(
        `[getWarehouseAdMetrics] failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return empty;
    }
  },
);
