import { cache } from "react";
import { supabaseConfigured, supabaseRows } from "@/lib/supabase";

/**
 * Facebook creative assets read from the Supabase warehouse, as a FALLBACK
 * for the `facebook-ads-assets 365` Supermetrics tab.
 *
 * Why this exists. That tab is the hub's only source of creative imagery,
 * ad status, ad copy and destination URLs — the 60-day tab that used to
 * back it up was retired 2026-08-17. On 2026-08-25 it was found completely
 * empty: no rows, not even a header, while its query in the workbook's
 * registry reported "Refreshed successfully by trigger" at 05:59 that
 * morning and every other query in the same batch populated normally. The
 * connector cleared the tab, wrote nothing, and called it a success — so
 * `KEEP_RESULTS_ON_REFRESH_ERROR` never fired, and every Facebook creative
 * card in every project rendered 📷 אין תצוגה with no error anywhere.
 *
 * The reader in lib/reportCreatives.ts degrades that read to `[]` on
 * purpose, so a broken tab costs images rather than the whole קריאייטיבים
 * tab. That was the right call and is unchanged; what was missing is a
 * second place to look. `meta_ad_creatives` is that place — Nadav's nightly
 * Meta sync, which owns the same facts and does not depend on Supermetrics.
 *
 * PRECEDENCE: the sheet always wins where it has data. This only fills
 * slots the sheet left empty (see fillFromWarehouse), so a healthy tab
 * behaves exactly as before and this code path costs one extra query.
 *
 * ON THE TWO URL COLUMNS, measured 2026-08-25 over 20 recently-delivering
 * creatives:
 *   image_url      (facebook.com/ads/image/?d=…)  20/20 → HTTP 200
 *   thumbnail_url  (signed scontent…fbcdn.net)    14/20 → HTTP 200
 * The fbcdn thumbnails carry an expiring signature; the ads/image form does
 * not. So image_url leads and the thumbnail stays as the onError fallback —
 * the same chain FbAdImage already implements, just sourced differently.
 */

/** Distinct campaigns we will resolve to warehouse ids. A project's metrics
 *  tab typically names 1-5; the cap only stops a pathological project from
 *  firing a long tail of id lookups. */
const MAX_CAMPAIGNS = 12;

/** Guard on the creatives fetch. ~60 rows per campaign (the table keeps one
 *  row per creative per sync), so this clears a normal project comfortably. */
const MAX_CREATIVE_ROWS = 4000;

/** Ad ids per `meta_ad_status` request. Numeric ids, ~19 chars each, so this
 *  keeps the URL well inside any proxy's limit. */
const STATUS_CHUNK = 150;

export type WarehouseCreative = {
  image: string;
  thumb: string;
  body: string;
  title: string;
  destUrl: string;
  /** Last date Meta reported delivery for this creative. The card uses it to
   *  say how current the fallback is — the warehouse can hold a creative long
   *  after it stopped running. */
  lastSeen: string;
  /**
   * `meta_ad_status.effective_status` — ACTIVE / PAUSED / ADSET_PAUSED /
   * CAMPAIGN_PAUSED / DISAPPROVED / WITH_ISSUES. "" when the warehouse has no
   * status row for the ad.
   *
   * EFFECTIVE, not the ad's own `status`, because only it accounts for a paused
   * parent: measured 2026-08-27 over the whole table, 10,881 ads report their
   * own status as ACTIVE while just 510 are effectively running — the other
   * 10,371 sit under a paused campaign or ad set, or were disapproved. An
   * ad-level read would call all of them live.
   *
   * fbStatusInfo already speaks exactly this vocabulary, so it renders as
   * ⏸ קהל מושהה / ⏸ קמפיין מושהה rather than collapsing to "paused".
   */
  status: string;
};

type IdRow = { campaign_id: string | null };
type StatusRow = { ad_id: string | null; effective_status: string | null };
type CreativeRow = {
  campaign_id: string | null;
  ad_id: string | null;
  ad_name: string | null;
  image_url: string | null;
  thumbnail_url: string | null;
  body: string | null;
  title: string | null;
  link_url: string | null;
  last_seen: string | null;
  synced_at: string | null;
};

/** Same normalisation reportCreatives uses for its card keys — bidi and
 *  zero-width strip, whitespace collapse. Kept in step with `normCardName`
 *  there; the two must agree or nothing joins. */
function normCardName(s: string): string {
  return String(s ?? "")
    .replace(/[​-‏‪-‮⁦-⁩⁠­﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mirrors reportCreatives' `adNameOf`. Sheets coerces a date-shaped ad name
 *  into a real date and the reader normalises it back to ISO; a warehouse row
 *  for the same ad still reads "8/7/2026", so normalise both sides or those
 *  ads never join. Fires only on a whole-string d/m/yyyy. */
function adNameOf(s: string): string {
  const v = String(s ?? "").trim();
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : v;
}

function cardKey(campaign: string, ad: string): string {
  return `${campaign}|${normCardName(adNameOf(ad))}`.toLowerCase();
}

/**
 * Creative assets for the given campaign NAMES, keyed the same way
 * reportCreatives keys its cards: `${campaign}|${ad}`.toLowerCase().
 *
 * Campaign names arrive already project-matched (they come from the metrics
 * tab rows the caller has filtered), so this does no slug matching of its
 * own — it only has to cross the name→id gap the warehouse leaves open:
 * meta_ad_creatives keys on campaign_id, and only meta_ad_insights_daily
 * carries both. Resolved one campaign at a time with `eq.` rather than a
 * single `in.(…)`: campaign names carry commas, quotes and Hebrew, and
 * escaping those into a PostgREST list is exactly the kind of thing that
 * fails silently on one project and works on nineteen.
 */
export const getWarehouseCreatives = cache(
  async (campaignNames: readonly string[]): Promise<Record<string, WarehouseCreative>> => {
    const out: Record<string, WarehouseCreative> = {};
    if (!supabaseConfigured() || !campaignNames.length) return out;
    try {
      const names = [...new Set(campaignNames.filter(Boolean))].slice(0, MAX_CAMPAIGNS);
      const ids = await Promise.all(
        names.map(async (name) => {
          const rows = await supabaseRows<IdRow>(
            `meta_ad_insights_daily?select=campaign_id` +
              `&campaign_name=eq.${encodeURIComponent(name)}&limit=1`,
          );
          const id = rows[0]?.campaign_id;
          return id ? { id: String(id), name } : null;
        }),
      );
      const nameById = new Map<string, string>();
      for (const r of ids) if (r) nameById.set(r.id, r.name);
      if (!nameById.size) return out;

      const rows = await supabaseRows<CreativeRow>(
        `meta_ad_creatives?select=campaign_id,ad_id,ad_name,image_url,thumbnail_url,` +
          `body,title,link_url,last_seen,synced_at` +
          `&campaign_id=in.(${[...nameById.keys()].join(",")})` +
          // Newest sync first, so the first row seen for a key is the most
          // recently confirmed one — the table keeps a row per sync, and an
          // older row can carry an fbcdn URL whose signature has expired.
          `&order=synced_at.desc&limit=${MAX_CREATIVE_ROWS}`,
      );

      // Effective status per ad_id. Ad ids are numeric, so they go into the
      // `in.(…)` list unescaped — unlike the campaign names above. Chunked
      // to keep the URL under any proxy's length limit.
      const adIds = [
        ...new Set(rows.map((r) => String(r.ad_id ?? "")).filter(Boolean)),
      ];
      const statusById = new Map<string, string>();
      for (let i = 0; i < adIds.length; i += STATUS_CHUNK) {
        const chunk = adIds.slice(i, i + STATUS_CHUNK);
        const st = await supabaseRows<StatusRow>(
          `meta_ad_status?select=ad_id,effective_status&ad_id=in.(${chunk.join(",")})`,
        ).catch(() => [] as StatusRow[]);
        for (const s of st) {
          const v = String(s.effective_status ?? "").trim();
          if (s.ad_id && v) statusById.set(String(s.ad_id), v);
        }
      }

      // Status is collected for EVERY creative row, not just the ones
      // carrying imagery: the assets tab can fail in either direction, and a
      // card that has its picture from the sheet but lost its status pill is
      // exactly the state this fell into. Kept in its own map so an
      // image-less row can never shadow an older row that has one — the
      // imagery below is still strictly first-(newest-)wins.
      const statusByKey = new Map<string, string>();
      for (const r of rows) {
        const campaign = nameById.get(String(r.campaign_id ?? ""));
        const ad = String(r.ad_name ?? "");
        if (!campaign || !ad) continue;
        const k = cardKey(campaign, ad);
        const eff = statusById.get(String(r.ad_id ?? ""));
        if (eff && !statusByKey.has(k)) statusByKey.set(k, eff);
        const image = String(r.image_url ?? "").trim();
        const thumb = String(r.thumbnail_url ?? "").trim();
        if (!image && !thumb) continue;
        if (out[k]) continue; // first (newest synced) wins
        out[k] = {
          image,
          thumb,
          body: String(r.body ?? "").trim(),
          title: String(r.title ?? "").trim(),
          destUrl: String(r.link_url ?? "").trim(),
          lastSeen: String(r.last_seen ?? "").slice(0, 10),
          status: "",
        };
      }
      for (const [k, status] of statusByKey) {
        if (out[k]) out[k].status = status;
        else
          out[k] = {
            image: "",
            thumb: "",
            body: "",
            title: "",
            destUrl: "",
            lastSeen: "",
            status,
          };
      }
      return out;
    } catch (e) {
      // A fallback that throws is worse than no fallback: the caller is
      // already in the degraded path, and the cards still have their numbers.
      console.warn(
        `[getWarehouseCreatives] failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return out;
    }
  },
);
