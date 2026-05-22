import { cache } from "react";
import { unstable_cache, revalidateTag } from "next/cache";
import { sheetsClient } from "@/lib/sa";
import { readKeysCached } from "@/lib/keys";
import {
  classifyChannel,
  E3_PLATFORMS,
  type BudgetMaster,
  type BudgetProject,
  type BudgetRow,
  type Platform,
  type PlatformAgg,
  type ReconStatus,
} from "@/lib/budgetTypes";

export {
  classifyChannel,
  E3_PLATFORMS,
  PLATFORM_LABELS,
} from "@/lib/budgetTypes";
export type {
  BudgetMaster,
  BudgetProject,
  BudgetRow,
  Platform,
  PlatformAgg,
  ReconStatus,
} from "@/lib/budgetTypes";

/**
 * Master budget data layer for the קמפיינים → תקציבים page.
 *
 * Each project has its own tab in SHEET_ID_MAIN ("דוח ביצועים מדיה").
 * On every tab:
 *   - E3 = תקציב פרוגרמטי (the programmatic budget to distribute).
 *   - A "פעילות נוכחית" table (header row B="התחלה", D="מזהה BMBY") whose
 *     rows are per-channel: D=channel, F=סוג קמפיין, G=תקציב חודשי מאושר
 *     (the editable allocation), H=עלות (spend so far).
 *
 * The page reconciles E3 against the sum of G for the four paid
 * platforms (Google, Facebook, Taboola, Outbrain) — generic native
 * "article/כתבה/news" rows are intentionally treated as "other" and
 * NOT counted toward E3 (owner decision). It also computes pacing
 * (spend vs expected-by-today) and the daily-required budget
 * ((G−H)/days-remaining) so managers can spend out exactly by the end
 * date without overshooting.
 *
 * Reads use the same two-layer cache shape as lib/keys.ts /
 * lib/allClients.ts. The TTL is short (2 min) because managers edit
 * allocations interactively; the write API calls
 * revalidateBudgetMaster() so an edit shows up immediately.
 */

const CACHE_TAG = "budgetMaster";
const TTL_SECONDS = 120;

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const CLEAN = /[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g;
const clean = (s: unknown) =>
  String(s ?? "").replace(CLEAN, "").replace(/\s+/g, " ").trim();
const num = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** System / non-project tabs that must never be treated as projects. */
const SKIP_TABS = new Set([
  "פריסה נוכחית",
  "Keys",
  "Alert Dismissals",
  "טבלת שליטה",
  "names to emails",
  "Automation_Settings",
  "bmbypush automation setting",
  "KEYS2",
  "ALL CLIENTS",
  "GADS+FB",
  "SupermetricsQueries",
  "TEST_DataPipe",
]);

/* ── date helpers ────────────────────────────────────────────────── */

function parseSheetDate(v: unknown): string {
  const s = clean(v);
  if (!s) return "";
  // YYYY-MM-DD (the common case).
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  // M/D/YYYY (e.g. the עדכון במבי cell).
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return "";
}

function todayInIsrael(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts; // en-CA → YYYY-MM-DD
}

function dayDiff(fromIso: string, toIso: string): number {
  if (!fromIso || !toIso) return 0;
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/* ── core read ───────────────────────────────────────────────────── */

async function fetchBudgetMaster(subjectEmail: string): Promise<BudgetMaster> {
  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_MAIN");

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: ssId,
    fields: "sheets.properties(title)",
  });
  const titles = (meta.data.sheets ?? [])
    .map((s) => clean(s.properties?.title))
    .filter((t) => t && !SKIP_TABS.has(t) && !/crm$/i.test(t));

  // Map slug(tab) → {company, name} from Keys (cheap, cached).
  const keyInfo = await buildKeyInfo(subjectEmail);

  // One batchGet for every tab's top region (E3 + the activity table).
  const ranges = titles.map((t) => `'${t.replace(/'/g, "''")}'!A1:J60`);
  const bg = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: ssId,
    ranges,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const valueRanges = bg.data.valueRanges ?? [];

  const today = todayInIsrael();
  const projects: BudgetProject[] = [];

  valueRanges.forEach((vr, idx) => {
    const tab = titles[idx];
    const grid = (vr.values ?? []) as unknown[][];
    const cell = (r: number, c: number) => grid[r]?.[c];

    const e3 = num(cell(2, 4)); // E3
    const startIso = parseSheetDate(cell(3, 4)); // E4 עליה
    const endIso = parseSheetDate(cell(4, 4)); // E5 ירידה
    const totalDays = Math.max(1, dayDiff(startIso, endIso) || 30);
    const remainingDays = Math.max(0, dayDiff(today, endIso));
    const elapsedDays = Math.max(0, totalDays - remainingDays);
    const elapsedFrac = Math.min(1, elapsedDays / totalDays);

    // Locate the "פעילות נוכחית" marker, then its header row, then data.
    let markerRow = -1;
    for (let r = 0; r < grid.length; r++) {
      if (clean(cell(r, 1)) === "פעילות נוכחית") {
        markerRow = r;
        break;
      }
    }
    let headerRow = -1;
    if (markerRow >= 0) {
      for (let r = markerRow + 1; r < grid.length; r++) {
        if (clean(cell(r, 1)) === "התחלה" && clean(cell(r, 3)) === "מזהה BMBY") {
          headerRow = r;
          break;
        }
      }
    }

    const rows: BudgetRow[] = [];
    if (headerRow >= 0) {
      for (let r = headerRow + 1; r < grid.length; r++) {
        const b = clean(cell(r, 1));
        if (b === "total") break;
        const channel = clean(cell(r, 3)); // D
        if (!channel) continue;
        const budget = num(cell(r, 6)); // G
        const spend = num(cell(r, 7)); // H
        const platform = classifyChannel(channel);
        const expected = budget * elapsedFrac;
        const pacingRatio = expected > 0 ? spend / expected : 0;
        const dailyRequired =
          remainingDays > 0 ? (budget - spend) / remainingDays : 0;
        rows.push({
          row: r + 1,
          channel,
          campaignType: clean(cell(r, 5)),
          platform,
          budget,
          spend,
          pacingRatio,
          dailyRequired,
        });
      }
    }

    const platforms = emptyPlatforms();
    const other = emptyAgg();
    for (const row of rows) {
      const agg = row.platform === "other" ? other : platforms[row.platform];
      agg.budget += row.budget;
      agg.spend += row.spend;
      agg.rowCount += 1;
    }
    finalizeAgg(other, elapsedFrac, remainingDays);
    for (const p of E3_PLATFORMS) finalizeAgg(platforms[p], elapsedFrac, remainingDays);

    const allocated = E3_PLATFORMS.reduce((s, p) => s + platforms[p].budget, 0);
    const allocatedSpend = E3_PLATFORMS.reduce(
      (s, p) => s + platforms[p].spend,
      0,
    );
    const delta = allocated - e3;
    const reconStatus: ReconStatus =
      e3 <= 0
        ? "no-target"
        : Math.abs(delta) < 1
          ? "ok"
          : delta > 0
            ? "over"
            : "under";

    const info = keyInfo.get(tab.toLowerCase());
    projects.push({
      tab,
      name: info?.name || tab,
      company: info?.company || "",
      e3,
      startIso,
      endIso,
      totalDays,
      remainingDays,
      rows,
      platforms,
      other,
      allocated,
      allocatedSpend,
      delta,
      reconStatus,
      hasActivityTable: headerRow >= 0,
    });
  });

  return { generatedAt: new Date().toISOString(), projects };
}

function emptyAgg(): PlatformAgg {
  return { budget: 0, spend: 0, rowCount: 0, pacingRatio: 0, dailyRequired: 0 };
}
function emptyPlatforms(): Record<Platform, PlatformAgg> {
  return {
    google: emptyAgg(),
    facebook: emptyAgg(),
    taboola: emptyAgg(),
    outbrain: emptyAgg(),
  };
}
function finalizeAgg(
  agg: PlatformAgg,
  elapsedFrac: number,
  remainingDays: number,
): void {
  const expected = agg.budget * elapsedFrac;
  agg.pacingRatio = expected > 0 ? agg.spend / expected : 0;
  agg.dailyRequired =
    remainingDays > 0 ? (agg.budget - agg.spend) / remainingDays : 0;
}

async function buildKeyInfo(
  subjectEmail: string,
): Promise<Map<string, { name: string; company: string }>> {
  const out = new Map<string, { name: string; company: string }>();
  try {
    const { headers, rows } = await readKeysCached(subjectEmail);
    const iSlug = headers.findIndex((h) => /campaign\s*id/i.test(h));
    const iCompany = headers.indexOf("חברה");
    const iName = headers.findIndex((h) => /^(פרוייקט|פרויקט|project)$/i.test(h));
    for (const row of rows) {
      const slug = clean(iSlug >= 0 ? row[iSlug] : row[5]);
      if (!slug) continue;
      out.set(slug.toLowerCase(), {
        name: clean(iName >= 0 ? row[iName] : row[0]) || slug,
        company: clean(iCompany >= 0 ? row[iCompany] : row[1]),
      });
    }
  } catch {
    /* Keys read is best-effort enrichment — tab name is the fallback. */
  }
  return out;
}

const fetchBudgetMasterCrossRequest = unstable_cache(
  fetchBudgetMaster,
  ["budgetMaster"],
  { revalidate: TTL_SECONDS, tags: [CACHE_TAG] },
);

export const getBudgetMaster = cache((subjectEmail: string) =>
  fetchBudgetMasterCrossRequest(subjectEmail),
);

/** Invalidate the cross-request cache after a budget cell write. */
export function revalidateBudgetMaster(): void {
  revalidateTag(CACHE_TAG);
}
