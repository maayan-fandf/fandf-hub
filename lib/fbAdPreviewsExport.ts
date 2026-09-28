import { sheetsClient, driveFolderOwner } from "@/lib/sa";
import {
  listAdAccounts,
  listRecentAdImages,
  IMAGE_WINDOW_DAYS,
  listAdsWithPreview,
  listActiveAdIds,
  getAdStatuses,
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
 * that finds nothing changed refreshes every recent ad's image, rewrites all
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
  /** Ads that got a fresh 1080px render this run: created inside
   *  IMAGE_WINDOW_DAYS, plus any still-running ad older than that. */
  withImage: number;
  /** Rows whose effective_status the status pass corrected this run. */
  statusFixed: number;
  /** Accounts whose status pass failed — their rows keep the old status. */
  statusCheckFailed: { accountId: string; error: string }[];
  rowsWritten: number;
  mode: "full" | "incremental";
  since: string;
};

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

const errorText = (e: unknown) =>
  e instanceof MetaGraphError
    ? `${e.status}${e.code ? `/${e.code}` : ""} ${e.message}`
    : e instanceof Error
      ? e.message
      : String(e);

/**
 * Pass three: make `effective_status` true for every row of one account, not
 * only for the rows pass one happened to re-pull.
 *
 * WHY. Pass one is incremental on the AD's `updated_time`, and pausing a
 * CAMPAIGN or an AD SET changes each of its ads' effective_status without
 * touching their updated_time. So the tab kept saying ACTIVE for ads that had
 * stopped — and the report's status merge, where "if anything says it is
 * delivering, it is", then painted פעילה on them. Found 2026-09-28 on
 * eastern: all 32 ads of Shbn_eastern_investors_WL_2026-07-08_FB read ACTIVE
 * as of 2026-09-08 while the campaign had been paused since ~09-22; across
 * the portfolio 46 of 728 ACTIVE rows (8 campaigns) were not delivering.
 * The reverse drifts the same way — a resumed campaign's ads kept reading
 * CAMPAIGN_PAUSED — and is fixed by the same pass.
 *
 * HOW. One ids-only walk of the ads delivering now (listActiveAdIds); a row
 * in that set reads ACTIVE, and a row that says ACTIVE but is NOT in it gets
 * its real status looked up (it is paused at some level, rejected, or gone).
 * `synced_at` is left alone on purpose: it is the incremental CURSOR, and a
 * status correction is not a re-pull (see the file's doc block).
 *
 * Returns how many rows changed.
 */
export async function reconcileAccountStatuses(
  byAdId: Map<string, (string | number)[]>,
  accountId: string,
): Promise<number> {
  const iStatus = HEADER.indexOf("effective_status");
  const iAcct = HEADER.indexOf("account_id");
  const live = await listActiveAdIds(accountId);
  const resumed: string[] = [];
  const stale: string[] = [];
  for (const [adId, row] of byAdId) {
    if (clean(row[iAcct]) !== accountId) continue;
    const was = clean(row[iStatus]).toUpperCase();
    if (live.has(adId)) {
      if (was !== "ACTIVE") resumed.push(adId);
    } else if (was === "ACTIVE") {
      stale.push(adId);
    }
  }
  // Both Meta calls first, THEN every change — all or nothing per account.
  // A lookup that throws after half the rows were rewritten would leave the
  // caller reporting "statuses stay as they were" over rows that did not.
  const real = stale.length ? await getAdStatuses(stale) : new Map<string, string>();
  let fixed = 0;
  for (const adId of resumed) {
    byAdId.get(adId)![iStatus] = "ACTIVE";
    fixed++;
  }
  for (const adId of stale) {
    const s = clean(real.get(adId));
    // Still ACTIVE by the time we asked (it started delivering between the
    // two calls): nothing to correct.
    if (!s || s.toUpperCase() === "ACTIVE") continue;
    byAdId.get(adId)![iStatus] = s;
    fixed++;
  }
  return fixed;
}

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
  /** The image pass has its own, much wider window — it is not incremental.
   *  Signed CDN URLs expire, so every recent ad needs a FRESH one every night,
   *  not just the ads whose definition happened to change. */
  const imagesSince = Math.floor(Date.now() / 1000) - IMAGE_WINDOW_DAYS * 86400;

  // ── pull ────────────────────────────────────────────────────────────
  const accounts = await listAdAccounts();
  const failed: { accountId: string; error: string }[] = [];
  const now = new Date().toISOString();
  const iImage = HEADER.indexOf("image_url");
  let adsSeen = 0;
  let withPreview = 0;
  let withImage = 0;
  let statusFixed = 0;
  const statusCheckFailed: { accountId: string; error: string }[] = [];

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

      // Pass two: the 1080px render for this account's RECENT ads — not just
      // the running ones. A paused ad still holds a card for as long as its
      // spend is in the window, and those cards were rendering "אין תצוגה"
      // while Meta had the picture. Its own walk at a smaller page size; see
      // listRecentAdImages for why it cannot ride the one above.
      for (const { id: adId, image } of await listRecentAdImages(id, imagesSince)) {
        const row = byAdId.get(adId);
        if (!row) continue; // an ad with no preview link has no row to sit in
        row[iImage] = image;
        withImage++;
      }

      // Pass three: statuses that moved without the ad being edited. Its own
      // try — the previews and images above are already good, and a failure
      // here only means this account's statuses stay as they were.
      try {
        statusFixed += await reconcileAccountStatuses(byAdId, id);
      } catch (e) {
        statusCheckFailed.push({ accountId: id, error: errorText(e) });
      }
    } catch (e) {
      // One account's failure must not cost the other twenty-two. A revoked
      // asset assignment is the likely cause and it is per-account.
      failed.push({ accountId: id, error: errorText(e) });
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
  //
  // CHUNKED, because the body outgrew a single request. The tab is 30,335
  // rows, and widening the image pass from ACTIVE-only to 150 days took the
  // filled image cells from 694 to ~2,600 — each a ~565-character signed CDN
  // URL. That put the payload at 6.6 MB, and the first run at that size came
  // back `read ECONNRESET` from the Sheets write (the data had landed, but a
  // reset the caller can see is a reset that will one night mean a half-empty
  // tab). Five thousand rows a request keeps each body near a megabyte.
  const rows = [...byAdId.values()];
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID_CREATIVES,
    range: `'${TAB}'!A:Z`,
  });
  const all = [[...HEADER], ...rows];
  const CHUNK = 5000;
  for (let i = 0; i < all.length; i += CHUNK) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID_CREATIVES,
      // 1-based, and row 1 is the header — so the slice starting at index i
      // lands on sheet row i+1.
      range: `'${TAB}'!A${i + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: all.slice(i, i + CHUNK) },
    });
  }

  return {
    accounts: accounts.length,
    accountsFailed: failed,
    adsSeen,
    withPreview,
    withImage,
    statusFixed,
    statusCheckFailed,
    rowsWritten: rows.length,
    mode: full ? "full" : "incremental",
    since: updatedSince ? new Date(updatedSince * 1000).toISOString() : "",
  };
}
