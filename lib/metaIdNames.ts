import { cache } from "react";
import { unstable_cache } from "next/cache";
import { supabaseConfigured, supabaseFetch } from "@/lib/supabase";

/**
 * Numeric Meta ids from a lead's UTM → the campaign / ad NAMES the report
 * keys on.
 *
 * WHY. A Facebook lead joins its creative on `utm_campaign` + `utm_content`,
 * and lib/fbCreativeMeetingsExport rejects any value that is a bare numeric
 * id — a name is what every other side of the join carries. But a chunk of
 * the portfolio tags the ID: measured 2026-09-22 over the 4,451 BMBY
 * Facebook leads since 2026-06-01, 383 (8.6%) carry an id rather than a
 * name, and they were being dropped from every per-creative, per-audience
 * and per-campaign figure on the קמפיינים tab. It is concentrated, not
 * spread: נתיבות 212 of its 305 leads (70%), רובע איילון 65, ניר צבי 33,
 * נתניה 29.
 *
 * The hub already does exactly this translation for Google — a numeric
 * `utm_campaign` becomes a campaign name through the workbook's
 * `קמפיין ID גוגל` tab (gCampName in fbCreativeMeetingsExport). This is the
 * Facebook half, sourced from the warehouse's own Meta sync rather than a
 * sheet.
 *
 * AD IDS CARRY THEIR CAMPAIGN. `meta_ad_insights_daily` holds ad_id,
 * ad_name, campaign_id and campaign_name on one row, so resolving the ad id
 * also names the campaign it ran in. That matters: of the ids seen in those
 * leads, 73 of 73 AD ids resolved while only 5 of 16 campaign ids did (the
 * rest predate the table). Taking the campaign off the ad's row recovers the
 * pair even when the campaign id alone is unknown.
 *
 * Failure is silent and total by design: no warehouse, a timeout, a bad
 * response — the caller gets an empty map and those leads stay unattributed,
 * exactly as they were before this file existed.
 */

const CACHE_TAG = "metaIdNames";
/** Ids are effectively immutable; a rename is the only churn and it is rare. */
const TTL_SECONDS = 21600; // 6h

/** Ids per request. Numeric, ~18 chars, so this stays well inside any URL cap. */
const CHUNK = 60;

/** One request's clock. This runs inside the meetings join, which the project
 *  page awaits — a slow warehouse must cost the attribution, not the page. */
const CALL_MS = 8000;

/** How far back to look for a row naming the id. The sync holds ~16 months;
 *  an id older than this is unresolvable here and the lead stays dropped. */
const SINCE = "2025-06-01";

export type MetaIdNames = {
  /** campaign_id → campaign_name */
  campaigns: Record<string, string>;
  /** ad_id → { ad, campaign } */
  ads: Record<string, { ad: string; campaign: string }>;
};

const EMPTY: MetaIdNames = { campaigns: {}, ads: {} };

type Row = {
  ad_id?: string | null;
  ad_name?: string | null;
  campaign_id?: string | null;
  campaign_name?: string | null;
  date?: string | null;
};

const isNumericId = (s: string) => /^\d{8,}$/.test(s);

async function read(path: string): Promise<Row[]> {
  try {
    const res = await supabaseFetch(path, {
      extraHeaders: { Range: "0-999" },
      signal: AbortSignal.timeout(CALL_MS),
    });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j) ? (j as Row[]) : [];
  } catch {
    return [];
  }
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchMetaIdNames(ids: readonly string[]): Promise<MetaIdNames> {
  const wanted = [...new Set(ids.map((s) => String(s ?? "").trim()))].filter(isNumericId);
  if (!supabaseConfigured() || !wanted.length) return EMPTY;
  const out: MetaIdNames = { campaigns: {}, ads: {} };
  // The SAME id list is asked of both columns: a lead's utm_content is an ad
  // id and its utm_campaign a campaign id, but which of the two a given
  // value is is not knowable from the value, and asking both costs one more
  // request per chunk.
  for (const part of chunk(wanted, CHUNK)) {
    const list = part.join(",");
    const [byAd, byCamp] = await Promise.all([
      read(
        `meta_ad_insights_daily?select=ad_id,ad_name,campaign_name,date` +
          `&ad_id=in.(${list})&date=gte.${SINCE}&order=date.desc`,
      ),
      read(
        `meta_ad_insights_daily?select=campaign_id,campaign_name,date` +
          `&campaign_id=in.(${list})&date=gte.${SINCE}&order=date.desc`,
      ),
    ]);
    // Newest row first, so a renamed ad resolves to what it is called now.
    for (const r of byAd) {
      const id = String(r.ad_id ?? "");
      const ad = String(r.ad_name ?? "").trim();
      const campaign = String(r.campaign_name ?? "").trim();
      if (id && ad && !out.ads[id]) out.ads[id] = { ad, campaign };
    }
    for (const r of byCamp) {
      const id = String(r.campaign_id ?? "");
      const name = String(r.campaign_name ?? "").trim();
      if (id && name && !out.campaigns[id]) out.campaigns[id] = name;
    }
  }
  return out;
}

const fetchCrossRequest = unstable_cache(fetchMetaIdNames, ["metaIdNames"], {
  revalidate: TTL_SECONDS,
  tags: [CACHE_TAG],
});

/** Names for the given numeric ids. Non-numeric values are ignored, so a
 *  caller can hand it a raw UTM column without filtering first. */
export const getMetaIdNames = cache(
  async (ids: readonly string[]): Promise<MetaIdNames> =>
    fetchCrossRequest([...new Set(ids)].sort()),
);
