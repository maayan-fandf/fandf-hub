import { cache } from "react";
import { unstable_cache, revalidateTag } from "next/cache";
import { sheetsClient } from "@/lib/sa";
import { buildMatchMap, matchSlug } from "@/lib/campaignMatch";
import { readKeysCached } from "@/lib/keys";
import { normAdName } from "@/lib/fbCreatives";
import {
  getProjectMeetingsLiveWindows,
  monthWindow,
  type MeetingsWindow,
  type ProjectMeetings,
} from "@/lib/fbCreativeMeetingsExport";
import type {
  ReportAdDaily,
  ReportAdHistoryMonth,
  ReportCreatives,
  ReportFbAd,
  ReportFbAdSet,
  ReportGoogleAd,
  ReportGoogleCopy,
  ReportGoogleDgAd,
  ReportKeyword,
  ReportWindow,
} from "@/lib/reportShared";

/**
 * Server data layer for the native קריאייטיבים tab — reads the same
 * Supermetrics creative workbook the Apps Script CREATIVE_MAP reads
 * (SHEET_ID_CREATIVES: facebook-ads-metrics / facebook-ads-assets 365 /
 * Facebook-adsets / מילות חיפוש גוגל / גוגל) and reproduces
 * `aggregateCreativeForProject_` (Code.js:3713) byte-identically:
 * window filter, winner/fatigue/sort/cap rules, adsets-tab-as-SSOT for
 * the FB KPIs. CRM meetings come from lib/fbCreativeMeetingsExport
 * DIRECTLY (the same code the iframe reaches via /api/fb-creative-
 * meetings — no HTTP hop), joined per month like the legacy
 * `sumMeetingsOverMonths_`.
 */

const CACHE_TAG = "reportCreatives";
const TTL_SECONDS = 900; // 15 min (legacy CREATIVE_MAP caches 60)

/**
 * THE Meta creative-assets source: account / campaign / ad / status, the
 * creative image + thumbnail URLs, ad copy and destination.
 *
 * Was a 365-day companion to `facebook-ads-assets links` (60-day window,
 * all 20 accounts, ~29 min per refresh). On 2026-08-17 that tab was measured
 * as a strict SUBSET of this one — 348 of 348 creatives present here, 754
 * creatives present ONLY here — so its query was retired and this became the
 * single source. Net effect on the workbook's shared refresh cycle: 77 → 48
 * minutes, while gaining a full year of creative history for every account.
 *
 * `facebook-ads-assets links` still exists as a frozen tab. Do NOT start
 * reading it again without re-registering its query: stale rows would win
 * over fresh ones and never expire.
 */
const ASSETS_TAB = "facebook-ads-assets 365";

const TOP_ADS = 8;
const TOP_ADS_HISTORICAL = 3;
/**
 * Cap on archive cards — creatives with no metrics row anywhere, appended
 * after the slice with no numbers of their own.
 *
 * Needs a cap because widening the assets window 60d → 365d (2026-08-17)
 * took the pool of "older than the metrics tab reaches" creatives from
 * roughly zero to dozens: לוריא / Feb-2026 rendered 33 cards, 25 of them
 * numberless 2025 creatives sitting on top of the 8 that actually ran that
 * month. Ranked by the assets tab's own lifetime impressions so the survivors
 * are the ones worth still looking at, not an arbitrary slice of the map.
 */
const TOP_ARCHIVE_ADS = 3;
const WINNER_MIN_LEADS = 3;
const TOP_KEYWORDS = 10;
const TOP_ADSETS = 5;
/** Demand Gen ads shown per project. Median ad carries 3 assets, the biggest
 *  seen carries 30, so a handful of ads is already a lot of cards. */
const TOP_GOOGLE_DG_ADS = 6;

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/** Bidi/zero-width strip + whitespace collapse (legacy `clean`). */
const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/[​-‏‪-‮⁦-⁩⁠­﻿\uD800-\uDFFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const num = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? "").replace(/[₪,\s%]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** Case-insensitive exact header match, first candidate wins (legacy
 *  `headerIndex_`). */
function findCol(headers: string[], names: string[]): number {
  const h = headers.map((x) => x.toLowerCase());
  for (const n of names) {
    const i = h.indexOf(n.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function parseDate(v: unknown): string {
  const s = clean(v);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return "";
}

/** Ad-name cell → stable string. A pure-date ad name (e.g. "2026-05-27")
 *  gets auto-typed by Sheets; normalize any date-looking render back to
 *  ISO so the (campaign|ad) join and the meetings key stay consistent
 *  (legacy `fbAdName_`). */
function adNameOf(v: unknown): string {
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return s;
}

/** Inclusive YYYY-MM list over [startIso..endIso] (legacy
 *  `monthsInRange_`, capped at the live endpoint's 24). */
function monthsInRange(startIso: string, endIso: string): string[] {
  if (!startIso || !endIso) return [];
  const out: string[] = [];
  let [y, m] = startIso.slice(0, 7).split("-").map(Number);
  const end = endIso.slice(0, 7);
  for (let i = 0; i < 24; i++) {
    const mon = `${y}-${String(m).padStart(2, "0")}`;
    out.push(mon);
    if (mon >= end) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** Next calendar day (UTC date-only arithmetic). ReportWindow.endIso is
 *  INCLUSIVE (see aggregateCreatives' inRange) while the meetings layer takes a
 *  half-open [from, toExcl) — so the window's upper bound must be shifted +1d
 *  before it can clip a meetings bucket. */
function nextDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

/**
 * The month buckets the CRM row is summed over — with the FIRST and LAST month
 * NARROWED to the report window's own edges.
 *
 * THE BUG THIS FIXES: cost/leads are day-clipped by inRange (the metrics rows
 * are filtered against startIso/endIso), while scheduled/held came from WHOLE
 * calendar months. On a partial-month or multi-month window the meetings figure
 * therefore over-spanned the cost figure, and עלות לתיאום / עלות לביצוע came
 * out understated — dividing real spend by meetings that happened outside the
 * window it was spent in.
 *
 * Why edge-narrowing rather than one single [start..end) bucket: the month is
 * the join key buildMeetLookups/sumOverMonths are built on (legacy
 * `sumMeetingsOverMonths_`). The sum is still EXACTLY the window — a meeting
 * event is additive and falls in exactly one bucket, and attribution is
 * month-independent (built once over the full lead history) — so nothing is
 * double-counted or lost at the seams. It also keeps crmLeads month-summed, so
 * the only change there is the same edge-day clipping cost/leads already get.
 */
function windowBuckets(
  months: string[],
  startIso: string,
  endIso: string,
): MeetingsWindow[] {
  const toExclWin = endIso ? nextDay(endIso) : "";
  return months.map((mon) => {
    const { from, toExcl } = monthWindow(mon);
    return {
      key: mon,
      from: startIso && startIso > from ? startIso : from,
      toExcl: toExclWin && toExclWin < toExcl ? toExclWin : toExcl,
    };
  });
}

/* ------------------------------ raw reader ------------------------------ */

type FbAssetRec = {
  account: string;
  status: string;
  image: string;
  thumb: string;
  destUrl: string;
  body: string;
  title: string;
  url: string;
  /** Lifetime impressions over the assets query's own window — the only
   *  metric that query carries. NOT comparable to the per-window figures on
   *  a card (those come from facebook-ads-metrics and respect the selected
   *  range); used solely to rank archive creatives, which by definition have
   *  no windowed numbers to rank on. */
  impressions: number;
};

type ProjectCreativeRaw = {
  /** facebook-ads-metrics rows, project-matched. */
  fbAds: {
    date: string;
    account: string;
    campaign: string;
    ad: string;
    impressions: number;
    clicks: number;
    cost: number;
    leads: number;
  }[];
  /** (campaign|ad).lc → assets, first-row-wins, project-matched. */
  fbAssets: Record<string, FbAssetRec>;
  /** (campaign|ad).lc → original names, for every creative the assets tab
   *  carries. The subset of these with no metrics row anywhere becomes the
   *  אין נתונים בטווח archive cards downstream; the rest are matched onto
   *  ads that already have numbers. Empty if the tab is missing. */
  fbAssetsIndexed: Record<string, { campaign: string; ad: string }>;
  /** (campaign|ad).lc → Meta ad-preview links, ALL of them rather than
   *  first-row-wins: that tab carries one row per creative, so an ad name
   *  fronting several creatives yields several links and the card can offer
   *  each. Project-matched. */
  fbPreviews: Record<string, string[]>;
  /** Facebook-adsets rows (SSOT for the FB cost/leads KPIs). */
  fbAdSets: {
    date: string;
    campaign: string;
    adSet: string;
    cost: number;
    leads: number;
  }[];
  /** מילות חיפוש גוגל per-day rows (keyword may be ""). */
  gKeywords: {
    date: string;
    keyword: string;
    impressions: number;
    clicks: number;
    conversions: number;
  }[];
  /** גוגל RSA assets (no date dimension — live snapshot). */
  gAds: ReportGoogleAd[];
  /** `discovery` tab — Demand Gen assets, one row per (ad, asset). No date
   *  dimension either: the query is a rolling 60-day snapshot. */
  gAssets: {
    campaign: string;
    campaignStatus: string;
    adGroup: string;
    adId: string;
    adStatus: string;
    fieldType: string;
    assetType: string;
    name: string;
    performance: string;
    /** Copy of a text-shaped asset. One field serves Headline, Long headline,
     *  Description AND Business name — `fieldType` says which. */
    text: string;
    cta: string;
    finalUrl: string;
    imageUrl: string;
    videoUrl: string;
    impressions: number;
    clicks: number;
    cost: number;
    conversions: number;
  }[];
};

async function fetchProjectCreativeRaw(
  subjectEmail: string,
  slug: string,
): Promise<ProjectCreativeRaw> {
  const out: ProjectCreativeRaw = {
    fbAds: [],
    fbAssets: {},
    fbAssetsIndexed: {},
    fbPreviews: {},
    fbAdSets: [],
    gKeywords: [],
    gAds: [],
    gAssets: [],
  };
  const matchMap = await buildMatchMap(subjectEmail);
  const slugLower = slug.toLowerCase();
  const mine = (campaign: string) =>
    !!campaign && matchSlug(campaign, matchMap) === slugLower;

  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_CREATIVES");

  // Creative assets — 365-day window, all 20 ad accounts. See ASSETS_TAB.
  //
  // Still read OUTSIDE the batchGet, and still `.catch(() => [])`, even now
  // that it is the only assets source and is expected to exist. One bad range
  // fails the WHOLE batchGet, so a renamed or deleted tab here has to degrade
  // to "cards render with their numbers but no images" — never to "the
  // קריאייטיבים tab is broken". That trade is more important now, not less:
  // this used to be optional garnish and is now the whole creative surface.
  //
  // Kicked off BEFORE the batch is awaited so the two round-trips overlap.
  const assetsP: Promise<unknown[][]> = sheets.spreadsheets.values
    .get({
      spreadsheetId: ssId,
      range: `'${ASSETS_TAB}'!A1:Z`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    })
    .then((r) => (r.data.values ?? []) as unknown[][])
    .catch(() => []);

  const bg = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: ssId,
    ranges: [
      "'facebook-ads-metrics'!A1:N",
      // NB: `facebook-ads-assets links` is deliberately NOT read here any
      // more — see the ASSETS_TAB block above. Its Supermetrics query was
      // retired 2026-08-17 and the tab is frozen; reading it would serve
      // whatever it happened to hold on that date, forever, and win over
      // fresh data (this index ran first, first-wins).
      "'Facebook-adsets'!A1:N",
      "'מילות חיפוש גוגל'!A1:N",
      // NB the RSA-assets tab is literally named "גוגל " WITH a trailing
      // space (the legacy getSheetByNameLoose_ absorbed it silently).
      "'גוגל '!A1:AZ",
      // Demand Gen assets. Joins the same batchGet rather than a second read.
      // A1:Z, NOT the exact current width: this query gets fields added to it
      // from the Supermetrics side, and a range pinned to today's last column
      // silently truncates the moment that happens. It did — the range was
      // A1:N while the query grew to 20 columns, which pushed Impressions /
      // Clicks / Cost / Conversions past N and made every figure read 0 while
      // the text and CTA (columns I-N) still showed. Read wide.
      "'discovery'!A1:Z",
      // Ad-preview links. Its own query runs a 365-day window against the
      // assets tab's 60, so it is the only place a creative older than two
      // months can still be looked at — hence reading a second FB tab whose
      // other four columns duplicate what we already have.
      "'כל מודעות פפיסבוק'!A1:F",
    ],
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const [vMetrics, vAdsets, vKw, vGAds, vDiscovery, vPreviews] = (
    bg.data.valueRanges ?? []
  ).map((r) => (r?.values ?? []) as unknown[][]);

  const vAssets = await assetsP;

  // כל מודעות פפיסבוק → (campaign|ad).lc → [preview URL, …].
  if (vPreviews.length > 1) {
    const h = vPreviews[0].map(clean);
    const iCamp = findCol(h, ["Campaign name"]);
    const iAd = findCol(h, ["Ad name"]);
    const iUrl = findCol(h, [
      "Ad preview URL: mobile feed",
      "Ad preview URL",
      "Mobile feed preview URL",
    ]);
    if (iCamp >= 0 && iAd >= 0 && iUrl >= 0) {
      for (let r = 1; r < vPreviews.length; r++) {
        const row = vPreviews[r];
        const camp = String(row[iCamp] ?? "").trim();
        const ad = adNameOf(row[iAd]);
        const url = String(row[iUrl] ?? "").trim();
        if (!camp || !ad || !url.startsWith("http") || !mine(camp)) continue;
        const k = `${camp}|${normCardName(ad)}`.toLowerCase();
        const list = (out.fbPreviews[k] ??= []);
        // The tab repeats a row per adset, so the same creative shows up more
        // than once — dedupe on the URL itself, not on position.
        if (!list.includes(url)) list.push(url);
      }
    }
  }

  /**
   * Index an assets-shaped tab into out.fbAssets, keyed (campaign|ad).lc.
   *
   * Run over the 60-day tab first and the 365-day one second. The
   * already-present check does double duty: first-row-wins WITHIN a tab, and
   * — on the second pass — never letting the long window overwrite the short
   * one. The 60-day query is the fresher, more authoritative source for
   * anything it covers; the long tab exists only to fill what has aged out.
   *
   * Returns the (campaign, ad) pairs this pass contributed, so the caller can
   * tell which creatives exist ONLY in the long tab.
   */
  const indexAssets = (rows: unknown[][]) => {
    const added = new Map<string, { campaign: string; ad: string }>();
    if (rows.length < 2) return added;
    const h = rows[0].map(clean);
    const iCamp = findCol(h, ["Campaign name"]);
    const iAd = findCol(h, ["Ad name"]);
    const iAcc = findCol(h, ["Account name", "Account Name", "Account"]);
    const iStatus = findCol(h, ["Ad status"]);
    const iImage = findCol(h, ["Ad creative image URL", "Ad image URL"]);
    const iThumb = findCol(h, [
      "Ad creative thumbnail URL",
      "Video thumbnail URL",
      "Thumbnail URL",
      "Ad thumbnail URL",
    ]);
    const iDest = findCol(h, ["Destination URL", "Website URL"]);
    const iBody = findCol(h, ["Body asset text", "Ad body", "Body"]);
    const iTitle = findCol(h, ["Creative title", "Title"]);
    const iUrl = findCol(h, [
      "Link to promoted post",
      "Ad preview URL: mobile feed",
      "Ad preview URL",
    ]);
    const iImp = findCol(h, ["Impressions"]);
    if (iCamp < 0 || iAd < 0) return added;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const camp = String(row[iCamp] ?? "").trim();
      const ad = adNameOf(row[iAd]);
      if (!camp || !ad || !mine(camp)) continue;
      // Keyed by the FULL ad name so each format variant keeps its own
      // thumbnail, preview link and Ad status — the assets tab has a row
      // per real ad, so this is the finer, more faithful join. (Was
      // normAdName, which collapsed the variants onto one asset row and
      // handed every card the first variant's creative + status.)
      const k = `${camp}|${normCardName(ad)}`.toLowerCase();
      if (out.fbAssets[k]) continue; // see the doc block above
      const cell = (i: number) => (i >= 0 ? String(row[i] ?? "").trim() : "");
      out.fbAssets[k] = {
        account: cell(iAcc),
        status: cell(iStatus),
        image: cell(iImage),
        thumb: cell(iThumb),
        destUrl: cell(iDest),
        body: cell(iBody),
        title: cell(iTitle),
        url: cell(iUrl),
        impressions: iImp >= 0 ? num(row[iImp]) : 0,
      };
      added.set(k, { campaign: camp, ad });
    }
    return added;
  };

  // Every creative the assets tab carries, keyed (campaign|ad).lc. Was two
  // passes — 60-day tab then 365-day tab, first-wins — until the 60-day query
  // was retired as a strict subset (see ASSETS_TAB). One pass now, so no
  // precedence question is left to get wrong.
  out.fbAssetsIndexed = Object.fromEntries(indexAssets(vAssets));

  // facebook-ads-metrics → per-day per-ad rows.
  if (vMetrics.length > 1) {
    const h = vMetrics[0].map(clean);
    const iDate = findCol(h, ["Date"]);
    const iAcc = findCol(h, ["Account name", "Account Name", "Account"]);
    const iCamp = findCol(h, ["Campaign name"]);
    const iAd = findCol(h, ["Ad name"]);
    const iImp = findCol(h, ["Impressions"]);
    const iClk = findCol(h, ["Clicks (all)", "Clicks", "Link clicks"]);
    const iCost = findCol(h, ["SUM of Cost", "Cost"]);
    const iWLd = findCol(h, ["Website leads"]);
    const iFLd = findCol(h, ["On-Facebook leads", "On Facebook leads"]);
    if (iCamp >= 0 && iAd >= 0) {
      for (let r = 1; r < vMetrics.length; r++) {
        const row = vMetrics[r];
        const camp = String(row[iCamp] ?? "").trim();
        if (!mine(camp)) continue;
        out.fbAds.push({
          date: iDate >= 0 ? parseDate(row[iDate]) : "",
          account: iAcc >= 0 ? String(row[iAcc] ?? "").trim() : "",
          campaign: camp,
          ad: adNameOf(row[iAd]),
          impressions: iImp >= 0 ? num(row[iImp]) : 0,
          clicks: iClk >= 0 ? num(row[iClk]) : 0,
          cost: iCost >= 0 ? num(row[iCost]) : 0,
          leads:
            (iWLd >= 0 ? num(row[iWLd]) : 0) +
            (iFLd >= 0 ? num(row[iFLd]) : 0),
        });
      }
    }
  }

  // Facebook-adsets → per-day per-adset rows (KPI SSOT).
  if (vAdsets.length > 1) {
    const h = vAdsets[0].map(clean);
    const iDate = findCol(h, ["Date"]);
    const iCamp = findCol(h, ["Campaign name"]);
    const iSet = findCol(h, ["Ad set name", "Adset name"]);
    const iCost = findCol(h, ["SUM of Cost", "Cost"]);
    const iWLd = findCol(h, ["Website leads"]);
    const iFLd = findCol(h, ["On-Facebook leads", "On Facebook leads"]);
    if (iCamp >= 0) {
      for (let r = 1; r < vAdsets.length; r++) {
        const row = vAdsets[r];
        const camp = String(row[iCamp] ?? "").trim();
        if (!mine(camp)) continue;
        out.fbAdSets.push({
          date: iDate >= 0 ? parseDate(row[iDate]) : "",
          campaign: camp,
          adSet: iSet >= 0 ? String(row[iSet] ?? "").trim() : "",
          cost: iCost >= 0 ? num(row[iCost]) : 0,
          leads:
            (iWLd >= 0 ? num(row[iWLd]) : 0) +
            (iFLd >= 0 ? num(row[iFLd]) : 0),
        });
      }
    }
  }

  // מילות חיפוש גוגל → per-day keyword rows (keyword may be blank; those
  // still feed the window clicks/conversions totals — legacy parity).
  if (vKw.length > 1) {
    const h = vKw[0].map(clean);
    const iCamp = findCol(h, ["Campaign name"]);
    const iKw = findCol(h, ["Keyword", "Search term"]);
    const iImp = findCol(h, ["Impressions"]);
    const iClk = findCol(h, ["Clicks"]);
    const iConv = findCol(h, ["Conversions"]);
    let iDate = findCol(h, ["Date", "תאריך", "יום"]);
    if (iDate < 0 && h.length > 3) iDate = 3; // legacy col-D fallback
    if (iCamp >= 0) {
      for (let r = 1; r < vKw.length; r++) {
        const row = vKw[r];
        const camp = String(row[iCamp] ?? "").trim();
        if (!mine(camp)) continue;
        out.gKeywords.push({
          date: iDate >= 0 ? parseDate(row[iDate]) : "",
          keyword: iKw >= 0 ? String(row[iKw] ?? "").trim() : "",
          impressions: iImp >= 0 ? num(row[iImp]) : 0,
          clicks: iClk >= 0 ? num(row[iClk]) : 0,
          conversions: iConv >= 0 ? num(row[iConv]) : 0,
        });
      }
    }
  }

  // גוגל (RSA assets) → headline/description columns per /^headline \d+/.
  if (vGAds.length > 1) {
    const h = vGAds[0].map(clean);
    const iAcc = findCol(h, ["Account", "Account name"]);
    const iCamp = findCol(h, ["Campaign name"]);
    const iUrl = findCol(h, ["Final URL"]);
    const iImp = findCol(h, ["Impressions"]);
    const iStatus = findCol(h, ["Ad status"]);
    const hlCols: number[] = [];
    const descCols: number[] = [];
    h.forEach((name, i) => {
      const n = name.toLowerCase();
      if (/^headline\s*\d+/.test(n)) hlCols.push(i);
      else if (/^description\s*\d+/.test(n)) descCols.push(i);
    });
    if (iCamp >= 0) {
      for (let r = 1; r < vGAds.length; r++) {
        const row = vGAds[r];
        const camp = String(row[iCamp] ?? "").trim();
        if (!mine(camp)) continue;
        const headlines = hlCols
          .map((i) => String(row[i] ?? "").trim())
          .filter(Boolean);
        const descriptions = descCols
          .map((i) => String(row[i] ?? "").trim())
          .filter(Boolean);
        if (!headlines.length && !descriptions.length) continue;
        out.gAds.push({
          account: iAcc >= 0 ? String(row[iAcc] ?? "").trim() : "",
          campaign: camp,
          status: iStatus >= 0 ? String(row[iStatus] ?? "").trim() : "",
          impressions: iImp >= 0 ? num(row[iImp]) : 0,
          finalUrl: iUrl >= 0 ? String(row[iUrl] ?? "").trim() : "",
          headlines,
          descriptions,
        });
      }
    }
    out.gAds.sort((a, b) => b.impressions - a.impressions);
  }

  // discovery → Demand Gen assets, one row per (ad, asset). Keeps text assets
  // as well as media: `assetTextText` carries the copy for Headline, Long
  // headline, Description and Business name alike, and `assetFieldType` says
  // which. Rows with neither media nor copy are dropped.
  if (vDiscovery.length > 1) {
    const h = vDiscovery[0].map(clean);
    const iCamp = findCol(h, ["Campaign name"]);
    const iCampStatus = findCol(h, ["Campaign status"]);
    const iAdGroup = findCol(h, ["Ad group name"]);
    const iAdId = findCol(h, ["Ad ID"]);
    const iAdStatus = findCol(h, ["Ad status"]);
    const iField = findCol(h, ["Asset field type"]);
    const iType = findCol(h, ["Asset type"]);
    const iName = findCol(h, ["Asset name"]);
    const iPerf = findCol(h, ["Asset performance"]);
    const iText = findCol(h, ["Text (Text assets)", "Text"]);
    const iCta = findCol(h, ["Call to action"]);
    const iCtaCarousel = findCol(h, [
      "Call to action text (Demand gen carousel card assets)",
    ]);
    const iFinal = findCol(h, ["Final URL (Assets)"]);
    const iImg = findCol(h, ["Full size image URL"]);
    const iVid = findCol(h, [
      "YouTube video URL (YouTube video assets)",
      "YouTube video URL",
    ]);
    const iImp = findCol(h, ["Impressions"]);
    const iClk = findCol(h, ["Clicks"]);
    const iCost = findCol(h, ["Cost"]);
    const iConv = findCol(h, ["Conversions"]);
    const cell = (row: unknown[], i: number) =>
      i >= 0 ? String(row[i] ?? "").trim() : "";
    if (iCamp >= 0) {
      for (let r = 1; r < vDiscovery.length; r++) {
        const row = vDiscovery[r];
        const camp = cell(row, iCamp);
        if (!mine(camp)) continue;
        // Text-only ads are filtered out later, at the AD level — a Demand Gen
        // ad's headline rows carry no image and must be kept as its copy.
        const imageUrl = cell(row, iImg);
        // The stub "https://www.youtube.com/watch?v=" (no id) shows up on
        // non-video rows, so require a real id before calling it a video.
        const rawVid = cell(row, iVid);
        const videoUrl = /watch\?v=.+/.test(rawVid) ? rawVid : "";
        const text = cell(row, iText);
        if (!imageUrl && !videoUrl && !text) continue;
        out.gAssets.push({
          campaign: camp,
          campaignStatus: cell(row, iCampStatus),
          adGroup: cell(row, iAdGroup),
          adId: cell(row, iAdId),
          adStatus: cell(row, iAdStatus),
          fieldType: cell(row, iField),
          assetType: cell(row, iType),
          name: cell(row, iName),
          performance: cell(row, iPerf),
          text,
          cta: cell(row, iCta) || cell(row, iCtaCarousel),
          finalUrl: cell(row, iFinal),
          imageUrl,
          videoUrl,
          impressions: iImp >= 0 ? num(row[iImp]) : 0,
          clicks: iClk >= 0 ? num(row[iClk]) : 0,
          cost: iCost >= 0 ? num(row[iCost]) : 0,
          conversions: iConv >= 0 ? num(row[iConv]) : 0,
        });
      }
    }
  }

  return out;
}

const fetchProjectCreativeRawCrossRequest = unstable_cache(
  fetchProjectCreativeRaw,
  ["reportCreatives"],
  { revalidate: TTL_SECONDS, tags: [CACHE_TAG] },
);

const readProjectCreativeRaw = cache(
  (subjectEmail: string, slug: string) =>
    fetchProjectCreativeRawCrossRequest(subjectEmail, slug),
);

export function invalidateReportCreativesCache(): void {
  revalidateTag(CACHE_TAG);
}

/* ---------------------------- meetings lookups --------------------------- */

type MeetVal = { leads: number; scheduled: number; held: number };
type MeetLookups = {
  creative: Map<string, MeetVal>;
  audience: Map<string, MeetVal>;
  keyword: Map<string, MeetVal>;
};

function emptyLookups(): MeetLookups {
  return { creative: new Map(), audience: new Map(), keyword: new Map() };
}

/** Keyed by the caller's BUCKET KEY, not by month — the report passes bare
 *  months for its (edge-clipped) window buckets, so `sumOverMonths` still looks
 *  them up by month exactly as before. */
function buildMeetLookups(
  results: Array<{ key: string } & ProjectMeetings>,
  crmName: string,
): MeetLookups {
  const out = emptyLookups();
  const projLc = clean(crmName).toLowerCase();
  for (const r of results) {
    for (const c of r.creative) {
      out.creative.set(
        `${r.key}|${c.campaign}|${normAdName(c.ad)}`.toLowerCase(),
        { leads: c.leads || 0, scheduled: c.scheduled || 0, held: c.held || 0 },
      );
    }
    for (const a of r.audience) {
      out.audience.set(`${r.key}|${projLc}|${clean(a.audience).toLowerCase()}`, {
        leads: a.leads || 0,
        scheduled: a.scheduled || 0,
        held: a.held || 0,
      });
    }
    for (const k of r.keyword) {
      out.keyword.set(`${r.key}|${projLc}|${clean(k.keyword).toLowerCase()}`, {
        leads: k.leads || 0,
        scheduled: k.scheduled || 0,
        held: k.held || 0,
      });
    }
  }
  return out;
}

/** Legacy `sumMeetingsOverMonths_` — null when NO month had a row (the
 *  UI hides the CRM row then). */
function sumOverMonths(
  lookup: Map<string, MeetVal>,
  months: string[],
  base: string,
): MeetVal | null {
  let found = false;
  const t = { leads: 0, scheduled: 0, held: 0 };
  for (const m of months) {
    const v = lookup.get(`${m}|${base}`);
    if (!v) continue;
    found = true;
    t.leads += v.leads;
    t.scheduled += v.scheduled;
    t.held += v.held;
  }
  return found ? t : null;
}

/* ------------------------------ aggregation ------------------------------ */

function dedupeDaily(
  rows: { date: string; cost: number; leads: number }[],
): ReportAdDaily[] {
  const byDate = new Map<string, ReportAdDaily>();
  for (const r of rows) {
    const p = byDate.get(r.date) ?? { date: r.date, cost: 0, leads: 0 };
    p.cost += r.cost;
    p.leads += r.leads;
    byDate.set(r.date, p);
  }
  return [...byDate.keys()].sort().map((k) => byDate.get(k)!);
}

/** The project's ad-metrics span — the deepest per-ad COST history that
 *  exists. The Supermetrics connector exports a rolling lookback, so this
 *  floor moves forward over time; the hover panel labels itself with it
 *  rather than implying it knows an ad's whole life. */
function adMetricsSpan(raw: ProjectCreativeRaw): { from: string; months: string[] } {
  let lo = "";
  let hi = "";
  for (const r of raw.fbAds) {
    if (!r.date) continue;
    if (!lo || r.date < lo) lo = r.date;
    if (!hi || r.date > hi) hi = r.date;
  }
  return lo && hi ? { from: lo, months: monthsInRange(lo, hi) } : { from: "", months: [] };
}

/**
 * THE card identity, used by every join on this tab: the ad-metrics rows, the
 * assets lookup, the cost history and the warehouse meetings all key on this.
 *
 * normAdName (which strips Meta's injected bidi marks) rather than bare
 * adNameOf (which does not) — the two disagreed, so a card whose name carried
 * a U+200E aggregated separately from its own meetings row while a sibling
 * card matched the same row. Both then rendered the FULL count: 67 of 632
 * cards (10.6%, 10 projects) double-counted their תואמו/בוצעו.
 *
 * Consequence, and it is owner-visible: cards that differed only by bidi marks
 * now MERGE. Their cost/leads combine and the winner pick can move on the
 * affected projects.
 */
function adKey(campaign: string, ad: string): string {
  return `${campaign}|${normAdName(ad)}`.toLowerCase();
}

/**
 * CARD identity — the ad name as Meta shows it, minus only the invisible
 * bidi/zero-width marks Meta sprinkles through it.
 *
 * Deliberately NOT normAdName. That one additionally strips a trailing
 * " - Video / Static / Carousel", which is right where it was written (the
 * CRM join in lib/fbCreatives: Meta's utm_content drops the suffix, so the
 * metrics side has to drop it too to match) and wrong for card identity:
 * those are three separate ads with separate budgets and separate results,
 * and collapsing them hid exactly the comparison this tab exists to make.
 *
 * חלומות בן שמן, 01–12/08: Video ₪5,494/23 leads, Static ₪1,657/7,
 * Carousel ₪265/0 — rendered as ONE card of ₪7,416/30, labelled
 * "2026-07-23A - Carousel" because that variant's row happened to come
 * first in the export. The card named the only variant that produced
 * nothing. (Maayan, 2026-08-12.)
 *
 * The bidi strip stays: it is what the duplicate-card fix was actually
 * about, and two cards differing only by a U+200E really are one ad.
 */
function normCardName(s: string): string {
  return String(s ?? "")
    .replace(/[​-‏‪-‮⁦-⁩⁠­﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cardKey(campaign: string, ad: string): string {
  return `${campaign}|${normCardName(ad)}`.toLowerCase();
}

/**
 * Per-(card key) per-month cost/leads over the WHOLE ad-metrics tab. Free: the
 * tab is read whole and cached, and the report window is applied downstream in
 * inRange — nothing extra is fetched here.
 */
function buildCostHistory(raw: ProjectCreativeRaw, startIso: string) {
  const byMonth = new Map<string, Map<string, { cost: number; leads: number }>>();
  const pre = new Map<string, { cost: number; leads: number }>();
  for (const r of raw.fbAds) {
    if (!r.date || !r.ad) continue;
    const k = cardKey(r.campaign, r.ad);
    let m = byMonth.get(k);
    if (!m) {
      m = new Map();
      byMonth.set(k, m);
    }
    const mon = r.date.slice(0, 7);
    const cell = m.get(mon) ?? { cost: 0, leads: 0 };
    cell.cost += r.cost;
    cell.leads += r.leads;
    m.set(mon, cell);
    if (startIso && r.date < startIso) {
      const p = pre.get(k) ?? { cost: 0, leads: 0 };
      p.cost += r.cost;
      p.leads += r.leads;
      pre.set(k, p);
    }
  }
  return { byMonth, pre };
}

function aggregateCreatives(
  raw: ProjectCreativeRaw,
  startIso: string,
  endIso: string,
  meet: MeetLookups,
  months: string[],
  crmName: string,
  hist: { from: string; months: string[] } | null,
): ReportCreatives {
  // Legacy inRange (Code.js:3721): undated rows pass only with no window.
  const inRange = (d: string) => {
    if (!d) return !startIso && !endIso;
    if (startIso && d < startIso) return false;
    if (endIso && d > endIso) return false;
    return true;
  };
  const projLc = clean(crmName).toLowerCase();

  // FB totals + ad-sets (the adsets tab is the KPI SSOT — legacy parity).
  let totalCost = 0;
  let totalLeads = 0;
  const adSetAgg = new Map<
    string,
    { cost: number; leads: number; daily: { date: string; cost: number; leads: number }[] }
  >();
  for (const r of raw.fbAdSets) {
    if (!inRange(r.date)) continue;
    totalCost += r.cost;
    totalLeads += r.leads;
    if (!r.adSet) continue;
    const a = adSetAgg.get(r.adSet) ?? { cost: 0, leads: 0, daily: [] };
    a.cost += r.cost;
    a.leads += r.leads;
    a.daily.push({ date: r.date, cost: r.cost, leads: r.leads });
    adSetAgg.set(r.adSet, a);
  }
  const topAdSets: ReportFbAdSet[] = [...adSetAgg.entries()]
    .map(([name, a]) => {
      const mtg = sumOverMonths(
        meet.audience,
        months,
        `${projLc}|${clean(name).toLowerCase()}`,
      );
      return {
        name,
        cost: a.cost,
        leads: a.leads,
        cpl: a.leads > 0 ? a.cost / a.leads : 0,
        crmLeads: mtg?.leads ?? 0,
        scheduled: mtg?.scheduled ?? 0,
        held: mtg?.held ?? 0,
        costPerSched: mtg && mtg.scheduled > 0 ? a.cost / mtg.scheduled : 0,
        costPerHeld: mtg && mtg.held > 0 ? a.cost / mtg.held : 0,
        daily: dedupeDaily(a.daily),
      };
    })
    .sort(
      (a, b) =>
        (a.cpl <= 0 ? Infinity : a.cpl) - (b.cpl <= 0 ? Infinity : b.cpl),
    )
    .slice(0, TOP_ADSETS);

  // FB top ads: join (campaign|ad).lc over in-range metrics rows.
  type AdAcc = {
    account: string;
    campaign: string;
    ad: string;
    impressions: number;
    clicks: number;
    cost: number;
    leads: number;
    daily: { date: string; impressions: number; clicks: number; cost: number; leads: number }[];
  };
  const adAgg = new Map<string, AdAcc>();
  for (const r of raw.fbAds) {
    if (!inRange(r.date)) continue;
    if (!r.ad) continue;
    const k = cardKey(r.campaign, r.ad);
    const a =
      adAgg.get(k) ??
      ({
        account: r.account,
        campaign: r.campaign,
        ad: r.ad,
        impressions: 0,
        clicks: 0,
        cost: 0,
        leads: 0,
        daily: [],
      } as AdAcc);
    a.impressions += r.impressions;
    a.clicks += r.clicks;
    a.cost += r.cost;
    a.leads += r.leads;
    a.daily.push({
      date: r.date,
      impressions: r.impressions,
      clicks: r.clicks,
      cost: r.cost,
      leads: r.leads,
    });
    adAgg.set(k, a);
  }

  // True per-ad first/last activity over the UNCLIPPED metrics tab. ageDays
  // used to be measured off `a.daily`, which only holds rows that passed
  // inRange — so on a one-month window it could never exceed 31 and the
  // `ageDays >= 45 → "long"` fatigue branch below was unreachable, i.e. an ad
  // was never flagged for age alone. Measuring the real calendar span makes
  // that rule fire as written. NB the span is floored by the ad-metrics tab's
  // rolling lookback (see adMetricsSpan), so a very old ad reads as at most
  // "as old as the export reaches" — under-stated, never over-stated.
  const adSpanAll = new Map<string, { first: string; last: string }>();
  for (const r of raw.fbAds) {
    if (!r.date || !r.ad) continue;
    const k = cardKey(r.campaign, r.ad);
    const s = adSpanAll.get(k);
    if (!s) adSpanAll.set(k, { first: r.date, last: r.date });
    else {
      if (r.date < s.first) s.first = r.date;
      if (r.date > s.last) s.last = r.date;
    }
  }

  const ads: ReportFbAd[] = [...adAgg.entries()].map(([k, a]) => {
    const assets = raw.fbAssets[k];
    // Fatigue (legacy 3791-3827): calendar-span age, early-vs-recent CTR.
    // The CTR halves stay WINDOW-scoped (they measure decline within the
    // period being reported); only the age is lifetime.
    const daily = [...a.daily].sort((x, y) => (x.date < y.date ? -1 : 1));
    const span = adSpanAll.get(k);
    const first = span?.first ?? daily[0]?.date ?? "";
    const last = span?.last ?? daily[daily.length - 1]?.date ?? "";
    const ageDays =
      first && last
        ? Math.max(
            1,
            Math.round(
              (Date.parse(last) - Date.parse(first)) / 86400000,
            ) + 1,
          )
        : daily.length;
    const mid = Math.max(1, Math.floor(daily.length / 2));
    const early = daily.slice(0, mid);
    const recent = daily.slice(mid);
    const sum = (rows: typeof daily, f: "impressions" | "clicks") =>
      rows.reduce((s, r) => s + r[f], 0);
    const eImp = sum(early, "impressions");
    const rImp = sum(recent, "impressions");
    const ctrEarly = eImp > 0 ? sum(early, "clicks") / eImp : 0;
    const ctrRecent = rImp > 0 ? sum(recent, "clicks") / rImp : 0;
    const ctrDropPct = ctrEarly > 0 ? (ctrEarly - ctrRecent) / ctrEarly : 0;
    // "⏳ שקלו לרענן" is a call to action, and a paused ad has nothing to
    // act on — you can't refresh a creative that isn't running. Every card
    // in a wound-down campaign carried it, which is noise sitting exactly
    // where a real signal would go. Gate it on the ad still running; the
    // card falls back to the neutral "📅 N ימים" age chip.
    //
    // "⚠️ CTR יורד" is deliberately NOT gated: that one states what
    // happened rather than asking for something, and on a paused ad it
    // usually explains why it was paused.
    const running =
      String(assets?.status ?? "").toUpperCase().trim() === "ACTIVE";
    let fatigued = false;
    let fatigueReason: ReportFbAd["fatigueReason"] = "";
    if (ageDays >= 30 && ctrDropPct >= 0.25 && ctrEarly >= 0.003 && rImp >= 500) {
      fatigued = true;
      fatigueReason = "declining";
    } else if (ageDays >= 45 && running) {
      fatigued = true;
      fatigueReason = "long";
    }
    // `k` is now the CARD key (per variant); the meetings export is keyed at
    // the normAdName level, so look those up under the group key. The
    // per-group de-duplication happens right after this map.
    const mtg = sumOverMonths(meet.creative, months, adKey(a.campaign, a.ad));
    return {
      account: a.account || assets?.account || "",
      campaign: a.campaign,
      ad: a.ad,
      status: assets?.status ?? "",
      url: assets?.url ?? "",
      destUrl: assets?.destUrl ?? "",
      body: assets?.body ?? "",
      title: assets?.title ?? "",
      // NEVER seed thumb from image (legacy v563 fix — the thumb must
      // stay the real fbcdn thumbnail for the onError fallback).
      thumb: assets?.thumb ?? "",
      image: assets?.image ?? "",
      // Omitted rather than [] when there's nothing — an empty array per ad
      // is dead weight in the flight payload, and the card tests truthiness.
      previews: raw.fbPreviews[k]?.length ? raw.fbPreviews[k] : undefined,
      impressions: a.impressions,
      clicks: a.clicks,
      cost: a.cost,
      leads: a.leads,
      cpl: a.leads > 0 ? a.cost / a.leads : 0,
      ctr: a.impressions > 0 ? a.clicks / a.impressions : 0,
      crmLeads: mtg?.leads ?? 0,
      scheduled: mtg?.scheduled ?? 0,
      held: mtg?.held ?? 0,
      costPerSched: mtg && mtg.scheduled > 0 ? a.cost / mtg.scheduled : 0,
      costPerHeld: mtg && mtg.held > 0 ? a.cost / mtg.held : 0,
      ageDays,
      ctrEarly,
      ctrRecent,
      fatigued,
      fatigueReason,
      isWinner: false,
      daily: dedupeDaily(a.daily),
    };
  });

  // CRM meetings can't be split across format variants — Meta's utm_content
  // drops the " - Video/Static/Carousel" suffix, so the export has no row that
  // belongs to one variant (0 of 618 carry a suffix). Now that each variant is
  // its own card they'd EACH render the group's full תואמו/בוצעו, which is the
  // duplicate-render the merge originally fixed. So hand the counts to one
  // variant of the group — the one that produced the leads they came from —
  // and flag it, rather than repeating them or inventing a pro-rata split.
  // Single-variant groups (the overwhelming majority) are untouched.
  const meetingsOwner = new Set<ReportFbAd>();
  const byGroup = new Map<string, ReportFbAd[]>();
  for (const a of ads) {
    const g = adKey(a.campaign, a.ad);
    const list = byGroup.get(g);
    if (list) list.push(a);
    else byGroup.set(g, [a]);
  }
  for (const group of byGroup.values()) {
    if (group.length === 1) {
      meetingsOwner.add(group[0]);
      continue;
    }
    const owner = group.reduce((best, a) =>
      a.leads !== best.leads
        ? a.leads > best.leads
          ? a
          : best
        : a.cost > best.cost
          ? a
          : best,
    );
    meetingsOwner.add(owner);
    owner.meetingsAtGroupLevel =
      owner.crmLeads > 0 || owner.scheduled > 0 || owner.held > 0;
    for (const a of group) {
      if (a === owner) continue;
      a.crmLeads = 0;
      a.scheduled = 0;
      a.held = 0;
      a.costPerSched = 0;
      a.costPerHeld = 0;
    }
  }

  // Winner: picked over the UNsliced list (legacy 3903).
  const winner = ads
    .filter((a) => a.leads >= WINNER_MIN_LEADS && a.cpl > 0)
    .sort((a, b) => a.cpl - b.cpl)[0];
  if (winner) winner.isWinner = true;

  const isActive = (a: ReportFbAd) =>
    String(a.status).toUpperCase().trim() === "ACTIVE";
  ads.sort((a, b) => {
    const act = Number(isActive(b)) - Number(isActive(a));
    if (act) return act;
    const win = Number(b.isWinner) - Number(a.isWinner);
    if (win) return win;
    const cplA = a.cpl <= 0 ? Infinity : a.cpl;
    const cplB = b.cpl <= 0 ? Infinity : b.cpl;
    if (cplA !== cplB) return cplA - cplB;
    return b.cost - a.cost;
  });
  const activeCount = ads.filter(isActive).length;
  const sliceCap = Math.max(TOP_ADS, activeCount + TOP_ADS_HISTORICAL);

  // Demand Gen assets: Google links one uploaded image to many ads, so the
  // tab holds a row per (ad, asset) and the same picture repeats. Fold them by
  // asset URL so a creative appears ONCE with its real totals — the same
  // reasoning as the FB card key, arrived at the other way round.
  //
  // Not window-clipped: the query carries no Date dimension (rolling 60 days).
  // The block's subtitle says so; see ReportGoogleAsset.
  // How many ads each image appears in — 152 of 323 images are reused, so a
  // card that didn't say so would imply the picture belongs to one ad.
  const adsPerImage = new Map<string, Set<string>>();
  for (const a of raw.gAssets) {
    if (!a.imageUrl) continue;
    const s = adsPerImage.get(a.imageUrl) ?? new Set<string>();
    s.add(a.adId || `${a.campaign}|${a.adGroup}`);
    adsPerImage.set(a.imageUrl, s);
  }

  // Pass 1 — collect each ad's own assets, keyed by ad id.
  // `copy` is still one unsplit list here — live and retired text alike. The
  // split into copy/copyRetired happens once, after the merge, so a text that
  // is live on any of the merged ads lands on the live side.
  type DgDraft = Omit<ReportGoogleDgAd, "copyRetired"> & { adGroup: string };
  const dgAdAgg = new Map<string, DgDraft>();
  for (const a of raw.gAssets) {
    const adKeyG = a.adId || `${a.campaign}|${a.adGroup}`;
    if (!adKeyG) continue;
    let ad = dgAdAgg.get(adKeyG);
    if (!ad) {
      ad = {
        campaign: a.campaign,
        campaignStatus: a.campaignStatus,
        status: a.adStatus,
        adGroup: a.adGroup,
        adGroups: a.adGroup ? [a.adGroup] : [],
        adIds: a.adId ? [a.adId] : [],
        images: [],
        copy: [],
        topAssetCost: 0,
      };
      dgAdAgg.set(adKeyG, ad);
    }
    if (a.cost > ad.topAssetCost) ad.topAssetCost = a.cost;
    const media = a.imageUrl || a.videoUrl;
    if (media) {
      ad.images.push({
        imageUrl: a.imageUrl,
        videoUrl: a.videoUrl,
        name: a.name,
        fieldType: a.fieldType,
        performance: a.performance,
        cta: a.cta,
        finalUrl: a.finalUrl,
        sharedWith: Math.max(0, (adsPerImage.get(a.imageUrl)?.size ?? 1) - 1),
        impressions: a.impressions,
        clicks: a.clicks,
        cost: a.cost,
        conversions: a.conversions,
      });
    } else if (a.text) {
      ad.copy.push({
        fieldType: a.fieldType,
        text: a.text,
        performance: a.performance,
        impressions: a.impressions,
        clicks: a.clicks,
        cost: a.cost,
        conversions: a.conversions,
      });
    }
  }

  // Pass 2 — merge ads that are the SAME creative running against different
  // audiences. On נתיבות four ad groups ("All users", "מחפשים דירה להשקעה",
  // "חיפשו רייסדור", "Google-engaged audiences") carry an identical set of ~25
  // images and 10 texts, which rendered as four near-identical cards.
  //
  // Signature is campaign + the exact asset set, so genuinely different
  // creatives never fold together. Per-asset metrics ARE summed across the
  // merged ads — different ad groups mean different impressions, so unlike
  // summing WITHIN an ad this doesn't double-count.
  // Matching on the EXACT asset set wasn't enough. Ad groups routinely run the
  // same creative with an image or two added or dropped — ahuzat-afridar's
  // "Rm"/"חיפשו" ads carry 15 images and its "55+" ad carries 14 of the same
  // ones, which rendered as two nearly identical cards.
  //
  // Overlap is what separates them, and the data leaves a wide gap to cut in.
  // Across every pair of ads inside one campaign: 110 pairs identical, 24 pairs
  // between 0.6 and 0.99 (all of them the same creative re-targeted), only 3
  // between 0.3 and 0.59, and 132 below 0.3 — genuinely different creatives.
  // 0.6 sits in near-empty space, so it catches all the duplicates without
  // being able to reach the distinct ones.
  const MERGE_OVERLAP = 0.6;
  const keysOf = (ad: DgDraft) =>
    new Set(ad.images.map((i) => i.imageUrl || i.videoUrl));
  const overlap = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  };

  const merged = new Map<string, DgDraft>();
  const groupKeys = new Map<string, Set<string>>();
  for (const ad of dgAdAgg.values()) {
    const mine2 = keysOf(ad);
    // First group in the same campaign that this creative substantially shares
    // its images with. Greedy rather than exhaustive clustering — with a handful
    // of ads per campaign the difference never shows.
    let sig: string | undefined;
    for (const [k, g] of merged) {
      if (g.campaign !== ad.campaign) continue;
      if (overlap(mine2, groupKeys.get(k)!) >= MERGE_OVERLAP) {
        sig = k;
        break;
      }
    }
    if (sig === undefined) {
      const k = `${ad.campaign}||${ad.adIds.join(",") || ad.adGroups.join(",")}`;
      merged.set(k, ad);
      groupKeys.set(k, mine2);
      continue;
    }
    const cur = merged.get(sig)!;
    for (const x of mine2) groupKeys.get(sig)!.add(x);
    for (const g of ad.adGroups) if (!cur.adGroups.includes(g)) cur.adGroups.push(g);
    for (const id of ad.adIds) if (!cur.adIds.includes(id)) cur.adIds.push(id);
    if (cur.status !== ad.status) cur.status = "mixed";
    if (ad.topAssetCost > cur.topAssetCost) cur.topAssetCost = ad.topAssetCost;
    const addTo = <T extends { impressions: number; clicks: number; cost: number; conversions: number }>(
      dst: T | undefined,
      src: T,
    ) => {
      if (!dst) return false;
      dst.impressions += src.impressions;
      dst.clicks += src.clicks;
      dst.cost += src.cost;
      dst.conversions += src.conversions;
      return true;
    };
    for (const im of ad.images) {
      const key = im.imageUrl || im.videoUrl;
      if (!addTo(cur.images.find((x) => (x.imageUrl || x.videoUrl) === key), im)) {
        cur.images.push(im);
      }
    }
    for (const c of ad.copy) {
      const dst = cur.copy.find((x) => x.fieldType === c.fieldType && x.text === c.text);
      // Live beats retired. The same text can be a removed link on one of the
      // merged ads and still attached on another, and blank performance is the
      // ONLY thing marking it removed (see the copy split below) — so a
      // first-wins merge could file live copy under "historical".
      if (dst && !dst.performance.trim() && c.performance.trim()) {
        dst.performance = c.performance;
      }
      if (!addTo(dst, c)) cur.copy.push(c);
    }
  }

  const COPY_ORDER = ["Headline", "Long headline", "Description", "Business name"];
  const copyRank = (ft: string) => {
    const i = COPY_ORDER.indexOf(ft);
    return i < 0 ? 99 : i;
  };
  const byKindThenReach = (x: ReportGoogleCopy, y: ReportGoogleCopy) =>
    copyRank(x.fieldType) - copyRank(y.fieldType) || y.impressions - x.impressions;
  /**
   * Blank `performance` = the asset's LINK to this ad was removed; the row only
   * survives because it still had impressions inside the query's rolling 60-day
   * window. Google rates every attached asset, even a brand new one ("Pending
   * information"), so the absence of a rating is what a removed link looks
   * like — the tab carries no asset-status column to ask directly.
   *
   * Validated against the Google Ads UI on fandf_afridar_anda_discovery: the
   * ad's 7 reported headlines and 5 descriptions split 3+4 rated / 4+1 blank,
   * and the rated set is EXACTLY the copy the ad actually carries. Tab-wide,
   * this pulled all 12 over-cap Demand Gen ads (>5 headlines, impossible for
   * the format) back under the limit and touched no others.
   *
   * If Supermetrics ever gains the asset-link status field on this query, use
   * it instead and delete this inference.
   */
  const isRetired = (c: ReportGoogleCopy) => !c.performance.trim();
  const dgAds: ReportGoogleDgAd[] = [...merged.values()]
    .map((ad) => ({
      campaign: ad.campaign,
      campaignStatus: ad.campaignStatus,
      status: ad.status,
      adGroups: ad.adGroups,
      adIds: ad.adIds,
      topAssetCost: ad.topAssetCost,
      images: ad.images.sort((x, y) => y.cost - x.cost),
      copy: ad.copy.filter((c) => !isRetired(c)).sort(byKindThenReach),
      copyRetired: ad.copy.filter(isRetired).sort(byKindThenReach),
    }))
    // Keep only ads that actually have a creative to show. AdGroupAdAssetView
    // returns assets for EVERY Google ad type and search RSAs are the bulk of
    // it — they have their own block, fed by the גוגל tab, so letting them in
    // here duplicated search copy under a creatives heading.
    //
    // The discriminator is media, not the campaign name and not the channel
    // type. AdvertisingChannelType looked like the principled answer, but the
    // Sheets connector silently DROPS that field: it rewrote the query
    // definition without it on the next refresh and the column never appeared.
    // Measured over all 247 ads in the tab, "has an image or video" agrees
    // with the naming convention on 244 and is RIGHT on the 3 it differs on —
    // fandf_afridar_ahuzat-afridar_discover is spelled without the "y", so a
    // name test drops three genuine Demand Gen ads carrying marketing images.
    .filter((ad) => ad.images.length > 0)
    // Live creatives first, then by the ad's biggest single asset — a lower
    // bound on its spend. Summing its assets would overstate it (median 1.8x),
    // so that total is never computed.
    .sort((x, y) => {
      const live = (s: string) => (/enabled|active/i.test(s) ? 0 : 1);
      return live(x.status) - live(y.status) || y.topAssetCost - x.topAssetCost;
    })
    .slice(0, TOP_GOOGLE_DG_ADS);

  // Google: window totals over ALL rows; keyword agg over named rows.
  let googleClicks = 0;
  let googleConversions = 0;
  const kwAgg = new Map<string, { imp: number; clk: number; conv: number }>();
  for (const r of raw.gKeywords) {
    if (!inRange(r.date)) continue;
    googleClicks += r.clicks;
    googleConversions += r.conversions;
    if (!r.keyword) continue;
    const a = kwAgg.get(r.keyword) ?? { imp: 0, clk: 0, conv: 0 };
    a.imp += r.impressions;
    a.clk += r.clicks;
    a.conv += r.conversions;
    kwAgg.set(r.keyword, a);
  }
  const topKeywords: ReportKeyword[] = [...kwAgg.entries()]
    .map(([keyword, a]) => {
      const mtg = sumOverMonths(
        meet.keyword,
        months,
        `${projLc}|${clean(keyword).toLowerCase()}`,
      );
      return {
        keyword,
        impressions: a.imp,
        clicks: a.clk,
        conversions: a.conv,
        scheduled: mtg?.scheduled ?? 0,
        held: mtg?.held ?? 0,
      };
    })
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, TOP_KEYWORDS);

  // History rides only the RENDERED cards — attaching before the slice would
  // pay payload for ads nobody sees.
  const topAds = ads.slice(0, sliceCap);

  // Creatives that survive only in the 365-day assets tab: they ran before the
  // metrics window opens, so there is no cost/impressions row for them
  // anywhere. Appended AFTER the slice and kept out of the winner/sort maths
  // entirely — they have no numbers to be ranked on, and letting them compete
  // for sliceCap would drop a card that does have them. `noWindowData` tells
  // the card to show the creative and say so instead of printing zeros.
  //
  // TWO conditions, not one, and the second is easy to lose. `carded` only
  // says "didn't deliver in the SELECTED window" — which is the normal reason
  // a creative has no card (the inRange guard on the adAgg loop above is what
  // enforces "no delivery in the timeframe → no card"). That alone used to be
  // a safe proxy for "ancient" because the 60-day assets tab was the only
  // source: anything missing from BOTH it and the in-window metrics really had
  // run before the metrics tab reaches.
  //
  // Moving to the 365-day assets tab (2026-08-17) broke that proxy, and
  // retiring the 60-day tab the same day removed it entirely — the assets
  // index now spans a full year, so "not carded" says nothing about age. It
  // showed up as קנקו's 2026-01-18* ads, which delivered Mar-May and stopped,
  // appearing as five numberless cards in a June view where the correct
  // behaviour is not to show them at all.
  //
  // `adSpanAll` is built over the UNCLIPPED metrics tab, so it answers the
  // question the proxy was really asking: does this creative have numbers
  // ANYWHERE? If it does, its absence here is a normal out-of-window absence
  // and the inRange rule should stand. This is now the ONLY thing keeping
  // year-old creatives out of every month view.
  const carded = new Set(ads.map((a) => cardKey(a.campaign, a.ad)));
  // Ranked and capped, not just filtered. These carry no windowed numbers, so
  // there is nothing downstream to order them by — without an explicit sort
  // they arrive in Object.entries order, i.e. whatever the sheet happened to
  // list first, and without the cap they bury the cards that do have numbers.
  const archive = Object.entries(raw.fbAssetsIndexed)
    .filter(
      ([k]) => !carded.has(k) && !adSpanAll.has(k) && !!raw.fbAssets[k],
    )
    .sort(
      ([a], [b]) =>
        (raw.fbAssets[b]?.impressions ?? 0) - (raw.fbAssets[a]?.impressions ?? 0),
    )
    .slice(0, TOP_ARCHIVE_ADS);
  for (const [k, { campaign, ad }] of archive) {
    const assets = raw.fbAssets[k];
    if (!assets) continue;
    topAds.push({
      account: assets.account,
      campaign,
      ad,
      status: assets.status,
      url: assets.url,
      destUrl: assets.destUrl,
      body: assets.body,
      title: assets.title,
      thumb: assets.thumb,
      image: assets.image,
      noWindowData: true,
      previews: raw.fbPreviews[k]?.length ? raw.fbPreviews[k] : undefined,
      impressions: 0,
      clicks: 0,
      cost: 0,
      leads: 0,
      cpl: 0,
      ctr: 0,
      crmLeads: 0,
      scheduled: 0,
      held: 0,
      costPerSched: 0,
      costPerHeld: 0,
      ageDays: 0,
      ctrEarly: 0,
      ctrRecent: 0,
      fatigued: false,
      fatigueReason: "",
      isWinner: false,
      daily: [],
      history: null,
    });
  }
  if (hist && hist.months.length) {
    const { byMonth, pre } = buildCostHistory(raw, startIso);
    for (const a of topAds) {
      // Cost history is per CARD (this variant's own spend); the meetings
      // buckets are only keyed at the group level, and only the group's
      // meetings owner may render them — same rule as the card face above.
      const key = cardKey(a.campaign, a.ad);
      const mKey = meetingsOwner.has(a) ? adKey(a.campaign, a.ad) : null;
      const cm = byMonth.get(key);
      const rows: ReportAdHistoryMonth[] = [];
      const total = { cost: 0, leads: 0, scheduled: 0, held: 0 };
      for (const mon of hist.months) {
        const c = cm?.get(mon);
        const v = mKey ? meet.creative.get(`h:${mon}|${mKey}`) : undefined;
        if (!c && !v) continue; // a month this ad didn't exist in
        const row = {
          month: mon,
          cost: c?.cost ?? 0,
          leads: c?.leads ?? 0,
          scheduled: v?.scheduled ?? 0,
          held: v?.held ?? 0,
        };
        rows.push(row);
        total.cost += row.cost;
        total.leads += row.leads;
        total.scheduled += row.scheduled;
        total.held += row.held;
      }
      const p = pre.get(key);
      const pv = mKey ? meet.creative.get(`pre|${mKey}`) : undefined;
      const before = {
        cost: p?.cost ?? 0,
        leads: p?.leads ?? 0,
        scheduled: pv?.scheduled ?? 0,
        held: pv?.held ?? 0,
      };
      // Only worth a panel when it says something the card face doesn't:
      // more than one month of life, or any activity before this window.
      a.history =
        rows.length > 1 || before.cost > 0 || before.scheduled > 0
          ? { since: hist.from, months: rows, before, total }
          : null;
    }
  }

  return {
    fb: {
      cost: totalCost,
      leads: totalLeads,
      cpl: totalLeads > 0 ? totalCost / totalLeads : 0,
      adCount: activeCount,
      topAds,
      topAdSets,
    },
    google: {
      clicks: googleClicks,
      conversions: googleConversions,
      topKeywords,
      ads: raw.gAds,
      dgAds,
    },
  };
}

/* -------------------------------- entrypoint ------------------------------ */

/** Keys `פרוייקט` → `CRM` column (the warehouse project_name the
 *  meetings lib keys off). Falls back to the hub project name (legacy
 *  `getProjectToCrmMap_()[name] || name`). */
async function resolveCrmName(
  subjectEmail: string,
  projectName: string,
): Promise<string> {
  try {
    const { headers, rows } = await readKeysCached(subjectEmail);
    const iProj = headers.indexOf("פרוייקט");
    const iCrm = headers.indexOf("CRM");
    if (iProj < 0 || iCrm < 0) return projectName;
    const target = clean(projectName);
    for (const r of rows) {
      if (clean((r as unknown[])[iProj]) !== target) continue;
      const crm = String((r as unknown[])[iCrm] ?? "").trim();
      return crm || projectName;
    }
  } catch {
    /* fall through */
  }
  return projectName;
}

export const getProjectCreatives = cache(
  async (
    subjectEmail: string,
    projectName: string,
    slug: string,
    window: ReportWindow,
  ): Promise<ReportCreatives | null> => {
    try {
      const raw = await readProjectCreativeRaw(subjectEmail, slug);
      const months = monthsInRange(window.startIso, window.endIso);
      let lookups = emptyLookups();
      let crmName = projectName;
      const hist = adMetricsSpan(raw);
      if (months.length) {
        crmName = await resolveCrmName(subjectEmail, projectName);
        try {
          const live = await getProjectMeetingsLiveWindows(crmName, [
            ...windowBuckets(months, window.startIso, window.endIso),
            // Whole-month history buckets for the card hover, namespaced so
            // they can never collide with a bare YYYY-MM window bucket. Free:
            // the full lead + meeting history is already resident (both
            // fetches are date-unfiltered), so these are extra in-memory
            // passes, not extra round trips.
            ...hist.months.map((m) => ({ key: `h:${m}`, ...monthWindow(m) })),
            // Exact "before this report" bucket, floored at the ad-metrics
            // span so `before` and `total` stay on the same clock as cost.
            ...(hist.from && window.startIso && hist.from < window.startIso
              ? [{ key: "pre", from: hist.from, toExcl: window.startIso }]
              : []),
          ]);
          lookups = buildMeetLookups(live.results, crmName);
        } catch {
          /* meetings are an enrichment — cards render without them */
        }
      }
      const out = aggregateCreatives(
        raw,
        window.startIso,
        window.endIso,
        lookups,
        months,
        crmName,
        hist,
      );
      const has =
        out.fb.topAds.length > 0 ||
        out.fb.cost > 0 ||
        out.google.topKeywords.length > 0 ||
        out.google.ads.length > 0;
      return has ? out : null;
    } catch {
      return null;
    }
  },
);
