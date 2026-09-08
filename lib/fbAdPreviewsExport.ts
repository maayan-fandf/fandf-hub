import { sheetsClient, driveFolderOwner } from "@/lib/sa";
import {
  listAdAccounts,
  listActiveAdImages,
  listAdsWithPreview,
  metaConfigured,
  MetaGraphError,
} from "@/lib/metaGraph";

/**
 * "צפייה במודעה" — the ad-preview links, pulled from Meta and written to a
 * tab the report reads.
 *
 * WHY THIS EXISTS. The link used to come from Supermetrics'
 * `כל מודעות פפיסבוק` tab. That tab is empty — its query reports
 * "Refreshed successfully" while writing nothing — so the link vanished from
 * EVERY project's creative cards, not only from the accounts the Supabase
 * warehouse misses. The warehouse has no equivalent field to fall back to
 * (`permalink_url` is set on 13 of 4,715 rows, and points at the organic
 * post rather than the ad), so this is the one thing that genuinely needs
 * the Graph API.
 *
 * A TAB OF OUR OWN, deliberately not the Supermetrics one. Writing into
 * `כל מודעות פפיסבוק` would need no reader change at all, and would be wiped
 * the next time that query runs: it clears its destination range before
 * writing, which is precisely how it came to be empty. Two writers on one
 * range is a race nobody wins.
 *
 * INCREMENTAL. A full portfolio walk is ~30,600 ads over 23 accounts and
 * takes about four minutes — past the 300s a cron gets. So the nightly run
 * asks Meta only for ads whose `updated_time` moved since the last run and
 * merges them over what is already in the tab; `full: true` does the whole
 * walk and is how the tab gets seeded (run once from a workstation, where
 * nothing is timing it).
 *
 * The state that makes that work is one cell: `synced_at` on the newest row.
 * Keeping it IN the tab rather than beside it means a hand-cleared tab
 * simply re-seeds itself instead of silently syncing nothing.
 *
 * ── DO NOT USE `synced_at` TO CHECK WHETHER A RUN HAPPENED ──
 * It is the incremental CURSOR, not a heartbeat. The stamp is written only
 * onto rows this run re-pulled — ads whose `updated_time` moved — so a run
 * that finds nothing changed refreshes every ACTIVE ad's image, rewrites all
 * 30,335 rows, returns ok:true, and leaves `synced_at` exactly where it was.
 * Measured twice on 2026-09-08: two separate 200s (`adsSeen: 0`,
 * `withImage: 694` then `690`) both left it at 10:39:26.953Z.
 *
 * The signal that DOES move is `image_url`: those are freshly SIGNED CDN
 * addresses, so hashing the sorted `ad_id=image_url` pairs gives a
 * fingerprint that changes on every successful run and on no failed one.
 * That is how to tell a working cron from a Cloud Scheduler job cheerfully
 * reporting 200 for the HTML of a login page.
 */

const SHEET_ID_CREATIVES =
  process.env.SHEET_ID_CREATIVES || "1q-WFtFLDnltznwYKax2yZ1O-q_VToULWN8-sn-8xXuA";
const TAB = "fb-ad-previews";

const HEADER = [
  "campaign",
  "ad_name",
  "preview_url",
  "image_url",
  "ad_id",
  "account_id",
  "effective_status",
  "synced_at",
] as const;

/** Overlap on the incremental window. Meta's `updated_time` and our clock
 *  are not the same clock, and an ad edited during a run would otherwise
 *  fall between two windows and never be picked up. Cheap insurance: an
 *  extra hour of ads is a few hundred rows. */
const OVERLAP_SECONDS = 60 * 60;

export type FbAdPreviewsResult = {
  accounts: number;
  accountsFailed: { accountId: string; error: string }[];
  adsSeen: number;
  withPreview: number;
  /** Running ads that got a fresh 1080px render this run. */
  withImage: number;
  rowsWritten: number;
  mode: "full" | "incremental";
  since: string;
};

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

export async function exportFbAdPreviews(
  opts: { full?: boolean } = {},
): Promise<FbAdPreviewsResult> {
  if (!metaConfigured()) {
    throw new Error("META_ACCESS_TOKEN is not set");
  }
  const sheets = sheetsClient(driveFolderOwner());

  // ── read what is already there ──────────────────────────────────────
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID_CREATIVES,
    fields: "sheets.properties(title)",
  });
  const exists = (meta.data.sheets ?? []).some((s) => s.properties?.title === TAB);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID_CREATIVES,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    });
  }

  /** ad_id → row, so a re-pulled ad replaces its old row instead of
   *  appending a second one. */
  const byAdId = new Map<string, (string | number)[]>();
  let newestSync = "";
  if (exists) {
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID_CREATIVES,
      range: `'${TAB}'!A:Z`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const vals = (cur.data.values ?? []) as (string | number)[][];
    if (vals.length > 1) {
      const hdr = (vals[0] as unknown[]).map((h) => clean(h));
      const idx = HEADER.map((c) => hdr.indexOf(c));
      const iAd = hdr.indexOf("ad_id");
      const iSync = hdr.indexOf("synced_at");
      for (let r = 1; r < vals.length; r++) {
        const row = vals[r];
        const adId = iAd >= 0 ? clean(row[iAd]) : "";
        if (!adId) continue;
        // Reshaped onto OUR header order, so a column added or moved by hand
        // cannot misalign every preserved row.
        byAdId.set(
          adId,
          idx.map((i) => (i >= 0 ? ((row[i] ?? "") as string | number) : "")),
        );
        const s = iSync >= 0 ? clean(row[iSync]) : "";
        if (s > newestSync) newestSync = s;
      }
    }
  }

  const full = !!opts.full || !byAdId.size || !newestSync;
  const sinceMs = full ? 0 : Date.parse(newestSync) - OVERLAP_SECONDS * 1000;
  const updatedSince = full || !Number.isFinite(sinceMs) ? undefined : Math.floor(sinceMs / 1000);

  // ── pull ────────────────────────────────────────────────────────────
  const accounts = await listAdAccounts();
  const failed: { accountId: string; error: string }[] = [];
  const now = new Date().toISOString();
  const iImage = HEADER.indexOf("image_url");
  let adsSeen = 0;
  let withPreview = 0;
  let withImage = 0;

  for (const acct of accounts) {
    const id = clean(acct.account_id);
    if (!id) continue;
    try {
      const ads = await listAdsWithPreview(id, updatedSince);
      adsSeen += ads.length;
      for (const ad of ads) {
        const url = clean(ad.preview_shareable_link);
        if (!url) continue;
        withPreview++;
        const adId = clean(ad.id);
        // An incremental run re-pulls only the ads that changed, so the
        // image cell has to survive from the previous row — the image pass
        // below writes it and it is not part of this pull.
        const keepImage = String(byAdId.get(adId)?.[iImage] ?? "");
        byAdId.set(adId, [
          clean(ad.campaign?.name),
          clean(ad.name),
          url,
          keepImage,
          adId,
          id,
          clean(ad.effective_status),
          now,
        ]);
      }

      // Pass two: the 1080px render for this account's RUNNING ads. Its own
      // walk at a smaller page size — see listActiveAdImages for why it
      // cannot ride the one above.
      for (const { id: adId, image } of await listActiveAdImages(id)) {
        const row = byAdId.get(adId);
        if (!row) continue; // an ad with no preview link has no row to sit in
        row[iImage] = image;
        withImage++;
      }
    } catch (e) {
      // One account's failure must not cost the other twenty-two. A revoked
      // asset assignment is the likely cause and it is per-account.
      failed.push({
        accountId: id,
        error:
          e instanceof MetaGraphError
            ? `${e.status}${e.code ? `/${e.code}` : ""} ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  }

  // Every account failing means the token is the problem, not the accounts —
  // and rewriting the tab from an empty pull would erase a working one.
  if (accounts.length && failed.length === accounts.length) {
    throw new Error(
      `all ${accounts.length} accounts failed — refusing to rewrite the tab: ${failed[0]?.error ?? ""}`,
    );
  }

  // ── write ───────────────────────────────────────────────────────────
  const rows = [...byAdId.values()];
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID_CREATIVES,
    range: `'${TAB}'!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID_CREATIVES,
    range: `'${TAB}'!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [[...HEADER], ...rows] },
  });

  return {
    accounts: accounts.length,
    accountsFailed: failed,
    adsSeen,
    withPreview,
    withImage,
    rowsWritten: rows.length,
    mode: full ? "full" : "incremental",
    since: updatedSince ? new Date(updatedSince * 1000).toISOString() : "",
  };
}
