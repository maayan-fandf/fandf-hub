import { cache } from "react";
import { unstable_cache } from "next/cache";
import { graphEdge, metaConfigured, MetaGraphError } from "@/lib/metaGraph";

/**
 * Per-ad DAILY numbers read straight from Meta — the first stand-in for the
 * `facebook-ads-metrics` Supermetrics tab when it comes back empty.
 *
 * The hub has had a direct Meta connection since the ad-preview cron, but it
 * only ever fetched links, targeting and "which ads went up this week"; every
 * NUMBER on the קמפיינים tab came from Supermetrics. It does not have to:
 * `act_<id>/insights` at `level=ad, time_increment=1` returns exactly the
 * columns that tab carried, from the account Meta itself keeps.
 *
 * Measured on eastern, 2026-09-01..22 (2026-09-22), against the ad-set tab
 * that feeds the headline band:
 *   Meta direct   ₪9,349 · 74 leads · 99,523 impressions · 1,955 clicks
 *   ad-set tab    ₪9,333 · 74 leads
 *   warehouse     ₪9,283 · 73 leads
 * It also carries the lead history the warehouse simply does not have — the
 * sync only started storing Meta's action list on 2026-08-09, while Meta
 * answers for any month asked.
 *
 * WHAT IT COSTS, and why the shape of this file is what it is. The call is
 * neither cheap nor unlimited: an unfiltered account pull for 22 days came
 * back in 3 pages and 14s, and probing it hard enough earned an app-level
 * `(#4) Application request limit reached` within the hour. So:
 *   • the query is narrowed to the project's own campaigns before it is sent
 *     (`filtering` CONTAIN on campaign.name), not filtered after;
 *   • it is windowed to the report's own period, never a rolling year;
 *   • the result is cached for 30 minutes across requests, keyed by account,
 *     pattern and window, so projects sharing an ad account share one fetch;
 *   • a rate limit or a timeout is reported, not thrown, so the caller can
 *     fall back to the warehouse instead of losing the cards.
 */

const CACHE_TAG = "metaAdMetrics";
const TTL_SECONDS = 1800; // 30 min — the tab it replaces refreshed daily.

/** Rows per page. Meta caps what it feels like capping; this is a request. */
const PAGE_LIMIT = 1000;

/** Pages per (account, pattern). 1,000 ad-days is ~30 ads over a month. */
const MAX_PAGES = 8;

/** Whole-call budget. This runs inside a project page's render. */
const BUDGET_MS = 25000;

export type MetaAdMetric = {
  /** YYYY-MM-DD */
  date: string;
  accountId: string;
  campaign: string;
  ad: string;
  impressions: number;
  clicks: number;
  cost: number;
  leads: number;
};

export type MetaAdMetrics = {
  rows: MetaAdMetric[];
  /** false when Meta could not answer — rate limit, dead token, timeout. The
   *  caller then tries the warehouse rather than presenting "no ads". */
  ok: boolean;
  reason?: string;
};

type InsightRow = {
  date_start?: string;
  ad_id?: string;
  ad_name?: string;
  campaign_name?: string;
  account_id?: string;
  spend?: string | number;
  impressions?: string | number;
  clicks?: string | number;
  actions?: { action_type?: string; value?: string | number }[];
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Leads for the day: Meta's `lead` action.
 *
 * The same definition the ad-set tab's Website leads + On-Facebook leads add
 * up to, and deliberately NOT a sum of the per-surface action types — a
 * website lead is reported as both `lead` and
 * `offsite_conversion.fb_pixel_lead`, an on-Facebook one as both `lead` and
 * `onsite_conversion.lead_grouped`, so adding those doubles every count.
 */
function leadsOf(actions: InsightRow["actions"]): number {
  if (!Array.isArray(actions)) return 0;
  let n = 0;
  for (const a of actions) if (a?.action_type === "lead") n += num(a.value);
  return n;
}

const FIELDS =
  "ad_id,ad_name,campaign_name,account_id,spend,impressions,clicks,actions";

async function fetchMetaAdMetrics(
  accountIds: readonly string[],
  patterns: readonly string[],
  from: string,
  to: string,
): Promise<MetaAdMetrics> {
  if (!metaConfigured()) return { rows: [], ok: false, reason: "not-configured" };
  if (!accountIds.length || !patterns.length || !from || !to) {
    return { rows: [], ok: false, reason: "no-target" };
  }
  const deadline = Date.now() + BUDGET_MS;
  // (ad, day) → row. Two patterns of the same project can match one campaign
  // ("peleg" and "peleg-yehud"), and the same ad-day must not be counted
  // twice into a card's cost.
  const byKey = new Map<string, MetaAdMetric>();
  let asked = 0;
  for (const accountId of accountIds) {
    for (const pattern of patterns) {
      if (Date.now() > deadline) {
        return {
          rows: [...byKey.values()],
          ok: false,
          reason: `budget: stopped after ${asked} request(s)`,
        };
      }
      asked++;
      let rows: InsightRow[];
      try {
        rows = await graphEdge<InsightRow>(
          `act_${accountId}/insights`,
          {
            level: "ad",
            time_increment: 1,
            time_range: JSON.stringify({ since: from, until: to }),
            fields: FIELDS,
            limit: PAGE_LIMIT,
            // Narrow BEFORE the wire: an account carries every project it
            // runs, and pulling all of them to keep one is what runs into
            // Meta's request limit.
            filtering: JSON.stringify([
              { field: "campaign.name", operator: "CONTAIN", value: pattern },
            ]),
          },
          { maxPages: MAX_PAGES },
        );
      } catch (e) {
        const code = e instanceof MetaGraphError ? e.code : undefined;
        // 4 / 17 / 613 are the request-limit family, 190 a dead token. None
        // of them is worth trying the next account for.
        console.warn(
          `[getMetaAdMetrics] act_${accountId} "${pattern}" failed${code ? ` (code ${code})` : ""}: ${e instanceof Error ? e.message : String(e)}`,
        );
        return {
          rows: [...byKey.values()],
          ok: false,
          reason: code === 4 || code === 17 || code === 613 ? "rate-limit" : "error",
        };
      }
      for (const r of rows) {
        const date = String(r.date_start ?? "").slice(0, 10);
        const ad = String(r.ad_name ?? "").trim();
        const campaign = String(r.campaign_name ?? "").trim();
        if (!date || !ad || !campaign) continue;
        byKey.set(`${r.ad_id ?? ad}|${date}`, {
          date,
          accountId: String(r.account_id ?? accountId).trim(),
          campaign,
          ad,
          impressions: num(r.impressions),
          clicks: num(r.clicks),
          cost: num(r.spend),
          leads: leadsOf(r.actions),
        });
      }
    }
  }
  return { rows: [...byKey.values()], ok: true };
}

const fetchCrossRequest = unstable_cache(fetchMetaAdMetrics, ["metaAdMetrics"], {
  revalidate: TTL_SECONDS,
  tags: [CACHE_TAG],
});

/**
 * Daily per-ad rows for the campaigns matching `patterns` in `accountIds`,
 * over [from, to] inclusive.
 *
 * `patterns` are the project's own `campaign ID` patterns from Keys — the
 * same substrings `matchSlug` uses — so Meta does the narrowing. The caller
 * still runs every row back through `matchSlug`: CONTAIN is a substring test
 * and the longest-pattern-wins rule lives on our side, so a campaign that
 * contains "peleg" but belongs to peleg-yehud_business must not be credited
 * here.
 */
export const getMetaAdMetrics = cache(
  async (
    accountIds: readonly string[],
    patterns: readonly string[],
    from: string,
    to: string,
  ): Promise<MetaAdMetrics> =>
    fetchCrossRequest([...accountIds].sort(), [...patterns].sort(), from, to),
);
