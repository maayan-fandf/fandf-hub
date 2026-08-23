import { cache } from "react";
import { buildMatchMap, getProjectSlug, matchSlug } from "@/lib/campaignMatch";
import { extractPrices, startingPrice } from "@/lib/priceExtractor";
import { supabaseConfigured, supabaseRows } from "@/lib/supabase";
import type { DetectedPriceShape } from "@/lib/appsScript";

/**
 * The Facebook advertised price, read from the Supabase warehouse instead
 * of the Apps Script report.
 *
 * WHY THIS EXISTS. The FB card gets its price from Apps Script, which
 * reads ad copy out of a Supermetrics sheet tab. That path is dead: the
 * deployed script still looks for `facebook-ads-assets links`, a tab
 * retired 2026-08-17, so `getSheetByNameLoose_` returns null and the whole
 * branch produces nothing — silently, for every project. The card has read
 * "אין קמפיינים פעילים ב-FB" ever since, even for projects whose ad copy
 * literally says "החל מ-3,199,000 ₪".
 *
 * The same creative text is in the warehouse, and the price extractor this
 * uses (lib/priceExtractor.ts) is the SAME one the landing/Yad2 surfaces
 * are compared against — the Apps Script copy is a port of it, not the
 * other way round. So this is not a second opinion with different rules;
 * it is the canonical extractor pointed at a source we can actually read.
 *
 * DELIBERATELY A FALLBACK. The caller uses this only when Apps Script
 * produced no FB price. When that path is fixed it wins again, and the two
 * should agree — anything else is a bug worth seeing rather than papering
 * over.
 *
 * LIVENESS. The Apps Script rule is ACTIVE-only, on purpose: a paused
 * March campaign once leaked ₪3.77M onto a card whose live June ads
 * carried no price at all. The warehouse has no ad-status column (it is
 * on the list for Nadav), so recent SPEND stands in for "currently
 * serving". The window is deliberately short, and it accounts for the
 * sync's T−4 lag: 10 days of dates is roughly 6 days of actual delivery.
 * Reaching further back would re-create exactly the leak the ACTIVE-only
 * rule was written to stop.
 *
 * COVERAGE. Supabase carries 18 of the 21 ad accounts; SHBN, TLV
 * Municipality and Three On The Park have no rows at all, so their
 * projects get null here and keep whatever the Sheet gives them.
 */

/** Spend window standing in for "the ad is running". See LIVENESS above. */
const LIVE_WINDOW_DAYS = 10;

/** Ceiling on the `ad_id=in.(…)` filter length. */
const MAX_ADS = 300;

export type WarehouseFbPrice = {
  /** Headline pick — lowest anchored price, same rule as every other
   *  surface. Null when creative text existed but carried no price. */
  price: number | null;
  /** Every distinct advertised price found, for the per-room rows the
   *  card already knows how to render. */
  inventory: DetectedPriceShape[];
  /** Ads that spent inside the window (the denominator). */
  adsChecked: number;
  /** …of which had any creative text to read at all. */
  adsWithText: number;
};

type InsightRow = { ad_id: string; campaign_name: string };
type CreativeRow = { ad_id: string; title: string | null; body: string | null };

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

export const getWarehouseFbPrice = cache(
  async (
    subjectEmail: string,
    projectName: string,
  ): Promise<WarehouseFbPrice | null> => {
    if (!supabaseConfigured() || !projectName) return null;
    try {
      const slug = await getProjectSlug(subjectEmail, projectName);
      if (!slug) return null;

      // `ilike` narrows the fetch; matchSlug decides. Patterns nest
      // ("peleg" inside "peleg-yehud_business"), so trusting the substring
      // would publish another project's price on this card.
      const rows = await supabaseRows<InsightRow>(
        `meta_ad_insights_daily?select=ad_id,campaign_name` +
          `&campaign_name=ilike.*${encodeURIComponent(slug)}*` +
          `&date=gte.${isoDaysAgo(LIVE_WINDOW_DAYS)}&spend=gt.0`,
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
      const creatives = await supabaseRows<CreativeRow>(
        `meta_ad_creatives?select=ad_id,title,body&ad_id=in.(${ids.join(",")})`,
      );
      if (!creatives.length) return null;

      // One string per AD, not one for the whole project: a price and the
      // room label that belongs to it have to stay in the same ~120-char
      // window for extractPrices to pair them. Concatenating every ad's
      // copy first would let one ad's "4 חד׳" label another ad's price.
      const seen = new Set<string>();
      let adsWithText = 0;
      const inventory: DetectedPriceShape[] = [];
      const byValue = new Map<number, DetectedPriceShape>();
      const headlines: number[] = [];

      for (const c of creatives) {
        const text = [c.title || "", c.body || ""].filter(Boolean).join(" · ");
        if (!text.trim()) continue;
        // Count the AD, then dedupe only the extraction work. Variants of
        // one creative share their copy verbatim, so counting distinct
        // strings would report "1 ad" for a project running four.
        adsWithText++;
        if (seen.has(text)) continue;
        seen.add(text);

        const head = startingPrice(text);
        if (head) headlines.push(head.value);

        for (const p of extractPrices(text)) {
          const cur = byValue.get(p.value);
          if (cur) {
            // Anchor signal sticks, matching the extractor's own dedup.
            if (p.anchored && !cur.anchored) cur.anchored = true;
            if (!cur.roomsLabel && p.roomsLabel) {
              cur.rooms = p.rooms ?? null;
              cur.roomsLabel = p.roomsLabel;
            }
            continue;
          }
          const shape: DetectedPriceShape = {
            value: p.value,
            anchored: !!p.anchored,
            rooms: p.rooms ?? null,
            roomsLabel: p.roomsLabel || "",
          };
          byValue.set(p.value, shape);
          inventory.push(shape);
        }
      }

      if (!adsWithText) return null;
      inventory.sort((a, b) => a.value - b.value);

      return {
        price: headlines.length ? Math.min(...headlines) : null,
        inventory,
        adsChecked: adIds.size,
        adsWithText,
      };
    } catch (e) {
      console.warn(
        `[getWarehouseFbPrice] failed for "${projectName}": ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  },
);
