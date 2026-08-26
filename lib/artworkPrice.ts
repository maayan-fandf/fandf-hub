import { cache } from "react";
import { getLiveAdIds } from "@/lib/metaLiveAds";
import { readCreativeTags } from "@/lib/creativePriceTags";
import { supabaseConfigured, supabaseRows } from "@/lib/supabase";

/**
 * The advertised price read off the CREATIVE ITSELF.
 *
 * Every other price surface reads text — the landing page, Yad2, Google
 * headlines, Facebook ad copy. Real-estate creatives routinely put the
 * price in the image instead, and those are the ones most likely to go
 * stale unnoticed: the landing page gets updated and the artwork keeps
 * running with the old number.
 *
 * אנדה is the case that forced this. Its live ad 2026-08-18A has no price
 * in its copy at all — the card read "לא זוהה מחיר" for Facebook while the
 * artwork said "החל מ-3,250,000 ₪ בלבד" and the ad was actively spending.
 * The only אנדה creatives carrying a price in text were two June ones at
 * ₪2,420,000, both long paused, so a text-only read was blind toward the
 * OLDER number.
 *
 * The value comes from the warehouse tagger's vision pass
 * (`price_on_image_value`, shipped 2026-08-24), not from anything here. We
 * do not re-read images: that job already fetches them nightly with a
 * vision model, and duplicating it would mean two extractors disagreeing.
 *
 * THREE THINGS THIS HAS TO GET RIGHT, each learned the hard way:
 *
 *  - Join through creative_group, never ad_id. Tags are stored one per
 *    creative group, not one per ad. אנדה's group has four ads and one tag
 *    row; joining on ad_id returns nulls for the other three and the card
 *    reports "no price" for live ads that have one.
 *
 *  - Only count LIVE ads (lib/metaLiveAds.ts). An artwork price from a
 *    paused ad is exactly the stale number this feature exists to catch.
 *
 *  - null is not zero. `price_value_checked_at` distinguishes "not looked
 *    at yet" from "looked and could not read it", so a missing price during
 *    the backfill does not masquerade as an answer.
 */

export type ArtworkPrice = {
  /** Lowest artwork price across the project's live creatives, in NIS.
   *  Lowest because this feeds a "החל מ-" headline when nothing else on
   *  the card produced one. */
  value: number;
  /** The literal string the tagger matched, for display / audit. */
  raw: string;
  /** EVERY distinct price found on the live creatives, highest first —
   *  one entry per value, carrying the first raw string that produced it.
   *
   *  A single "lowest" is the right answer for a headline but the wrong
   *  one for a comparison: creatives carry payment terms and deposits
   *  alongside unit prices (marom-rishon's live artwork reads
   *  "משלמים 1,000,000₪ רק ב-2030"), and collapsing to the minimum would
   *  present one of those as THE artwork price next to a real one. In
   *  practice the live filter leaves one value on almost every project —
   *  the noise tends to sit on paused ads — so listing them costs nothing
   *  and never invents a pick. */
  all: { value: number; raw: string }[];
  /** How many live ads' creatives carried a readable price. */
  ads: number;
  /** True when some live creatives are still awaiting the vision pass, so
   *  the caller can say the number may not yet be the lowest. */
  pending: boolean;
  /** Whether liveness came from real ad status or the spend proxy. */
  basis: "status" | "spend";
};

type CreativeRow = { ad_id: string; creative_group: string | null };
export const getArtworkPrice = cache(
  async (
    subjectEmail: string,
    projectName: string,
  ): Promise<ArtworkPrice | null> => {
    if (!supabaseConfigured() || !projectName) return null;
    try {
      const live = await getLiveAdIds(subjectEmail, projectName);
      if (!live || !live.adIds.size) return null;

      const ids = [...live.adIds].slice(0, 300);
      const creatives = await supabaseRows<CreativeRow>(
        `meta_ad_creatives?select=ad_id,creative_group&ad_id=in.(${ids.join(",")})`,
      );
      const groups = new Set<string>();
      const groupOf = new Map<string, string>();
      for (const c of creatives) {
        if (!c.ad_id || !c.creative_group) continue;
        groupOf.set(String(c.ad_id), String(c.creative_group));
        groups.add(String(c.creative_group));
      }
      if (!groups.size) return null;

      // Shared with getArtworkPriceFlag — see readCreativeTags for why the
      // table is pulled whole and why the two read it together.
      const tags = await readCreativeTags();

      let best: { value: number; raw: string } | null = null;
      let ads = 0;
      let pending = false;
      const seenGroup = new Set<string>();
      /** value → first raw string seen for it. Keyed by value so two
       *  creatives advertising the same number collapse to one entry. */
      const allByValue = new Map<number, string>();

      for (const t of tags) {
        const g = String(t.creative_group || "");
        if (!g || !groups.has(g) || seenGroup.has(g)) continue;
        seenGroup.add(g);

        const value = t.price_on_image_value == null ? null : Number(t.price_on_image_value);
        if (value == null || !Number.isFinite(value) || value <= 0) {
          // A creative the tagger says HAS a price but has not valued yet
          // is a real gap, not an absence — say so rather than quietly
          // publishing a higher minimum from the ones it has done.
          if (t.price_on_image && !t.price_value_checked_at) pending = true;
          continue;
        }
        // How many live ads this group covers — the group is the tagged
        // unit, but the ad is what the reader thinks in.
        for (const [adId, grp] of groupOf) {
          if (grp === g && live.adIds.has(adId)) ads++;
        }
        const raw = String(t.price_on_image_raw || "");
        if (!allByValue.has(value)) allByValue.set(value, raw);
        if (!best || value < best.value) {
          best = { value, raw };
        }
      }

      if (!best) return null;
      const all = [...allByValue.entries()]
        .map(([value, raw]) => ({ value, raw }))
        .sort((a, b) => b.value - a.value);
      return { value: best.value, raw: best.raw, all, ads, pending, basis: live.basis };
    } catch (e) {
      console.warn(
        `[getArtworkPrice] failed for "${projectName}": ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  },
);
