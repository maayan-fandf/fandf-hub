import { cache } from "react";
import { unstable_cache, revalidateTag } from "next/cache";
import { sheetsClient } from "@/lib/sa";
import { readKeysCached } from "@/lib/keys";

/**
 * Two-layer cached read of the `ALL CLIENTS` tab from the main
 * spreadsheet. Same caching shape as `lib/keys.ts` — 5-min
 * unstable_cache + per-request `cache()` dedup. ALL CLIENTS is the
 * canonical project-level aggregator: each row is one (project,
 * channel, row-type) tuple with leads / scheduled / meetings / spend
 * pre-summed. Produced upstream via QUERY() over several source
 * sheets, edited by humans on a weekly cadence.
 *
 * Why this lives here, not in crmData.ts: the CRM workbook
 * (`מאגר במבי` / `מאגר שכל`) is a per-person view that's less
 * reliable at aggregating status per media-source. ALL CLIENTS already
 * does the channel-level aggregation, so anywhere the hub needs
 * "channel × project × outcome" totals should read from here.
 *
 * Today only `lib/crmAlerts.ts` reads through this module; the project
 * page's own metrics come from the Apps Script iframe that reads ALL
 * CLIENTS server-side. As more hub-side surfaces want channel-level
 * project metrics (without re-aggregating from the per-person CRM
 * tables), this is the canonical entry point.
 */

const ALL_CLIENTS_CACHE_TAG = "allClients";
const ALL_CLIENTS_CACHE_TTL_SECONDS = 300; // 5 min

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const HEADER_NORMALIZE =
  /[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g;

/** One row from ALL CLIENTS, normalized + typed. */
export type AllClientsRow = {
  /** "current" (full-window aggregation) or "חודשי" (monthly row).
   *  Most callers want "current" only. */
  rowType: string;
  /** Hebrew project name as it appears in the sheet. May be blank
   *  post-XLOOKUP-removal (2026-05-01); use `projectSlug` as the join
   *  key for downstream lookups. */
  project: string;
  /** Project slug (`מזהה מע"פ` column). The canonical, machine-stable
   *  identifier for the project — survives the XLOOKUP migration. */
  projectSlug: string;
  /** Media channel name (`מזהה BMBY` column), e.g. "facebook",
   *  "google-search", "yad2". Forward-filled from prior rows in the
   *  same (project, row-type) group because the upstream QUERY() drops
   *  the value on continuation rows from merged BMBY cells. */
  channel: string;
  /** Spend in NIS over the row's date window. */
  spend: number;
  /** Approved monthly budget (NIS). */
  budget: number;
  /** Total leads recorded against this (project, channel) in the
   *  window. Source: `לידים CRM` column. */
  leads: number;
  /** Relevant leads (`לידים רלוונטים`) — the qualified subset that
   *  feeds the funnel-flow's leads→relevant conversion. 0/absent when the
   *  column is absent. */
  relevant?: number;
  /** Total meeting tie-ups (תיאום וביטול — includes cancellations).
   *  This is the "scheduled" half of meeting-noshow-spike alerts. */
  scheduled: number;
  /** Meetings that actually took place (ביצוע פגישות). The "held"
   *  side of the noshow gap. */
  meetings: number;
  /** Sales / deals closed (`מכירות`) — the last funnel stage; 0/absent
   *  when the column is missing. Feeds the conversion-funnel chart. */
  sales?: number;
  /** קצב יומי — the channel's historical daily spend rate. The budget-
   *  shift scorer uses it only as a gate (dailyRate > 0 ⇒ headroom is
   *  meaningful), mirroring the dashboard's c.dailyRate (Code.js#L2207).
   *  0 when the column is absent from the sheet. */
  dailyRate: number;
  /** Window start (ISO date), formatted from the sheet's date column.
   *  Empty when the cell isn't a valid date. */
  startIso: string;
  /** Window end (ISO date). */
  endIso: string;
  /** סוג קמפיין — the SUMIFS sub-campaign token (e.g. "GS", "45-60").
   *  Optional column; ""/absent when the sheet lacks it. Used by the
   *  native report's channels tab to attribute configured platform
   *  budgets (same token matching as lib/budgetMaster). */
  campaignType?: string;
  /** Populated ONLY by consolidateForProject: the pre-merge sub-rows
   *  that carried a סוג קמפיין, so a consolidated channel can show its
   *  sub-campaign breakdown (mirrors the dashboard's c.subCampaigns). */
  subCampaigns?: AllClientsSubCampaign[];
};

export type AllClientsSubCampaign = {
  name: string;
  spend: number;
  budget: number;
  leads: number;
  scheduled: number;
  meetings: number;
};

type RawTable = { headers: string[]; rows: unknown[][] };

async function fetchAllClientsFromSheet(
  subjectEmail: string,
): Promise<RawTable> {
  const sheets = sheetsClient(subjectEmail);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: envOrThrow("SHEET_ID_MAIN"),
    range: "ALL CLIENTS",
    valueRenderOption: "UNFORMATTED_VALUE",
    // Dates come through as Sheets serial numbers; convert in
    // dateOnlyFromSerial below.
    dateTimeRenderOption: "SERIAL_NUMBER",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (!values.length) return { headers: [], rows: [] };
  const headers = (values[0] as unknown[]).map((h) =>
    String(h ?? "")
      .replace(HEADER_NORMALIZE, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return { headers, rows: values.slice(1) };
}

const fetchAllClientsCrossRequest = unstable_cache(
  fetchAllClientsFromSheet,
  ["readAllClients"],
  { revalidate: ALL_CLIENTS_CACHE_TTL_SECONDS, tags: [ALL_CLIENTS_CACHE_TAG] },
);

const readAllClientsCached = cache(
  (subjectEmail: string) => fetchAllClientsCrossRequest(subjectEmail),
);

/**
 * Read every ALL CLIENTS row, normalized + typed. Forward-fills the
 * channel column within each (project, row-type) group because the
 * upstream QUERY() drops the BMBY value on continuation rows from
 * merged-cell sources (e.g. google-search spanning multiple
 * sub-campaigns). Same logic the Apps Script dashboard runs at
 * `Code.js#L1486`.
 */
async function readAllClientsRows(
  subjectEmail: string,
): Promise<AllClientsRow[]> {
  const { headers, rows } = await readAllClientsCached(subjectEmail);
  if (!rows.length) return [];

  const col = (name: string) => headers.indexOf(name);
  const iStart = col("התחלה");
  const iEnd = col("סיום");
  const iChannel = col("מזהה BMBY");
  const iProjId = col("מזהה מע\"פ");
  const iBudget = col("תקציב חודשי מאושר");
  const iSpend = col("עלות");
  const iLeads = col("לידים CRM");
  const iRelevant = col("לידים רלוונטים"); // optional; -1 tolerated
  const iScheduled = col("תיאום וביטול");
  const iMeetings = col("ביצוע פגישות");
  const iSales = col("מכירות"); // optional; -1 tolerated
  const iDailyRate = col("קצב יומי");
  const iRowType = col("סוג שורה");
  const iProject = col("פרוייקט");
  const iCampaignType = col("סוג קמפיין"); // optional; -1 tolerated

  const num = (v: unknown): number => {
    if (v === "" || v == null) return 0;
    const s = typeof v === "number" ? v : Number(String(v).replace(/[₪,\s%]/g, ""));
    return Number.isFinite(s) ? Number(s) : 0;
  };

  // Forward-fill channel within (project, row-type) groups — same as
  // the dashboard. Operates on a clone so the cached raw rows stay
  // pristine for other callers.
  const filled = rows.map((r) => [...r]);
  let lastProj = "", lastRt = "", lastCh = "";
  for (const row of filled) {
    const proj = String(row[iProject] ?? "").trim() || String(row[iProjId] ?? "").trim();
    const rt = String(row[iRowType] ?? "").trim();
    const ch = String(row[iChannel] ?? "").trim();
    if (proj !== lastProj || rt !== lastRt) {
      lastProj = proj; lastRt = rt; lastCh = ch;
    } else if (!ch && lastCh) {
      row[iChannel] = lastCh;
    } else if (ch) {
      lastCh = ch;
    }
  }

  return filled.map((row) => ({
    rowType: String(row[iRowType] ?? "").trim(),
    project: String(row[iProject] ?? "").trim(),
    projectSlug: String(row[iProjId] ?? "").trim(),
    channel: String(row[iChannel] ?? "").trim(),
    spend: num(row[iSpend]),
    budget: num(row[iBudget]),
    leads: num(row[iLeads]),
    relevant: iRelevant >= 0 ? num(row[iRelevant]) : 0,
    scheduled: num(row[iScheduled]),
    meetings: num(row[iMeetings]),
    sales: iSales >= 0 ? num(row[iSales]) : 0,
    dailyRate: iDailyRate >= 0 ? num(row[iDailyRate]) : 0,
    startIso: dateOnlyFromSerial(row[iStart]),
    endIso: dateOnlyFromSerial(row[iEnd]),
    campaignType:
      iCampaignType >= 0 ? String(row[iCampaignType] ?? "").trim() : "",
  }));
}

/**
 * Return the project's "current" rows (one per active channel) for the
 * passed project. The match works against both the Hebrew project name
 * AND the slug because ALL CLIENTS' `פרוייקט` column was blanked
 * post-XLOOKUP-removal (2026-05-01) for many rows — they only carry a
 * slug. When the caller passes only the Hebrew name, this function
 * looks up the slug in Keys (via `lib/keys.ts`, which is cached) so
 * the slug-only ALL CLIENTS rows still match.
 *
 * Monthly (חודשי) rows are excluded because alerts should fire against
 * the live window, not historical months. Empty array when no match.
 *
 * Duplicate channel rows (sub-campaigns that share a channel name —
 * e.g. Brand*GS + generic*GS both under google-search) are
 * consolidated by summing their numeric fields. Same logic the
 * dashboard runs at `Code.js#L1729`.
 */
/**
 * Filter the ALL CLIENTS rows to one project (by Hebrew name OR slug —
 * the project name is blank on many slug-only rows post-XLOOKUP) using
 * the `keep` predicate (row-type / window), then consolidate duplicate
 * channels by summing numeric fields (keep first-seen casing + the
 * widest start/end). Shared by the "current" + "חודשי" readers so the
 * project-matching can't drift between them.
 */
function consolidateForProject(
  rows: AllClientsRow[],
  targetProject: string,
  targetSlug: string,
  keep: (r: AllClientsRow) => boolean,
): AllClientsRow[] {
  const matched = rows.filter((r) => {
    if (!keep(r)) return false;
    const proj = r.project.toLowerCase();
    const slug = r.projectSlug.toLowerCase();
    if (proj && proj === targetProject) return true;
    if (targetSlug && slug && slug === targetSlug) return true;
    // Last-resort: caller passed a slug-looking string as `project`.
    if (slug && slug === targetProject) return true;
    return false;
  });
  const byChannel = new Map<string, AllClientsRow>();
  const order: string[] = [];
  const subOf = (r: AllClientsRow): AllClientsSubCampaign[] =>
    r.campaignType
      ? [
          {
            name: r.campaignType,
            spend: r.spend,
            budget: r.budget,
            leads: r.leads,
            scheduled: r.scheduled,
            meetings: r.meetings,
          },
        ]
      : [];
  for (const r of matched) {
    const key = r.channel.toLowerCase();
    const existing = byChannel.get(key);
    if (!existing) {
      byChannel.set(key, { ...r, subCampaigns: subOf(r) });
      order.push(key);
    } else {
      existing.spend += r.spend;
      existing.budget += r.budget;
      existing.leads += r.leads;
      existing.scheduled += r.scheduled;
      existing.meetings += r.meetings;
      existing.dailyRate += r.dailyRate;
      if (!existing.startIso && r.startIso) existing.startIso = r.startIso;
      if (r.endIso && r.endIso > existing.endIso) existing.endIso = r.endIso;
      existing.subCampaigns!.push(...subOf(r));
    }
  }
  return order.map((k) => byChannel.get(k)!);
}

export const getAllClientsCurrentForProject = cache(
  async (args: {
    subjectEmail: string;
    project: string;
    projectSlug?: string;
  }): Promise<AllClientsRow[]> => {
    const [rows, slugFromKeys] = await Promise.all([
      readAllClientsRows(args.subjectEmail),
      args.projectSlug
        ? Promise.resolve(args.projectSlug)
        : resolveSlugFromKeys(args.subjectEmail, args.project),
    ]);
    const targetProject = args.project.toLowerCase().trim();
    const targetSlug = (args.projectSlug || slugFromKeys || "").toLowerCase().trim();
    return consolidateForProject(
      rows,
      targetProject,
      targetSlug,
      (r) => r.rowType === "current",
    );
  },
);

/**
 * Like getAllClientsCurrentForProject but returns the project's "חודשי"
 * (monthly) rows for a single calendar month (`yearMonth` = "YYYY-MM",
 * matched on the row's startIso) — one consolidated row per channel.
 * Used by the CRM funnel's month-rewind view to attach that month's
 * per-channel spend (the "current" rows only cover the flight window).
 */
export const getAllClientsMonthlyForProject = cache(
  async (args: {
    subjectEmail: string;
    project: string;
    projectSlug?: string;
    yearMonth: string;
  }): Promise<AllClientsRow[]> => {
    if (!/^\d{4}-\d{2}$/.test(args.yearMonth)) return [];
    const [rows, slugFromKeys] = await Promise.all([
      readAllClientsRows(args.subjectEmail),
      args.projectSlug
        ? Promise.resolve(args.projectSlug)
        : resolveSlugFromKeys(args.subjectEmail, args.project),
    ]);
    const targetProject = args.project.toLowerCase().trim();
    const targetSlug = (args.projectSlug || slugFromKeys || "").toLowerCase().trim();
    return consolidateForProject(
      rows,
      targetProject,
      targetSlug,
      (r) => r.rowType === "חודשי" && r.startIso.startsWith(args.yearMonth),
    );
  },
);

/**
 * Find the slug (Keys' `campaign ID` column) for a project, looked up
 * by Hebrew name. Empty string when no Keys row matches — caller
 * falls back to matching ALL CLIENTS by whatever the project string
 * happens to be. Keys is two-layer-cached so this is ~free.
 */
async function resolveSlugFromKeys(
  subjectEmail: string,
  projectHebrewName: string,
): Promise<string> {
  if (!projectHebrewName) return "";
  const { headers, rows } = await readKeysCached(subjectEmail);
  const iProj = headers.indexOf("פרוייקט");
  // Slug column is `campaign ID` per the dashboard convention
  // (`_keysSlugColIndex_` in Code.js).
  const iSlug = headers.indexOf("campaign ID");
  if (iProj < 0 || iSlug < 0) return "";
  const target = projectHebrewName.toLowerCase().trim();
  for (const r of rows) {
    const proj = String((r as unknown[])[iProj] ?? "").toLowerCase().trim();
    if (proj === target) {
      return String((r as unknown[])[iSlug] ?? "").trim();
    }
  }
  return "";
}

/**
 * Sheets stores dates as serials when valueRenderOption is
 * UNFORMATTED_VALUE + dateTimeRenderOption is SERIAL_NUMBER. Convert
 * to YYYY-MM-DD; return empty string for non-numeric or out-of-range
 * values. The 25000-80000 plausibility band rules out integers that
 * are accidentally falling through (lead counts, etc.).
 */
function dateOnlyFromSerial(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  if (v <= 25000 || v >= 80000) return "";
  const ms = (v - 25569) * 86400 * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/**
 * Read EVERY ALL CLIENTS row (both "current" and "חודשי" types) for
 * callers that need both — e.g. the spend-forecast page, which uses
 * monthly windows to predict month-end totals.
 *
 * Exposed at module scope (instead of being kept private like
 * `readAllClientsRows`) so the forecast page can do its own filtering
 * without forcing a "current"-only contract on the shared helper.
 * Cached the same way as every other reader through `readAllClientsCached`.
 */
export async function getAllClientsAllRows(
  subjectEmail: string,
): Promise<AllClientsRow[]> {
  return readAllClientsRows(subjectEmail);
}

/**
 * Per-project CRM funnel totals (leads → scheduled → held) plus blended
 * cost-per-metric, summed across the project's "current" ALL CLIENTS
 * rows. Keyed by lowercased `projectSlug` (the join key the dashboard
 * uses everywhere — the `פרוייקט` name column is blank on many rows
 * post-XLOOKUP). cost-per is total window spend ÷ count — the same
 * blended figure the project page's totals show — and is left at 0 when
 * the denominator is 0 so callers can omit the cost chip.
 *
 * "scheduled" = `תיאום וביטול` (meeting tie-ups incl. cancellations);
 * "held" = `ביצוע פגישות` (meetings that took place). Same column
 * semantics as the project metrics aggregate.
 */
export type ProjectFunnelTotals = {
  leads: number;
  scheduled: number;
  held: number;
  spend: number;
  /** cost per lead (spend ÷ leads), 0 when no leads. */
  cpl: number;
  /** cost per scheduled meeting (spend ÷ scheduled), 0 when none. */
  cps: number;
  /** cost per held meeting (spend ÷ held), 0 when none. */
  cpm: number;
  /** Approved budget summed across the project's current rows — lets the
   *  home grid derive budget-utilization + the "inactive" (no spend AND no
   *  budget) filter WITHOUT the Apps Script morning feed. */
  budget: number;
  /** Flight window (widest across the project's current rows) — powers the
   *  time-progress bar + the hide-ended filter natively. "" when absent. */
  startIso: string;
  endIso: string;
};

/**
 * Two-key index of project funnel totals, so callers can join on
 * whichever identifier they hold. `bySlug` is the complete aggregation
 * (slug is forward-consistent across continuation rows); `byName` covers
 * rows that still carry a Hebrew `פרוייקט` value — the fallback for
 * projects whose slug isn't reachable from Keys (mirrors the
 * name-OR-slug match `consolidateForProject` runs).
 */
export type ProjectFunnelIndex = {
  bySlug: Map<string, ProjectFunnelTotals>;
  byName: Map<string, ProjectFunnelTotals>;
};

type FunnelAcc = {
  leads: number;
  scheduled: number;
  held: number;
  spend: number;
  budget: number;
  startIso: string;
  endIso: string;
};

function addFunnel(acc: Map<string, FunnelAcc>, key: string, r: AllClientsRow): void {
  const cur =
    acc.get(key) ??
    { leads: 0, scheduled: 0, held: 0, spend: 0, budget: 0, startIso: "", endIso: "" };
  cur.leads += r.leads;
  cur.scheduled += r.scheduled;
  cur.held += r.meetings;
  cur.spend += r.spend;
  cur.budget += r.budget;
  // Widest flight window across the project's channels.
  if (r.startIso && (!cur.startIso || r.startIso < cur.startIso)) cur.startIso = r.startIso;
  if (r.endIso && r.endIso > cur.endIso) cur.endIso = r.endIso;
  acc.set(key, cur);
}

function finalizeFunnels(acc: Map<string, FunnelAcc>): Map<string, ProjectFunnelTotals> {
  const out = new Map<string, ProjectFunnelTotals>();
  for (const [key, t] of acc) {
    out.set(key, {
      leads: t.leads,
      scheduled: t.scheduled,
      held: t.held,
      spend: t.spend,
      cpl: t.leads > 0 ? t.spend / t.leads : 0,
      cps: t.scheduled > 0 ? t.spend / t.scheduled : 0,
      cpm: t.held > 0 ? t.spend / t.held : 0,
      budget: t.budget,
      startIso: t.startIso,
      endIso: t.endIso,
    });
  }
  return out;
}

export function sumProjectFunnels(rows: AllClientsRow[]): ProjectFunnelIndex {
  const slugAcc = new Map<string, FunnelAcc>();
  const nameAcc = new Map<string, FunnelAcc>();
  for (const r of rows) {
    if (r.rowType !== "current") continue;
    const slug = r.projectSlug.toLowerCase().trim();
    const name = r.project.toLowerCase().trim();
    if (slug) addFunnel(slugAcc, slug, r);
    if (name) addFunnel(nameAcc, name, r);
  }
  return { bySlug: finalizeFunnels(slugAcc), byName: finalizeFunnels(nameAcc) };
}

/**
 * Resolve one project's funnel totals from the index, given its Hebrew
 * name and (optionally) its Keys-resolved slug. Slug first — that's the
 * complete aggregation — then the Hebrew name, then the case where the
 * project string IS a slug. Null when none match (no CRM/media
 * aggregation exists for the project yet). Same precedence intent as
 * `consolidateForProject`'s row predicate.
 */
export function lookupProjectFunnel(
  index: ProjectFunnelIndex,
  projectName: string,
  slugFromKeys?: string,
): ProjectFunnelTotals | null {
  const nameLower = projectName.toLowerCase().trim();
  const slugLower = (slugFromKeys || "").toLowerCase().trim();
  if (slugLower && index.bySlug.has(slugLower)) return index.bySlug.get(slugLower)!;
  if (nameLower && index.byName.has(nameLower)) return index.byName.get(nameLower)!;
  if (nameLower && index.bySlug.has(nameLower)) return index.bySlug.get(nameLower)!;
  return null;
}

/**
 * Map every project's lowercased Hebrew name → its slug (`campaign ID`),
 * read from Keys. The canonical name→slug join the dashboard uses
 * (a batched `resolveSlugFromKeys`) — needed because ALL CLIENTS joins
 * on slug but most hub surfaces only carry the Hebrew project name.
 * Cached the same way as every other Keys read.
 */
export async function getSlugByProjectName(
  subjectEmail: string,
): Promise<Map<string, string>> {
  const { headers, rows } = await readKeysCached(subjectEmail);
  const iProj = headers.indexOf("פרוייקט");
  const iSlug = headers.indexOf("campaign ID");
  const out = new Map<string, string>();
  if (iProj < 0 || iSlug < 0) return out;
  for (const r of rows) {
    const name = String((r as unknown[])[iProj] ?? "").toLowerCase().trim();
    const slug = String((r as unknown[])[iSlug] ?? "").trim();
    if (name && slug) out.set(name, slug);
  }
  return out;
}

/**
 * Return every "חודשי" (monthly) row whose window contains today.
 *
 * `todayIso` defaults to the Asia/Jerusalem calendar day in YYYY-MM-DD.
 * Inclusive on both sides: a row with endIso === today still counts as
 * "current month."
 *
 * Used by /morning/forecast to project month-end spend from partial-
 * month actuals. Caller groups by (company, project) downstream — this
 * helper just narrows the row set.
 */
export async function getCurrentMonthlyRows(
  subjectEmail: string,
  todayIso?: string,
): Promise<AllClientsRow[]> {
  const today =
    todayIso ??
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
      new Date(),
    );
  const all = await readAllClientsRows(subjectEmail);
  return all.filter((r) => {
    if (r.rowType !== "חודשי") return false;
    if (!r.startIso || !r.endIso) return false;
    return r.startIso <= today && today <= r.endIso;
  });
}

/** One project's raw "חודשי" row (one per channel × month) — the shape
 *  the historical-trend section aggregates by channel filter. */
export type ProjectMonthlyRawRow = {
  month: string; // YYYY-MM
  channel: string;
  spend: number;
  leads: number;
  scheduled: number;
  meetings: number;
  budget: number;
};

/**
 * Every "חודשי" row for a project, kept per-channel (mirrors the
 * dashboard's p.monthlyRaw). Feeds the native report's מגמה היסטורית
 * section — the client aggregates by channel filter. Matched by Hebrew
 * name OR slug the same way consolidateForProject does.
 */
export const getProjectMonthlyRaw = cache(
  async (args: {
    subjectEmail: string;
    project: string;
    projectSlug?: string;
  }): Promise<ProjectMonthlyRawRow[]> => {
    const [rows, slugFromKeys] = await Promise.all([
      readAllClientsRows(args.subjectEmail),
      args.projectSlug
        ? Promise.resolve(args.projectSlug)
        : resolveSlugFromKeys(args.subjectEmail, args.project),
    ]);
    const targetProject = args.project.toLowerCase().trim();
    const targetSlug = (args.projectSlug || slugFromKeys || "").toLowerCase().trim();
    const out: ProjectMonthlyRawRow[] = [];
    for (const r of rows) {
      if (r.rowType !== "חודשי") continue;
      const month = r.startIso.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      const proj = r.project.toLowerCase();
      const slug = r.projectSlug.toLowerCase();
      const match =
        (proj && proj === targetProject) ||
        (targetSlug && slug && slug === targetSlug) ||
        (slug && slug === targetProject);
      if (!match) continue;
      out.push({
        month,
        channel: r.channel,
        spend: r.spend,
        leads: r.leads,
        scheduled: r.scheduled,
        meetings: r.meetings,
        budget: r.budget,
      });
    }
    return out;
  },
);

/**
 * Distinct historical months ("YYYY-MM") present in the ALL CLIENTS
 * "חודשי" rows across every project, minus the current in-flight
 * calendar month, sorted descending.
 *
 * Native replacement for the Apps Script `getAvailableMonths` action:
 * the month-picker options are derived from the very monthly rows the
 * report's historical-trend section already reads, so the picker no
 * longer depends on the Apps Script report being reachable. The union
 * across all projects (a global month list) mirrors the Apps Script
 * behavior, and `readAllClientsRows` is React-cache()d and already
 * loaded during a project render, so this adds ~zero marginal cost.
 *
 * The current month is excluded because it's mid-flight — a "rewind"
 * view of it would just duplicate live mode (parity with the Apps
 * Script `m < todayMonth` filter, Asia/Jerusalem).
 */
export const getAvailableMonthsDirect = cache(
  async (subjectEmail: string): Promise<{ months: string[] }> => {
    const rows = await readAllClientsRows(subjectEmail);
    const todayMonth = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem",
    })
      .format(new Date())
      .slice(0, 7); // "YYYY-MM"
    const set = new Set<string>();
    for (const r of rows) {
      if (r.rowType !== "חודשי") continue;
      const month = r.startIso.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      if (month >= todayMonth) continue;
      set.add(month);
    }
    return { months: Array.from(set).sort().reverse() };
  },
);

/** One project's monthly totals, summed across channels per calendar
 *  month — the shape the native report's forecast + prev-funnel need. */
export type ProjectMonthlyTotals = {
  month: string; // YYYY-MM
  spend: number;
  leads: number;
  scheduled: number;
  meetings: number;
  budget: number;
};

/**
 * All of a project's "חודשי" rows collapsed to one total row per
 * calendar month (summed across every channel), keyed off the row's
 * startIso month. Matches the project by Hebrew name OR slug the same
 * way consolidateForProject does. Ascending by month.
 */
export const getProjectMonthlyTotals = cache(
  async (args: {
    subjectEmail: string;
    project: string;
    projectSlug?: string;
  }): Promise<ProjectMonthlyTotals[]> => {
    const [rows, slugFromKeys] = await Promise.all([
      readAllClientsRows(args.subjectEmail),
      args.projectSlug
        ? Promise.resolve(args.projectSlug)
        : resolveSlugFromKeys(args.subjectEmail, args.project),
    ]);
    const targetProject = args.project.toLowerCase().trim();
    const targetSlug = (args.projectSlug || slugFromKeys || "").toLowerCase().trim();
    const byMonth = new Map<string, ProjectMonthlyTotals>();
    for (const r of rows) {
      if (r.rowType !== "חודשי") continue;
      const month = r.startIso.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      const proj = r.project.toLowerCase();
      const slug = r.projectSlug.toLowerCase();
      const match =
        (proj && proj === targetProject) ||
        (targetSlug && slug && slug === targetSlug) ||
        (slug && slug === targetProject);
      if (!match) continue;
      const t =
        byMonth.get(month) ??
        { month, spend: 0, leads: 0, scheduled: 0, meetings: 0, budget: 0 };
      t.spend += r.spend;
      t.leads += r.leads;
      t.scheduled += r.scheduled;
      t.meetings += r.meetings;
      t.budget += r.budget;
      byMonth.set(month, t);
    }
    return [...byMonth.keys()].sort().map((k) => byMonth.get(k)!);
  },
);

/**
 * Return every "חודשי" (monthly) row whose `startIso` falls within
 * the given calendar year-month (e.g. "2026-04" matches every monthly
 * row that starts on 2026-04-01, regardless of how long its window
 * runs). Used by /morning/forecast's "חודש קודם" toggle.
 *
 * The prefix-match is intentional — monthly rows in ALL CLIENTS are
 * always aligned to calendar months (startIso === first day of the
 * month), so a substring check on YYYY-MM is the most stable test.
 * Rows with empty/invalid startIso are silently dropped.
 */
export async function getMonthlyRowsForYearMonth(
  subjectEmail: string,
  yearMonth: string,
): Promise<AllClientsRow[]> {
  const all = await readAllClientsRows(subjectEmail);
  if (!yearMonth) return [];
  return all.filter((r) => r.rowType === "חודשי" && r.startIso.startsWith(yearMonth));
}

/**
 * Return EVERY "חודשי" (monthly) row across all calendar months — the
 * data source for /morning/forecast's "כל החודשים" pivot view. One row
 * per (project, channel, month); the caller derives the month from
 * `startIso` (YYYY-MM) and consolidates duplicate channels per cell.
 * Rows with empty/invalid startIso are kept here and dropped by the
 * caller (a monthless row has no column to land in).
 */
export async function getAllMonthlyRows(
  subjectEmail: string,
): Promise<AllClientsRow[]> {
  const all = await readAllClientsRows(subjectEmail);
  return all.filter((r) => r.rowType === "חודשי");
}

/**
 * Compute the YYYY-MM string for the calendar month *before* the
 * given todayIso, in Asia/Jerusalem semantics. Pure function, exported
 * so the forecast page can reuse the same calculation for both data
 * fetch + UI labelling.
 *
 *   previousYearMonth("2026-05-28") === "2026-04"
 *   previousYearMonth("2026-01-15") === "2025-12"
 */
export function previousYearMonth(todayIso: string): string {
  const [yStr, mStr] = todayIso.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return "";
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  return `${prevY}-${String(prevM).padStart(2, "0")}`;
}

/**
 * Force the next read to bypass the cross-request cache. Call after
 * the ALL CLIENTS tab is mutated upstream. No hub-side path mutates
 * the tab today, but exposed so the admin endpoint can wire it in if
 * we ever add one.
 */
export function invalidateAllClientsCache(): void {
  revalidateTag(ALL_CLIENTS_CACHE_TAG);
}
