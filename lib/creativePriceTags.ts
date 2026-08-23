import { cache } from "react";
import { buildMatchMap, getProjectSlug, matchSlug } from "@/lib/campaignMatch";
import { supabaseConfigured, supabaseRows } from "@/lib/supabase";

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
 *    project it actually looked at. Coverage is currently ~21% of live ads
 *    warehouse-wide, and a flag that silently covers a fifth of creatives
 *    would otherwise read as "nothing wrong here".
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
type TagRow = { ad_id: string; price_on_image: boolean | null };

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
      const tags = await supabaseRows<TagRow>(
        `meta_creative_tags?select=ad_id,price_on_image` +
          `&ad_id=in.(${ids.join(",")})`,
      );

      // One ad can carry several tag rows (the tagger keys on creative
      // group, and variants share ids) — collapse to one verdict per ad,
      // true wins, so a single confirmed sighting isn't diluted by a
      // sibling row the model read as false.
      const verdict = new Map<string, boolean>();
      for (const t of tags) {
        if (t.price_on_image == null) continue;
        const id = String(t.ad_id);
        verdict.set(id, (verdict.get(id) || false) || !!t.price_on_image);
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
