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
  /** Total meeting tie-ups (תיאום וביטול — includes cancellations).
   *  This is the "scheduled" half of meeting-noshow-spike alerts. */
  scheduled: number;
  /** Meetings that actually took place (ביצוע פגישות). The "held"
   *  side of the noshow gap. */
  meetings: number;
  /** Window start (ISO date), formatted from the sheet's date column.
   *  Empty when the cell isn't a valid date. */
  startIso: string;
  /** Window end (ISO date). */
  endIso: string;
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
  const iScheduled = col("תיאום וביטול");
  const iMeetings = col("ביצוע פגישות");
  const iRowType = col("סוג שורה");
  const iProject = col("פרוייקט");

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
    scheduled: num(row[iScheduled]),
    meetings: num(row[iMeetings]),
    startIso: dateOnlyFromSerial(row[iStart]),
    endIso: dateOnlyFromSerial(row[iEnd]),
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
    const matched = rows.filter((r) => {
      if (r.rowType !== "current") return false;
      const proj = r.project.toLowerCase();
      const slug = r.projectSlug.toLowerCase();
      if (proj && proj === targetProject) return true;
      if (targetSlug && slug && slug === targetSlug) return true;
      // Last-resort: caller passed a slug-looking string as `project`
      // (no Hebrew name available). Match by slug equality too.
      if (slug && slug === targetProject) return true;
      return false;
    });
    // Consolidate by channel — sum numeric fields, keep the first
    // non-empty start/end dates seen. Channels lower-cased for the
    // dedup key so "Facebook" and "facebook" merge, but the display
    // channel keeps the first-seen casing.
    const byChannel = new Map<string, AllClientsRow>();
    const order: string[] = [];
    for (const r of matched) {
      const key = r.channel.toLowerCase();
      const existing = byChannel.get(key);
      if (!existing) {
        byChannel.set(key, { ...r });
        order.push(key);
      } else {
        existing.spend += r.spend;
        existing.budget += r.budget;
        existing.leads += r.leads;
        existing.scheduled += r.scheduled;
        existing.meetings += r.meetings;
        if (!existing.startIso && r.startIso) existing.startIso = r.startIso;
        if (r.endIso && r.endIso > existing.endIso) existing.endIso = r.endIso;
      }
    }
    return order.map((k) => byChannel.get(k)!);
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
