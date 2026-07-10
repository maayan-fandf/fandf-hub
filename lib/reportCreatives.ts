import { cache } from "react";
import { unstable_cache, revalidateTag } from "next/cache";
import { sheetsClient } from "@/lib/sa";
import { buildMatchMap, matchSlug } from "@/lib/campaignMatch";
import { readKeysCached } from "@/lib/keys";
import { normAdName } from "@/lib/fbCreatives";
import {
  getProjectMeetingsLiveMulti,
  type ProjectMeetings,
} from "@/lib/fbCreativeMeetingsExport";
import type {
  ReportAdDaily,
  ReportCreatives,
  ReportFbAd,
  ReportFbAdSet,
  ReportGoogleAd,
  ReportKeyword,
  ReportWindow,
} from "@/lib/reportShared";

/**
 * Server data layer for the native קריאייטיבים tab — reads the same
 * Supermetrics creative workbook the Apps Script CREATIVE_MAP reads
 * (SHEET_ID_CREATIVES: facebook-ads-metrics / facebook-ads-assets links /
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

const TOP_ADS = 8;
const TOP_ADS_HISTORICAL = 3;
const WINNER_MIN_LEADS = 3;
const TOP_KEYWORDS = 10;
const TOP_ADSETS = 5;

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
};

async function fetchProjectCreativeRaw(
  subjectEmail: string,
  slug: string,
): Promise<ProjectCreativeRaw> {
  const out: ProjectCreativeRaw = {
    fbAds: [],
    fbAssets: {},
    fbAdSets: [],
    gKeywords: [],
    gAds: [],
  };
  const matchMap = await buildMatchMap(subjectEmail);
  const slugLower = slug.toLowerCase();
  const mine = (campaign: string) =>
    !!campaign && matchSlug(campaign, matchMap) === slugLower;

  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_CREATIVES");
  const bg = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: ssId,
    ranges: [
      "'facebook-ads-metrics'!A1:N",
      "'facebook-ads-assets links'!A1:Z",
      "'Facebook-adsets'!A1:N",
      "'מילות חיפוש גוגל'!A1:N",
      // NB the RSA-assets tab is literally named "גוגל " WITH a trailing
      // space (the legacy getSheetByNameLoose_ absorbed it silently).
      "'גוגל '!A1:AZ",
    ],
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const [vMetrics, vAssets, vAdsets, vKw, vGAds] = (
    bg.data.valueRanges ?? []
  ).map((r) => (r?.values ?? []) as unknown[][]);

  // facebook-ads-assets links → (campaign|ad).lc lookup, first row wins.
  if (vAssets.length > 1) {
    const h = vAssets[0].map(clean);
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
    if (iCamp >= 0 && iAd >= 0) {
      for (let r = 1; r < vAssets.length; r++) {
        const row = vAssets[r];
        const camp = String(row[iCamp] ?? "").trim();
        const ad = adNameOf(row[iAd]);
        if (!camp || !ad || !mine(camp)) continue;
        const k = `${camp}|${ad}`.toLowerCase();
        if (out.fbAssets[k]) continue; // first row wins
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
        };
      }
    }
  }

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

function buildMeetLookups(
  results: Array<{ month: string } & ProjectMeetings>,
  crmName: string,
): MeetLookups {
  const out = emptyLookups();
  const projLc = clean(crmName).toLowerCase();
  for (const r of results) {
    for (const c of r.creative) {
      out.creative.set(
        `${r.month}|${c.campaign}|${normAdName(c.ad)}`.toLowerCase(),
        { leads: c.leads || 0, scheduled: c.scheduled || 0, held: c.held || 0 },
      );
    }
    for (const a of r.audience) {
      out.audience.set(`${r.month}|${projLc}|${clean(a.audience).toLowerCase()}`, {
        leads: a.leads || 0,
        scheduled: a.scheduled || 0,
        held: a.held || 0,
      });
    }
    for (const k of r.keyword) {
      out.keyword.set(`${r.month}|${projLc}|${clean(k.keyword).toLowerCase()}`, {
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

function aggregateCreatives(
  raw: ProjectCreativeRaw,
  startIso: string,
  endIso: string,
  meet: MeetLookups,
  months: string[],
  crmName: string,
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
    const k = `${r.campaign}|${r.ad}`.toLowerCase();
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

  const ads: ReportFbAd[] = [...adAgg.entries()].map(([k, a]) => {
    const assets = raw.fbAssets[k];
    // Fatigue (legacy 3791-3827): calendar-span age, early-vs-recent CTR.
    const daily = [...a.daily].sort((x, y) => (x.date < y.date ? -1 : 1));
    const first = daily[0]?.date ?? "";
    const last = daily[daily.length - 1]?.date ?? "";
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
    let fatigued = false;
    let fatigueReason: ReportFbAd["fatigueReason"] = "";
    if (ageDays >= 30 && ctrDropPct >= 0.25 && ctrEarly >= 0.003 && rImp >= 500) {
      fatigued = true;
      fatigueReason = "declining";
    } else if (ageDays >= 45) {
      fatigued = true;
      fatigueReason = "long";
    }
    const mtg = sumOverMonths(
      meet.creative,
      months,
      `${a.campaign}|${normAdName(a.ad)}`.toLowerCase(),
    );
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

  return {
    fb: {
      cost: totalCost,
      leads: totalLeads,
      cpl: totalLeads > 0 ? totalCost / totalLeads : 0,
      adCount: activeCount,
      topAds: ads.slice(0, sliceCap),
      topAdSets,
    },
    google: {
      clicks: googleClicks,
      conversions: googleConversions,
      topKeywords,
      ads: raw.gAds,
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
      if (months.length) {
        crmName = await resolveCrmName(subjectEmail, projectName);
        try {
          const live = await getProjectMeetingsLiveMulti(crmName, months);
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
