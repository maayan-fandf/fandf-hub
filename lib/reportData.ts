import { cache } from "react";
import { unstable_cache, revalidateTag } from "next/cache";
import { sheetsClient } from "@/lib/sa";
import { buildMatchMap, matchSlug, getProjectSlug } from "@/lib/campaignMatch";
import {
  getAllClientsCurrentForProject,
  getAllClientsMonthlyForProject,
  getProjectMonthlyTotals,
  getProjectMonthlyRaw,
  type AllClientsRow,
} from "@/lib/allClients";
import { getProjectLandingUrl } from "@/lib/projectsDirect";
import { classifyChannel } from "@/lib/budgetTypes";
import { getBudgetMaster } from "@/lib/budgetMaster";
import { getCampaignBudgets, type CampaignBudgetItem } from "@/lib/platformDailyBudget";
import { getDailySpend7d } from "@/lib/platformDailySpend";
import { getProjectCreatives } from "@/lib/reportCreatives";
import {
  REPORT_PLATS,
  emptyAdPlatform,
  sumAdPlatform,
  computePacing,
  computeForecast,
  computePrevFunnel,
  detectAnomalies,
  type AdPlatform,
  type DailyPoint,
  type DatedSourceInfo,
  type MonthlyRow,
  type PlatCampaign,
  monthSegments,
  type ProjectReportData,
  type RangeBasis,
  type ReportChannel,
  type ReportPlat,
  type ReportSubCampaign,
  type ReportWindow,
} from "@/lib/reportShared";
import {
  buildAttributor,
  getDatedChannelMeetings,
} from "@/lib/datedChannelMeetings";
import { getCrmFunnelForProject } from "@/lib/crmData";

/**
 * Server data layer for the NATIVE project report (phase 1) — reads the
 * same standardized platform-daily file the Apps Script dashboard reads
 * (SHEET_ID_PLATFORM_DAILY, tabs GADS2/FB/Taboola2/OB2) but with the FULL
 * column set (impressions/clicks/leads, not just cost like
 * platformDailySpend). Aggregation + window semantics mirror the Apps
 * Script exactly (Code.js `aggregatePlatformForProject_` :7429,
 * `_getPlatformDataMapUncached_` :6932, the prev-window driver :2478) so
 * the native report and the legacy iframe agree while both run.
 */

const TABS: Record<ReportPlat, string> = {
  google: "GADS2",
  facebook: "FB",
  taboola: "Taboola2",
  outbrain: "OB2",
};

const CACHE_TAG = "reportPlatformDaily";
const TTL_SECONDS = 900; // 15 min — the feed refreshes daily via Supermetrics

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const num = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** Case-insensitive first-match column lookup (legacy `headerIndex_`). */
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

/** Today (Asia/Jerusalem) as YYYY-MM-DD — the prev-window anchor. */
function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(),
  );
}

/** Shift a YYYY-MM-DD date by `days` (UTC date-only arithmetic). */
function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function daysBetween(aIso: string, bIso: string): number {
  const [ay, am, ad] = aIso.split("-").map(Number);
  const [by, bm, bd] = bIso.split("-").map(Number);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000,
  );
}

type RawDailyRow = {
  date: string;
  campaign: string;
  cost: number;
  imp: number;
  clk: number;
  leads: number;
};

type ProjectPlatformRows = Record<ReportPlat, RawDailyRow[]>;

/**
 * Read all four platform tabs and keep only the rows whose campaign name
 * matches THIS project's Keys `campaign ID` patterns. Column resolution
 * mirrors the legacy `readTab` (Code.js:6972): leads = `all leads` when
 * the column exists, else `Conversions` (Google schema), else
 * `Website leads` + `On-Facebook leads`.
 */
async function fetchProjectPlatformRows(
  subjectEmail: string,
  slug: string,
): Promise<ProjectPlatformRows> {
  const out: ProjectPlatformRows = {
    google: [],
    facebook: [],
    taboola: [],
    outbrain: [],
  };
  const matchMap = await buildMatchMap(subjectEmail);
  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_PLATFORM_DAILY");
  const bg = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: ssId,
    ranges: REPORT_PLATS.map((p) => `'${TABS[p]}'!A1:N`),
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const vrs = bg.data.valueRanges ?? [];
  const slugLower = slug.toLowerCase();

  REPORT_PLATS.forEach((plat, idx) => {
    const rows = (vrs[idx]?.values ?? []) as unknown[][];
    if (rows.length < 2) return;
    const hdr = rows[0].map(clean);
    const iDate = findCol(hdr, ["Date"]);
    const iCamp = findCol(hdr, ["Campaign name"]);
    const iCost = findCol(hdr, ["Cost"]);
    const iImp = findCol(hdr, ["Impressions"]);
    const iClk = findCol(hdr, ["Link clicks", "Clicks"]);
    const iWLd = findCol(hdr, ["Website leads"]);
    const iFLd = findCol(hdr, ["On-Facebook leads", "On Facebook leads"]);
    const iAllLd = findCol(hdr, ["all leads", "All leads"]);
    const iConv = findCol(hdr, ["Conversions"]);
    if (iDate < 0 || iCamp < 0 || iCost < 0) return;
    for (let r = 1; r < rows.length; r++) {
      const camp = clean(rows[r][iCamp]);
      if (!camp) continue;
      if (matchSlug(camp, matchMap) !== slugLower) continue;
      const date = parseDate(rows[r][iDate]);
      if (!date) continue;
      let leads: number;
      if (iAllLd >= 0) leads = num(rows[r][iAllLd]);
      else if (iConv >= 0) leads = num(rows[r][iConv]);
      else leads = num(iWLd >= 0 ? rows[r][iWLd] : 0) + num(iFLd >= 0 ? rows[r][iFLd] : 0);
      out[plat].push({
        date,
        campaign: camp,
        cost: num(rows[r][iCost]),
        imp: iImp >= 0 ? num(rows[r][iImp]) : 0,
        clk: iClk >= 0 ? num(rows[r][iClk]) : 0,
        leads,
      });
    }
  });
  return out;
}

const fetchProjectPlatformRowsCrossRequest = unstable_cache(
  fetchProjectPlatformRows,
  ["reportPlatformDaily"],
  { revalidate: TTL_SECONDS, tags: [CACHE_TAG] },
);

const readProjectPlatformRows = cache(
  (subjectEmail: string, slug: string) =>
    fetchProjectPlatformRowsCrossRequest(subjectEmail, slug),
);

export function invalidateReportPlatformCache(): void {
  revalidateTag(CACHE_TAG);
}

/**
 * Legacy `aggregatePlatformForProject_` (Code.js:7429): inclusive string
 * compare on ISO dates; empty bounds pass everything. Google's leads sum
 * into `conversions`; FB/TB/OB into `leads`.
 */
function aggregateWindow(
  rows: ProjectPlatformRows,
  startIso: string,
  endIso: string,
): AdPlatform {
  const out = emptyAdPlatform();
  const inRange = (d: string) => {
    if (!d) return false;
    if (startIso && d < startIso) return false;
    if (endIso && d > endIso) return false;
    return true;
  };
  for (const plat of REPORT_PLATS) {
    const agg = new Map<string, PlatCampaign>();
    const o = out[plat];
    for (const r of rows[plat]) {
      if (!inRange(r.date)) continue;
      o.impressions += r.imp;
      o.clicks += r.clk;
      o.cost += r.cost;
      if (plat === "google") o.conversions += r.leads;
      else o.leads += r.leads;
      const k = r.campaign || "—";
      const c = agg.get(k) ?? { name: k, imp: 0, clk: 0, cost: 0, leads: 0 };
      c.imp += r.imp;
      c.clk += r.clk;
      c.cost += r.cost;
      c.leads += r.leads;
      agg.set(k, c);
    }
    o.campaigns = [...agg.values()];
  }
  return out;
}

/** Classify a Google campaign as Discovery-family (Discovery / PMax /
 *  Demand-Gen / Display) vs plain Search, from its daily-feed name. The
 *  Discovery family carries one of these tokens (verified across the
 *  portfolio: `..._discovery`, `Google-discovery`, `pmax`, `DemandGen`,
 *  `display`); everything else Google is Search (`_GS`/`gs`, brand /
 *  generic / competitors / business). Lets the ערוצים trend popover show
 *  a REAL per-channel daily series for google-search vs google-discovery
 *  instead of the combined platform series (owner-reported 2026-07-19:
 *  both google rows showed the same aggregated trend). */
function googleCampaignKind(campaign: string): "discovery" | "search" {
  return /discover|p-?max|demand[\s-]?gen|dgen|display/i.test(campaign)
    ? "discovery"
    : "search";
}

/** Google daily split by campaign kind — same by-date aggregation as
 *  dailySeries, partitioned into search vs discovery. Empty array for a
 *  kind with no matching campaigns in the window. */
function googleDailyByKind(googleRows: RawDailyRow[]): {
  search: DailyPoint[];
  discovery: DailyPoint[];
} {
  const buckets: Record<"discovery" | "search", Map<string, DailyPoint>> = {
    discovery: new Map(),
    search: new Map(),
  };
  for (const r of googleRows) {
    const m = buckets[googleCampaignKind(r.campaign)];
    const p =
      m.get(r.date) ??
      { date: r.date, cost: 0, leads: 0, impressions: 0, clicks: 0 };
    p.cost += r.cost;
    p.leads += r.leads;
    p.impressions += r.imp;
    p.clicks += r.clk;
    m.set(r.date, p);
  }
  const toSeries = (m: Map<string, DailyPoint>) =>
    [...m.keys()].sort().map((k) => m.get(k)!);
  return { search: toSeries(buckets.search), discovery: toSeries(buckets.discovery) };
}

/** Legacy `aggregateDailySeries_` (Code.js:7414) — per-platform, by date. */
function dailySeries(rows: ProjectPlatformRows): Record<ReportPlat, DailyPoint[]> {
  const out = {} as Record<ReportPlat, DailyPoint[]>;
  for (const plat of REPORT_PLATS) {
    const byDate = new Map<string, DailyPoint>();
    for (const r of rows[plat]) {
      const p =
        byDate.get(r.date) ??
        { date: r.date, cost: 0, leads: 0, impressions: 0, clicks: 0 };
      p.cost += r.cost;
      p.leads += r.leads;
      p.impressions += r.imp;
      p.clicks += r.clk;
      byDate.set(r.date, p);
    }
    out[plat] = [...byDate.keys()].sort().map((k) => byDate.get(k)!);
  }
  return out;
}

/**
 * Previous window = same-length block ending the day before the current
 * window starts, sized to the ELAPSED portion when the flight is still
 * running (legacy driver, Code.js:2489-2510). NOT the previous calendar
 * month.
 */
function prevWindowOf(win: ReportWindow): ReportWindow | null {
  if (!win.startIso || !win.endIso) return null;
  const today = todayIso();
  const effectiveEnd = win.endIso > today ? today : win.endIso;
  const durationDays = Math.max(1, daysBetween(win.startIso, effectiveEnd));
  const prevEnd = shiftIso(win.startIso, -1);
  const prevStart = shiftIso(prevEnd, -durationDays);
  return { startIso: prevStart, endIso: prevEnd };
}

function lastDayOfMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m, 0));
  return dt.toISOString().slice(0, 10);
}

/**
 * The row's סוג-קמפיין tokens — one set per sub-campaign, all of which must
 * appear in a platform campaign's name for it to belong to this row. `+`/`-`
 * stay inside tokens so "60+" won't substring-match "45-60".
 *
 * Shared by the configured-budget attribution and the per-row daily series
 * BY DESIGN: the trend a row shows has to cover exactly the campaigns whose
 * budget that row reports, or the popover and the קצב יומי cell would be
 * describing different things.
 */
function campaignTokenSets(subs: { name: string }[]): string[][] {
  return subs
    .map((s) =>
      s.name
        .toLowerCase()
        .split(/[^a-z0-9֐-׿+\-]+/)
        .filter((t) => t.length >= 2),
    )
    .filter((ts) => ts.length);
}

/** Daily series for the platform rows whose campaign matches any token set —
 *  i.e. this channel row's own campaigns. Null when nothing matched, so the
 *  client can fall back to the platform series rather than draw an empty
 *  chart. */
function channelDailySeries(
  platRows: RawDailyRow[],
  tokenSets: string[][],
): DailyPoint[] | undefined {
  if (!tokenSets.length) return undefined;
  const byDate = new Map<string, DailyPoint>();
  let matched = 0;
  for (const r of platRows) {
    const nameLower = r.campaign.toLowerCase();
    if (!tokenSets.some((ts) => ts.every((t) => nameLower.includes(t)))) continue;
    matched++;
    const p =
      byDate.get(r.date) ??
      { date: r.date, cost: 0, leads: 0, impressions: 0, clicks: 0 };
    p.cost += r.cost;
    p.leads += r.leads;
    p.impressions += r.imp;
    p.clicks += r.clk;
    byDate.set(r.date, p);
  }
  if (!matched) return undefined;
  return [...byDate.keys()].sort().map((k) => byDate.get(k)!);
}

/**
 * Enrich ALL CLIENTS channel rows into the ערוצים tab's rows. The
 * configured-daily attribution ports lib/budgetMaster's סוג-token loop
 * (tokens must ALL appear in the campaign name, platform-scoped;
 * `+`/`-` stay inside tokens so "60+" won't substring-match "45-60").
 * Channels without tokens get no configured budget (legacy leaves them
 * undecorated); the platform 7-day average is attached only when the
 * row is its platform's sole channel — otherwise a platform-level
 * average is meaningless per-row.
 */
function buildReportChannels(
  rows: AllClientsRow[],
  slug: string,
  projCampaigns: CampaignBudgetItem[],
  avg7dByPlat: Record<string, number> | undefined,
  enrich: boolean,
  platformRows: ProjectPlatformRows,
): ReportChannel[] {
  const platCount = new Map<string, number>();
  const plats = rows.map((r) => {
    const p = classifyChannel(r.channel);
    platCount.set(p, (platCount.get(p) ?? 0) + 1);
    return p;
  });
  return rows.map((r, i) => {
    const platform = plats[i];
    const subs = r.subCampaigns ?? [];
    let configuredDaily: number | null = null;
    let campaignStatus: ReportChannel["campaignStatus"] = "none";
    const isAdPlatform = platform === "google" || platform === "facebook";
    const tokenSets = isAdPlatform ? campaignTokenSets(subs) : [];
    // Per-row trend series. Computed outside the `enrich` gate because the
    // popover renders in month mode too, where enrichment is off.
    const daily = isAdPlatform
      ? channelDailySeries(
          platformRows[platform as "google" | "facebook"],
          tokenSets,
        )
      : undefined;
    if (enrich && isAdPlatform) {
      if (tokenSets.length) {
        let sum = 0;
        let activeCount = 0;
        let pausedCount = 0;
        for (const c of projCampaigns) {
          if (c.platform !== platform) continue;
          if (!tokenSets.some((ts) => ts.every((t) => c.nameLower.includes(t))))
            continue;
          if (c.active) {
            sum += c.dailyBudget;
            activeCount++;
          } else pausedCount++;
        }
        if (activeCount || pausedCount) {
          configuredDaily = sum;
          campaignStatus =
            activeCount && pausedCount
              ? "mixed"
              : activeCount
                ? "active"
                : "paused";
        }
      }
    }
    const soleOfPlatform = platCount.get(platform) === 1;
    const avg7d =
      enrich && soleOfPlatform && avg7dByPlat && platform in avg7dByPlat
        ? (avg7dByPlat[platform] ?? 0)
        : null;
    return {
      channel: r.channel,
      platform,
      budget: r.budget,
      spend: r.spend,
      leads: r.leads,
      pixelLeads: r.pixelLeads,
      scheduled: r.scheduled,
      meetings: r.meetings,
      dailyRate: r.dailyRate,
      startIso: r.startIso,
      endIso: r.endIso,
      costPerLead: r.leads > 0 ? r.spend / r.leads : 0,
      costPerScheduled: r.scheduled > 0 ? r.spend / r.scheduled : 0,
      costPerMeeting: r.meetings > 0 ? r.spend / r.meetings : 0,
      subCampaigns: subs,
      configuredDaily,
      campaignStatus,
      avg7d,
      daily,
    };
  });
}

/* ─── Free-range channel rows ─────────────────────────────────────── */

/** Platforms with a real daily-spend feed (the GADS2/FB/Taboola2/OB2
 *  tabs). A channel row on one of these gets its spend SUMMED from the
 *  daily rows over the exact range instead of a pro-rated share of a
 *  monthly figure — the owner's spec, 2026-08-25: "for google facebook
 *  taboola outbrain you do have a daily spend. so use this. and for other
 *  media channel, assess by number of days relative to the spend found on
 *  all clients." */
const DAILY_SPEND_PLATS = new Set<string>(REPORT_PLATS);

/** A row under construction while the range's months are folded together. */
type RangeAccum = {
  channel: string;
  budget: number;
  spend: number;
  /** Pro-rated ALL CLIENTS spend per "YYYY-MM" of the range. Kept split
   *  because the daily feed is trusted or rejected one MONTH at a time —
   *  see the coverage test in buildRangeReportChannels. */
  spendByMonth: Map<string, number>;
  leads: number;
  pixelLeads: number | undefined;
  scheduled: number;
  meetings: number;
  startIso: string;
  endIso: string;
  subs: Map<string, ReportSubCampaign>;
};

/**
 * Build the ערוצים rows for a FREE date range.
 *
 * ALL CLIENTS' finest grain is one calendar month, so a range that starts
 * mid-month cannot be read off it directly. Three sources are combined,
 * each used for what it alone can answer:
 *
 *  1. SPEND, programmatic — summed from the platform daily feed over the
 *     exact range, matched to the row by its own סוג-קמפיין tokens (the
 *     same matcher the קצב יומי cell and the trend popover already use, so
 *     a row's spend covers exactly the campaigns its other cells describe).
 *     Real money, no estimation — where the feed can see it. It is trusted
 *     one MONTH at a time, because it cannot always: לוריא's July generic
 *     spend lives on `Tzarfati_jerusalem_generic_2024-10-09_GS`, a campaign
 *     whose name carries no `luria` slug and whose cost ALL CLIENTS splits
 *     50/50 with another project. Name-matching finds nothing there, and a
 *     row-level sum would have quietly reported ₪4,451 for a channel that
 *     spent ₪13,020. So a month the feed shows NOTHING for, while ALL
 *     CLIENTS says the row spent, falls back to (2). A month the feed shows
 *     anything for is believed in full — the test is coverage, not
 *     magnitude, so a campaign that genuinely ramped late still reports its
 *     real, small number instead of being second-guessed.
 *
 *  2. SPEND, everything else (yad2 / כתבה / מדלן / phone …) — pro-rated
 *     from ALL CLIENTS. Each row is spread evenly across its OWN
 *     [התחלה, min(סיום, today)] span and the range takes the overlapping
 *     fraction, so a channel that only started on the 13th is not charged
 *     for the whole month and days that have not happened yet contribute
 *     nothing. For the in-flight month the חודשי row is a stub (לוריא
 *     2026-08 carries 3 rows and no leads at all while the `current` rows
 *     carry 11), so `current` is used there instead.
 *
 *  3. OUTCOMES — the CRM funnel windowed on the range. Pro-rating these
 *     would assume leads arrive uniformly inside a month, which they do
 *     not, and would print fractions of a lead. The CRM is the only source
 *     that can answer "leads created between the 4th and the 19th", and
 *     ALL CLIENTS' monthly lead counts are themselves derived from it, so
 *     this is the faithful generalisation of what the other modes show
 *     rather than a different measure.
 *
 * Row-grain attribution for (3) reuses buildAttributor: matching on the
 * canonical channel alone would hand Google-search-brand, -generic and
 * -competitors the same bucket and triple-count it.
 */
async function buildRangeReportChannels(args: {
  subjectEmail: string;
  project: string;
  company: string;
  window: ReportWindow;
  platformRows: ProjectPlatformRows;
  today: string;
}): Promise<{ channels: ReportChannel[]; basis: RangeBasis | null }> {
  const { subjectEmail, project, company, window, platformRows, today } = args;
  const segs = monthSegments(window.startIso, window.endIso);
  if (!segs.length) return { channels: [], basis: null };

  // The `current` rows describe the flight window as a whole, so their
  // spend has to be spread over the days that have actually elapsed.
  const currentRows = await getAllClientsCurrentForProject({
    subjectEmail,
    project,
  }).catch(() => [] as AllClientsRow[]);
  let flightStart = "";
  let flightEnd = "";
  for (const r of currentRows) {
    if (r.startIso && (!flightStart || r.startIso < flightStart))
      flightStart = r.startIso;
    if (r.endIso && r.endIso > flightEnd) flightEnd = r.endIso;
  }
  const flightElapsedEnd = flightEnd && flightEnd > today ? today : flightEnd;
  const flightDays =
    flightStart && flightElapsedEnd && flightElapsedEnd >= flightStart
      ? daysBetween(flightStart, flightElapsedEnd) + 1
      : 0;

  const acc = new Map<string, RangeAccum>();
  /**
   * Merge key for folding the same channel across months.
   *
   * Punctuation is stripped because ALL CLIENTS spells a channel however
   * it was typed that month: לוריא's DV360 row is `dv_360` in חודשי and
   * `dv360` in current, and keying on the literal string split one channel
   * into two rows of the same table. Only separators go — the key still
   * distinguishes google-search-brand from google-search-generic, and
   * facebook from Facebook-leadgen, which are genuinely different rows.
   */
  const mergeKey = (name: string) =>
    name.toLowerCase().replace(/[\s_-]+/g, "").trim();
  const add = (r: AllClientsRow, factor: number, month: string) => {
    if (!(factor > 0)) return;
    const key = mergeKey(r.channel);
    if (!key) return;
    let a = acc.get(key);
    if (!a) {
      a = {
        channel: r.channel.trim(),
        budget: 0,
        spend: 0,
        spendByMonth: new Map(),
        leads: 0,
        pixelLeads: undefined,
        scheduled: 0,
        meetings: 0,
        startIso: "",
        endIso: "",
        subs: new Map(),
      };
      acc.set(key, a);
    }
    a.budget += r.budget * factor;
    a.spend += r.spend * factor;
    a.spendByMonth.set(month, (a.spendByMonth.get(month) ?? 0) + r.spend * factor);
    a.leads += r.leads * factor;
    a.scheduled += r.scheduled * factor;
    a.meetings += r.meetings * factor;
    // Same blank-vs-measured rule as everywhere else: only a real reading
    // contributes, so a project with no pixel column stays undefined.
    if (r.pixelLeads != null)
      a.pixelLeads = (a.pixelLeads ?? 0) + r.pixelLeads * factor;
    if (r.startIso && (!a.startIso || r.startIso < a.startIso))
      a.startIso = r.startIso;
    if (r.endIso && r.endIso > a.endIso) a.endIso = r.endIso;
    for (const s of r.subCampaigns ?? []) {
      const nk = s.name.toLowerCase().trim();
      if (!nk) continue;
      const prev = a.subs.get(nk);
      if (prev) {
        prev.spend += s.spend * factor;
        prev.budget += s.budget * factor;
        prev.leads += s.leads * factor;
        prev.scheduled += s.scheduled * factor;
        prev.meetings += s.meetings * factor;
      } else {
        a.subs.set(nk, {
          name: s.name,
          spend: s.spend * factor,
          budget: s.budget * factor,
          leads: s.leads * factor,
          scheduled: s.scheduled * factor,
          meetings: s.meetings * factor,
        });
      }
    }
  };

  /**
   * What fraction of ONE row's spend belongs to this segment.
   *
   * A row's עלות covers the row's own [התחלה, סיום] span, not necessarily
   * the calendar month, so the row — not the month — is the denominator.
   * That is what keeps לוריא's dv360 (a flight that starts on the 13th)
   * from being charged as though it ran all month. `today` caps the span:
   * a flight still running has only spent over the days that have elapsed,
   * and a range reaching into the future must not invent the rest.
   * Falls back to the segment's own bounds when the row carries no dates.
   */
  const factorFor = (r: AllClientsRow, seg: (typeof segs)[number]): number => {
    const rowStart = r.startIso || seg.startIso;
    const rowEnd = r.endIso || seg.endIso;
    const effEnd = rowEnd > today ? today : rowEnd;
    if (!rowStart || !effEnd || effEnd < rowStart) return 0;
    const denom = daysBetween(rowStart, effEnd) + 1;
    if (denom <= 0) return 0;
    const oStart = seg.startIso > rowStart ? seg.startIso : rowStart;
    const oEnd = seg.endIso < effEnd ? seg.endIso : effEnd;
    if (oEnd < oStart) return 0;
    return (daysBetween(oStart, oEnd) + 1) / denom;
  };

  for (const seg of segs) {
    // A closed month is finalised in חודשי; the in-progress one is not (its
    // חודשי row is a plan stub), so the live flight rows win there. Either
    // source falls back to the other when it has nothing for the segment,
    // so a mid-flight start doesn't silently drop the days before it.
    const monthClosed = seg.month < today.slice(0, 7);
    const monthly = await getAllClientsMonthlyForProject({
      subjectEmail,
      project,
      yearMonth: seg.month,
    }).catch(() => [] as AllClientsRow[]);
    const preferCurrent = !monthClosed && currentRows.length > 0;
    const primary = preferCurrent ? currentRows : monthly;
    const backup = preferCurrent ? monthly : currentRows;
    let used = false;
    for (const r of primary) {
      const f = factorFor(r, seg);
      if (f > 0) {
        add(r, f, seg.month);
        used = true;
      }
    }
    if (!used) {
      for (const r of backup) add(r, factorFor(r, seg), seg.month);
    }
  }
  if (!acc.size) return { channels: [], basis: null };

  // ── (1) real spend for the platforms that have a daily feed ──────────
  const inWindow = (d: string) =>
    !!d && d >= window.startIso && d <= window.endIso;
  const winRows = {} as ProjectPlatformRows;
  for (const p of REPORT_PLATS) winRows[p] = platformRows[p].filter((r) => inWindow(r.date));

  const rows = [...acc.values()];
  const platOf = new Map<string, string>();
  const platCount = new Map<string, number>();
  for (const a of rows) {
    const p = classifyChannel(a.channel);
    platOf.set(a.channel, p);
    platCount.set(p, (platCount.get(p) ?? 0) + 1);
  }

  const realSpend: string[] = [];
  const prorated: string[] = [];
  const rangeDays = Math.max(1, daysBetween(window.startIso, window.endIso) + 1);
  const built = rows.map((a) => {
    const platform = platOf.get(a.channel) ?? "other";
    const subs = [...a.subs.values()];
    let spend = a.spend;
    let daily: DailyPoint[] | undefined;
    if (DAILY_SPEND_PLATS.has(platform)) {
      const platRows = winRows[platform as ReportPlat];
      const series = channelDailySeries(platRows, campaignTokenSets(subs));
      if (series) {
        daily = series;
      } else if (platCount.get(platform) === 1 && platRows.length) {
        // No סוג tokens to match on, but this row is its platform's only
        // one — the whole platform's spend in the range IS this row's.
        const byDate = new Map<string, DailyPoint>();
        for (const r of platRows) {
          const p = byDate.get(r.date) ?? {
            date: r.date,
            cost: 0,
            leads: 0,
            impressions: 0,
            clicks: 0,
          };
          p.cost += r.cost;
          p.leads += r.leads;
          p.impressions += r.imp;
          p.clicks += r.clk;
          byDate.set(r.date, p);
        }
        daily = [...byDate.keys()].sort().map((k) => byDate.get(k)!);
      }
    }
    if (daily) {
      // Trust the feed one month at a time. A month it shows nothing for,
      // while ALL CLIENTS says this row spent, is a month whose campaigns
      // the feed cannot attribute to this project (a shared campaign name
      // with no slug in it) — not a month with no spend.
      const feedByMonth = new Map<string, number>();
      for (const p of daily) {
        const mo = p.date.slice(0, 7);
        feedByMonth.set(mo, (feedByMonth.get(mo) ?? 0) + p.cost);
      }
      let total = 0;
      let anyFeed = false;
      let anyFallback = false;
      for (const seg of segs) {
        const fromFeed = feedByMonth.get(seg.month) ?? 0;
        const fromSheet = a.spendByMonth.get(seg.month) ?? 0;
        if (fromFeed > 0) {
          total += fromFeed;
          anyFeed = true;
        } else {
          total += fromSheet;
          if (fromSheet > 0) anyFallback = true;
        }
      }
      spend = total;
      // A row counts as measured only when NOTHING in it was estimated —
      // the note exists to say which numbers can be checked against a
      // platform, and a mixed row cannot be.
      if (anyFeed && !anyFallback) {
        realSpend.push(a.channel);
      } else {
        prorated.push(a.channel);
        // Drop the per-row trend series too — it covers only the months the
        // feed could attribute, so on a mixed row it totals ₪4,451 against a
        // cell reading ₪13,021. `spendEstimated` then stops the client
        // substituting the whole-platform series, which overstates the same
        // row at ₪17,562: with a partly-estimated cost there is no daily
        // series that reconciles, so the row shows no trend at all.
        daily = undefined;
      }
    } else {
      prorated.push(a.channel);
    }
    const estimated = !daily;
    return { a, platform, subs, spend, daily, estimated };
  });

  // ── (3) outcomes from the CRM, windowed on the exact range ───────────
  const labels = built.map((b) => b.a.channel);
  const funnel = await getCrmFunnelForProject({
    company,
    project,
    projectWindow: { from: window.startIso, to: window.endIso },
  }).catch(() => null);

  let outcomes: RangeBasis["outcomes"] = "prorated";
  let unattributedLeads = 0;
  let ambiguousLeads = 0;
  let totalCrmLeads = 0;
  const crm = new Map<string, { leads: number; scheduled: number; meetings: number }>();
  if (funnel) {
    const attribute = buildAttributor(labels);
    const sm = funnel.sourceMatrices;
    let attributed = 0;
    for (const src of sm.allSources) {
      const leads = sm.leadsBySource[src] || 0;
      totalCrmLeads += leads;
      const { channel, ambiguous } = attribute(src);
      if (!channel) {
        if (ambiguous) ambiguousLeads += leads;
        else unattributedLeads += leads;
        continue;
      }
      attributed += leads;
      const cur = crm.get(channel) ?? { leads: 0, scheduled: 0, meetings: 0 };
      cur.leads += leads;
      cur.scheduled += sm.scheduledMeetingsBySource[src] || 0;
      cur.meetings += sm.meetingsBySource[src] || 0;
      crm.set(channel, cur);
    }
    // Only switch the columns over when the attribution actually covers
    // the cohort. A project whose CRM source names have drifted away from
    // its ALL CLIENTS channel labels would otherwise render a table of
    // zeros next to real spend, which reads as "this channel produced
    // nothing" rather than "we could not match the names".
    if (totalCrmLeads > 0 && attributed * 2 >= totalCrmLeads) outcomes = "crm";
  }

  const channels: ReportChannel[] = built.map(({ a, platform, subs, spend, daily, estimated }) => {
    const hit = outcomes === "crm" ? crm.get(a.channel) : undefined;
    const leads = outcomes === "crm" ? (hit?.leads ?? 0) : Math.round(a.leads);
    const scheduled =
      outcomes === "crm" ? (hit?.scheduled ?? 0) : Math.round(a.scheduled);
    const meetings =
      outcomes === "crm" ? (hit?.meetings ?? 0) : Math.round(a.meetings);
    return {
      channel: a.channel,
      platform,
      budget: a.budget,
      spend,
      leads,
      pixelLeads: a.pixelLeads == null ? undefined : Math.round(a.pixelLeads),
      spendEstimated: estimated,
      scheduled,
      meetings,
      // Observed rate over the selected days — not the sheet's קצב יומי,
      // which is a required-rate-to-finish figure that means nothing for
      // an arbitrary window. The column is hidden in range mode anyway.
      dailyRate: spend / rangeDays,
      startIso: a.startIso,
      endIso: a.endIso,
      costPerLead: leads > 0 ? spend / leads : 0,
      costPerScheduled: scheduled > 0 ? spend / scheduled : 0,
      costPerMeeting: meetings > 0 ? spend / meetings : 0,
      subCampaigns: subs,
      // Flight-window concepts — a free range has no configured budget to
      // pace against, and a platform 7-day average is not about this window.
      configuredDaily: null,
      campaignStatus: "none",
      avg7d: null,
      daily,
    };
  });
  channels.sort((x, y) => y.spend - x.spend);

  return {
    channels,
    basis: {
      realSpend,
      prorated,
      outcomes,
      unattributedLeads: outcomes === "crm" ? unattributedLeads : 0,
      ambiguousLeads: outcomes === "crm" ? ambiguousLeads : 0,
      totalCrmLeads: outcomes === "crm" ? totalCrmLeads : 0,
    },
  };
}

function sumChannelTotals(channels: AllClientsRow[]) {
  const t = { budget: 0, spend: 0, leads: 0, relevant: 0, scheduled: 0, meetings: 0, sales: 0 };
  for (const c of channels) {
    t.budget += c.budget;
    t.spend += c.spend;
    t.leads += c.leads;
    t.relevant += c.relevant ?? 0;
    t.scheduled += c.scheduled;
    t.meetings += c.meetings;
    t.sales += c.sales ?? 0;
  }
  return t;
}

/**
 * Assemble the native report's phase-1 data for one project.
 * `period` carries the same slot the iframe URL uses: "" (live),
 * "YYYY-MM" (completed month) or "YYYY-MM-DD..YYYY-MM-DD" (free range).
 * Returns null when the project has no Keys campaign-ID slug (no way to
 * attribute platform rows — same as the legacy report rendering empty).
 */
export const getProjectReportData = cache(
  async (
    subjectEmail: string,
    projectName: string,
    period: string,
    company = "",
  ): Promise<ProjectReportData | null> => {
    const slug = await getProjectSlug(subjectEmail, projectName);
    if (!slug) return null;

    let mode: ProjectReportData["mode"] = "live";
    let window: ReportWindow = { startIso: "", endIso: "" };
    let channels: AllClientsRow[] = [];

    const rangeMatch = period.match(
      /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/,
    );
    if (rangeMatch) {
      mode = "range";
      window = { startIso: rangeMatch[1], endIso: rangeMatch[2] };
    } else if (/^\d{4}-\d{2}$/.test(period)) {
      mode = "month";
      window = { startIso: `${period}-01`, endIso: lastDayOfMonth(period) };
      channels = await getAllClientsMonthlyForProject({
        subjectEmail,
        project: projectName,
        yearMonth: period,
      });
    } else {
      mode = "live";
      channels = await getAllClientsCurrentForProject({
        subjectEmail,
        project: projectName,
      });
      // Flight envelope: earliest התחלה, latest סיום across current rows
      // (legacy Code.js:2225).
      let start = "";
      let end = "";
      for (const c of channels) {
        if (c.startIso && (!start || c.startIso < start)) start = c.startIso;
        if (c.endIso && c.endIso > end) end = c.endIso;
      }
      window = { startIso: start, endIso: end };
    }

    // Creatives fetch runs concurrently with the platform-daily read —
    // both are independent sheet reads (+ the warehouse meetings join).
    const creativesP = getProjectCreatives(
      subjectEmail,
      projectName,
      slug,
      window,
    );
    // Header inputs — landing URL (cheap cached Keys read) + this
    // project's per-month totals (forecast + prev-funnel). Both
    // best-effort so the header degrades gracefully.
    const landingP = getProjectLandingUrl(subjectEmail, projectName).catch(
      () => "",
    );
    const monthlyP = getProjectMonthlyTotals({ subjectEmail, project: projectName }).catch(
      () => [] as MonthlyRow[],
    );
    const monthlyRawP = getProjectMonthlyRaw({ subjectEmail, project: projectName }).catch(
      () => [] as ProjectReportData["monthlyRaw"],
    );
    const rows = await readProjectPlatformRows(subjectEmail, slug);
    const adPlatform = aggregateWindow(rows, window.startIso, window.endIso);
    const prevWindow = prevWindowOf(window);
    const prevAdPlatform = prevWindow
      ? aggregateWindow(rows, prevWindow.startIso, prevWindow.endIso)
      : null;

    // ערוצים tab rows: live mode gets the full pacing enrichment
    // (configured budgets + status dots + 7d averages); month mode shows
    // plain values with the legacy dailyRate = spend/daysInMonth (the
    // תקציב + קצב יומי columns are hidden there anyway); range mode folds
    // the months the range spans together — see buildRangeReportChannels.
    let reportChannels: ReportChannel[] = [];
    let rangeBasis: RangeBasis | null = null;
    if (mode === "range" && window.startIso && window.endIso) {
      const built = await buildRangeReportChannels({
        subjectEmail,
        project: projectName,
        company,
        window,
        platformRows: rows,
        today: todayIso(),
      }).catch(() => ({ channels: [], basis: null }) as {
        channels: ReportChannel[];
        basis: RangeBasis | null;
      });
      reportChannels = built.channels;
      rangeBasis = built.basis;
    } else if (mode !== "range" && channels.length) {
      let campaigns: CampaignBudgetItem[] = [];
      let avg7dByPlat: Record<string, number> | undefined;
      if (mode === "live") {
        const [cb, spend7d] = await Promise.all([
          getCampaignBudgets(subjectEmail).catch(() => null),
          getDailySpend7d(subjectEmail).catch(() => null),
        ]);
        campaigns = cb?.campaignsBySlug[slug.toLowerCase()] ?? [];
        avg7dByPlat = spend7d?.[slug.toLowerCase()];
      }
      const daysInMonth = Number(window.endIso.slice(8, 10)) || 30;
      const rowsForTab =
        mode === "month"
          ? channels.map((c) => ({ ...c, dailyRate: c.spend / daysInMonth }))
          : channels;
      reportChannels = buildReportChannels(
        rowsForTab,
        slug,
        campaigns,
        avg7dByPlat,
        mode === "live",
        rows,
      );
    }

    // Dated meetings — the alternative basis for the scheduled/held
    // columns (counted by when the meeting HAPPENED, not by when the lead
    // was created). Attached onto the same rows so the table's toggle is
    // pure client state and flipping it costs no round-trip. Best-effort:
    // a null result just means the toggle doesn't appear.
    let datedSource: DatedSourceInfo | null = null;
    if (reportChannels.length && window.startIso && window.endIso) {
      const dated = await getDatedChannelMeetings({
        project: projectName,
        company,
        from: window.startIso,
        to: window.endIso,
        channels: reportChannels.map((c) => c.channel),
      }).catch(() => null);
      if (dated) {
        // Keyed by this project's own channel labels, so a row reads its
        // own bucket and two rows can never share one. Anything the
        // attributor couldn't place is already in unattributed/ambiguous.
        reportChannels = reportChannels.map((c) => {
          const hit = dated.byChannel[c.channel];
          return {
            ...c,
            datedScheduled: hit?.scheduled ?? 0,
            datedMeetings: hit?.held ?? 0,
          };
        });
        datedSource = {
          platform: dated.platform,
          heldConfidence: dated.heldConfidence,
          unresolved: dated.unresolved,
          unmatchedScheduled: dated.unattributed.scheduled,
          unmatchedMeetings: dated.unattributed.held,
          ambiguousScheduled: dated.ambiguous.scheduled,
          ambiguousMeetings: dated.ambiguous.held,
        };
      }
    }

    const totals = mode === "range" ? null : sumChannelTotals(channels);
    const [landingUrl, monthly, monthlyRaw, creatives] = await Promise.all([
      landingP,
      monthlyP,
      monthlyRawP,
      creativesP,
    ]);

    // Header derivations (server-side so the client header is a pure
    // render — no browser clock, no hydration drift). Only when we have
    // a totals block (live + month modes).
    const today = todayIso();
    const sm = sumAdPlatform(adPlatform);
    const prevSm = prevAdPlatform ? sumAdPlatform(prevAdPlatform) : null;
    const pacing =
      totals && mode !== "range"
        ? computePacing(totals, window, today)
        : null;
    const prevFunnel =
      mode === "live" ? computePrevFunnel(window, monthly, today) : null;
    const forecast =
      mode === "live" && totals
        ? computeForecast(window, monthly, totals.budget, totals, today)
        : null;
    const anomalies =
      totals && mode !== "range"
        ? detectAnomalies(totals, prevFunnel, sm, prevSm)
        : [];

    // Budget-desk summary for the תקציב חודשי strip (live mode only —
    // E3/allocated/delta are flight-window concepts). Best-effort.
    let budgetSummary: ProjectReportData["budgetSummary"] = null;
    let tabSlug = "";
    if (mode === "live") {
      try {
        const bm = await getBudgetMaster(subjectEmail);
        // Budget-desk `tab` = מזהה מע"פ; our `slug` = the Keys campaign-ID
        // pattern — they can differ, so match by project name too.
        const projLc = projectName.toLowerCase().trim();
        const slugLc = slug.toLowerCase();
        const bp = bm.projects.find(
          (p) =>
            p.name.toLowerCase().trim() === projLc ||
            p.tab.toLowerCase() === slugLc,
        );
        if (bp) {
          tabSlug = bp.tab;
          budgetSummary = {
            e3: bp.e3,
            allocated: bp.allocated,
            delta: bp.delta,
            remainingDays: bp.remainingDays,
            totalDays: bp.totalDays,
          };
        }
      } catch {
        /* strip degrades to hidden */
      }
    }

    return {
      project: projectName,
      slug,
      mode,
      window,
      prevWindow,
      adPlatform,
      prevAdPlatform,
      daily: dailySeries(rows),
      dailyGoogleByKind: googleDailyByKind(rows.google),
      channels: reportChannels,
      datedSource,
      rangeBasis,
      creatives,
      company,
      landingUrl,
      pacing,
      forecast,
      anomalies,
      prevFunnel,
      monthlyRaw,
      todayIso: today,
      tabSlug,
      budgetSummary,
      totals,
    };
  },
);
