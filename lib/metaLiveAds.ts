import { cache } from "react";
import { buildMatchMap, getProjectSlug, matchSlug } from "@/lib/campaignMatch";
import { supabaseConfigured, supabaseRows } from "@/lib/supabase";

/**
 * "Which of this project's Meta ads are actually running right now?"
 *
 * Every price we read off Facebook depends on this question, and getting it
 * wrong is not a rounding error: a paused March campaign once put ₪3.77M on
 * a card whose live ads carried no price at all, and this hub published
 * אנדה's ₪2,420,000 off an ad that had been paused since June. The Apps
 * Script report answers it with an ACTIVE-only filter; this is the
 * warehouse's equivalent, in one place so both readers agree.
 *
 * Two bases, in order of preference:
 *
 *   status — meta_ad_status.effective_status === "ACTIVE". The real answer.
 *            effective_status rather than status because only it accounts
 *            for a paused parent campaign or ad set, which is exactly the
 *            ₪3.77M case.
 *
 *   spend  — ads that spent inside a short window. A stand-in, used only
 *            while meta_ad_status is empty (it shipped 2026-08-24 and
 *            backfills on the first nightly run). It is deliberately loose
 *            in the safe direction — short enough that a long-paused ad
 *            falls out — but an ad paused three days ago still spent inside
 *            it, so callers should treat a spend-based answer as weaker.
 *
 * The basis is returned rather than hidden, so a caller can decide whether
 * its own output deserves to override an authoritative source.
 */

/** Universe to consider before applying the liveness test. Wide, because
 *  the test does the narrowing. */
const LOOKBACK_DAYS = 60;

/** Spend-proxy window. See `spend` above — short on purpose. Accounts for
 *  the sync's lag, so ~10 days of dates is fewer days of real delivery. */
const SPEND_WINDOW_DAYS = 10;

/** Ceiling on the `ad_id=in.(…)` filter length. */
const MAX_ADS = 300;

export type LiveAds = {
  adIds: Set<string>;
  /** How liveness was decided — "status" is authoritative, "spend" is a
   *  proxy the caller should not let outrank a real answer. */
  basis: "status" | "spend";
};

type InsightRow = { ad_id: string; campaign_name: string; date: string };
type StatusRow = { ad_id: string; effective_status: string | null };

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

export const getLiveAdIds = cache(
  async (
    subjectEmail: string,
    projectName: string,
  ): Promise<LiveAds | null> => {
    if (!supabaseConfigured() || !projectName) return null;
    try {
      const slug = await getProjectSlug(subjectEmail, projectName);
      if (!slug) return null;

      // `ilike` narrows the fetch; matchSlug decides. Patterns nest
      // ("peleg" inside "peleg-yehud_business"), so trusting the substring
      // would hand this project another project's ads.
      const rows = await supabaseRows<InsightRow>(
        `meta_ad_insights_daily?select=ad_id,campaign_name,date` +
          `&campaign_name=ilike.*${encodeURIComponent(slug)}*` +
          `&date=gte.${isoDaysAgo(LOOKBACK_DAYS)}&spend=gt.0`,
      );
      if (!rows.length) return null;

      const matchMap = await buildMatchMap(subjectEmail);
      const mine = new Set<string>();
      const recent = new Set<string>();
      const spendCutoff = isoDaysAgo(SPEND_WINDOW_DAYS);
      for (const r of rows) {
        if (!r.ad_id) continue;
        if (matchSlug(r.campaign_name || "", matchMap) !== slug) continue;
        const id = String(r.ad_id);
        mine.add(id);
        if (String(r.date || "") >= spendCutoff) recent.add(id);
      }
      if (!mine.size) return null;

      // Preferred basis: ask what Meta says the ad's effective status is.
      const ids = [...mine].slice(0, MAX_ADS);
      const statuses = await supabaseRows<StatusRow>(
        `meta_ad_status?select=ad_id,effective_status&ad_id=in.(${ids.join(",")})`,
      );
      if (statuses.length) {
        const active = new Set<string>();
        for (const s of statuses) {
          if (String(s.effective_status || "").toUpperCase().trim() === "ACTIVE") {
            active.add(String(s.ad_id));
          }
        }
        return { adIds: active, basis: "status" };
      }

      // meta_ad_status has not been populated yet — fall back to the proxy.
      return { adIds: recent, basis: "spend" };
    } catch (e) {
      console.warn(
        `[getLiveAdIds] failed for "${projectName}": ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  },
);
