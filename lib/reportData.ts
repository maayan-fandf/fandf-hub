import { cache } from "react";
import { unstable_cache, revalidateTag } from "next/cache";
import { sheetsClient } from "@/lib/sa";
import { buildMatchMap, matchSlug, getProjectSlug } from "@/lib/campaignMatch";
import {
  getAllClientsCurrentForProject,
  getAllClientsMonthlyForProject,
  type AllClientsRow,
} from "@/lib/allClients";
import {
  REPORT_PLATS,
  emptyAdPlatform,
  type AdPlatform,
  type DailyPoint,
  type PlatCampaign,
  type ProjectReportData,
  type ReportPlat,
  type ReportWindow,
} from "@/lib/reportShared";

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

function sumChannelTotals(channels: AllClientsRow[]) {
  const t = { budget: 0, spend: 0, leads: 0, scheduled: 0, meetings: 0 };
  for (const c of channels) {
    t.budget += c.budget;
    t.spend += c.spend;
    t.leads += c.leads;
    t.scheduled += c.scheduled;
    t.meetings += c.meetings;
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

    const rows = await readProjectPlatformRows(subjectEmail, slug);
    const adPlatform = aggregateWindow(rows, window.startIso, window.endIso);
    const prevWindow = prevWindowOf(window);
    const prevAdPlatform = prevWindow
      ? aggregateWindow(rows, prevWindow.startIso, prevWindow.endIso)
      : null;

    return {
      project: projectName,
      slug,
      mode,
      window,
      prevWindow,
      adPlatform,
      prevAdPlatform,
      daily: dailySeries(rows),
      totals: mode === "range" ? null : sumChannelTotals(channels),
    };
  },
);
