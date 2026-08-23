import { cache } from "react";
import { buildMatchMap, getProjectSlug, matchSlug } from "@/lib/campaignMatch";
import {
  supabaseConfigured,
  supabaseRows,
  supabaseRowsAll,
} from "@/lib/supabase";

/**
 * "Is this project running artwork with a price burned into it?"
 *
 * The מחירים מפורסמים card compares advertised prices across the landing
 * page, Yad2, Google and Facebook — but every one of those surfaces is
 * read from TEXT. Real-estate creatives routinely put the price in the
 * image instead ("החל מ-3,199,000 ₪" rendered into the JPG), and those are
 * exactly the ones that go stale unnoticed: the landing page gets updated,
 * the artwork keeps running with last quarter's number, and nothing in the
 * comparison can see it.
 *
 * The warehouse's creative tagger runs a vision model over each creative
 * and records `price_on_image`. That is a BOOLEAN — it knows a price is
 * shown, not which one — so this cannot participate in the price
 * comparison. It can only raise a hand: "someone should look at the
 * artwork for this project". Treat the output accordingly; the moment the
 * tagger starts recording the value (asked for 2026-08-20) this can become
 * a real fifth surface instead of a warning.
 *
 * Deliberately conservative about what it claims:
 *  - `tagged` vs `adsChecked` is reported so the UI can say how much of the
 *    project it actually looked at. Tag coverage is good where the tagger
 *    can reach — 345 of the 347 creative groups that spent in the last 90
 *    days are tagged — but 268 of 1,606 spending ads have no creative row
 *    at all, so they never reach it. A flag that silently skipped those
 *    would read as "nothing wrong here".
 *  - null (not zero) when Supabase is unreachable or the project has no
 *    campaign pattern, so the caller renders nothing rather than an
 *    all-clear it did not earn.
 */

/** Ads that spent inside this window are the ones worth flagging — an
 *  artwork price only misleads while it is being served. */
const WINDOW_DAYS = 60;

/** URL length guard on the `ad_id=in.(…)` filter. Well above any single
 *  project's live ad count; truncation is reported via `adsChecked`. */
const MAX_ADS = 300;

export type ArtworkPriceFlag = {
  /** Distinct ads of this project that spent inside the window. */
  adsChecked: number;
  /** How many of those the tagger has actually looked at. */
  tagged: number;
  /** …of which show a price in the image itself. */
  withPrice: number;
};

type InsightRow = { ad_id: string; campaign_name: string };
type TagRow = { creative_group: string | null; price_on_image: boolean | null };
type CreativeRow = { ad_id: string; creative_group: string | null };

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

export const getArtworkPriceFlag = cache(
  async (
    subjectEmail: string,
    projectName: string,
  ): Promise<ArtworkPriceFlag | null> => {
    if (!supabaseConfigured() || !projectName) return null;
    try {
      const slug = await getProjectSlug(subjectEmail, projectName);
      if (!slug) return null;

      // Narrow server-side by the project's own pattern so the result set
      // stays small, then re-check each campaign through the hub's OWN
      // matcher. The `ilike` is a prefilter, not the decision: patterns
      // nest ("peleg" inside "peleg-yehud_business"), and letting the
      // substring decide would attribute another project's campaign to
      // this one.
      const rows = await supabaseRows<InsightRow>(
        `meta_ad_insights_daily?select=ad_id,campaign_name` +
          `&campaign_name=ilike.*${encodeURIComponent(slug)}*` +
          `&date=gte.${isoDaysAgo(WINDOW_DAYS)}&spend=gt.0`,
      );
      if (!rows.length) return null;

      const matchMap = await buildMatchMap(subjectEmail);
      const adIds = new Set<string>();
      for (const r of rows) {
        if (!r.ad_id) continue;
        if (matchSlug(r.campaign_name || "", matchMap) !== slug) continue;
        adIds.add(String(r.ad_id));
      }
      if (!adIds.size) return null;

      const ids = [...adIds].slice(0, MAX_ADS);

      // The tagger works at CREATIVE-GROUP grain, not ad grain — one tag
      // covers every ad running the same creative. Joining tags on ad_id
      // therefore counts only the handful of ads that happen to own a tag
      // row and reports the rest as untagged: קנקו measured 4 of 30 that
      // way when the real answer is 30 of 30. Map ad → creative_group
      // first, then look the tag up by group.
      const creatives = await supabaseRows<CreativeRow>(
        `meta_ad_creatives?select=ad_id,creative_group&ad_id=in.(${ids.join(",")})`,
      );
      const groupOf = new Map<string, string>();
      for (const c of creatives) {
        if (c.ad_id && c.creative_group) {
          groupOf.set(String(c.ad_id), String(c.creative_group));
        }
      }
      if (!groupOf.size) return null;

      // Fetched whole rather than filtered by group: creative_group is
      // `campaign_id::ad_name`, and ad names carry Hebrew, commas and
      // quotes that would have to be escaped into a PostgREST `in.(…)`
      // list. The table is ~1.1k rows, so pulling it and joining in memory
      // is both cheaper to reason about and immune to that escaping.
      const tags = await supabaseRowsAll<TagRow>(
        `meta_creative_tags?select=creative_group,price_on_image`,
        { maxRows: 20000 },
      );
      const byGroup = new Map<string, boolean>();
      for (const t of tags) {
        if (t.price_on_image == null || !t.creative_group) continue;
        const g = String(t.creative_group);
        // True wins: a single confirmed sighting shouldn't be diluted by a
        // sibling row the model read as false.
        byGroup.set(g, (byGroup.get(g) || false) || !!t.price_on_image);
      }

      const verdict = new Map<string, boolean>();
      for (const adId of adIds) {
        const g = groupOf.get(adId);
        if (!g || !byGroup.has(g)) continue;
        verdict.set(adId, !!byGroup.get(g));
      }

      return {
        adsChecked: adIds.size,
        tagged: verdict.size,
        withPrice: [...verdict.values()].filter(Boolean).length,
      };
    } catch (e) {
      console.warn(
        `[getArtworkPriceFlag] failed for "${projectName}": ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  },
);
