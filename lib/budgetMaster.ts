import { cache } from "react";
import { unstable_cache, revalidateTag } from "next/cache";
import { sheetsClient } from "@/lib/sa";
import { readKeysCached } from "@/lib/keys";
import { getCampaignBudgets } from "@/lib/platformDailyBudget";
import { getMediaPlan } from "@/lib/mediaPlan";
import {
  canonicalManagers,
  classifyChannel,
  E3_PLATFORMS,
  type BudgetMaster,
  type BudgetProject,
  type BudgetRow,
  type MediaPlanRow,
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

  // Keys enrichment + actual daily budgets (creatives sheet) + media
  // plan (פריסה נוכחית) — all cached, fetched in parallel.
  const [keyInfo, budgets, mediaPlan] = await Promise.all([
    buildKeyInfo(subjectEmail),
    getCampaignBudgets(subjectEmail).catch(() => ({
      byProject: {} as Record<string, { google: number; facebook: number }>,
      campaignsBySlug: {} as Record<
        string,
        { nameLower: string; platform: "google" | "facebook"; dailyBudget: number }[]
      >,
    })),
    getMediaPlan(subjectEmail).catch(() => ({}) as Record<string, MediaPlanRow>),
  ]);

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

    const platforms = emptyPlatforms();
    const other = emptyAgg();
    const projCampaigns = budgets.campaignsBySlug[tab.toLowerCase()] || [];
    // Active-only accumulators (exclude ended channels) for the pacing
    // ratio, so a finished channel doesn't drag a platform off-pace.
    const expActive: Record<string, number> = {
      google: 0, facebook: 0, taboola: 0, outbrain: 0, other: 0,
    };
    const spendActive: Record<string, number> = {
      google: 0, facebook: 0, taboola: 0, outbrain: 0, other: 0,
    };

    const rows: BudgetRow[] = [];
    if (headerRow >= 0) {
      let lastChannel = "";
      for (let r = headerRow + 1; r < grid.length; r++) {
        const b = clean(cell(r, 1));
        if (b === "total") break;
        let channel = clean(cell(r, 3)); // D — מזהה BMBY
        const budget = num(cell(r, 6)); // G
        const spend = num(cell(r, 7)); // H
        const campaignType = clean(cell(r, 5)); // F
        // Forward-fill the channel across merged BMBY label cells (e.g.
        // Facebook split into 45-60 / 60+ audiences merges its label).
        if (!channel) {
          const hasData =
            budget !== 0 ||
            spend !== 0 ||
            !!campaignType ||
            !!b ||
            !!clean(cell(r, 2));
          if (lastChannel && hasData) channel = lastChannel;
          else continue;
        }
        lastChannel = channel;
        const platform = classifyChannel(channel);

        // Per-channel flight window (col B/C) — channels can have
        // irregular dates, so pacing + daily-required must use THIS
        // channel's own end date, not the project envelope.
        const rowStart = parseSheetDate(cell(r, 1)) || startIso;
        const rowEnd = parseSheetDate(cell(r, 2)) || endIso;
        const rowTotal = Math.max(1, dayDiff(rowStart, rowEnd) || totalDays);
        const rowRemaining = Math.max(0, dayDiff(today, rowEnd));
        const rowElapsedFrac = Math.min(
          1,
          Math.max(0, rowTotal - rowRemaining) / rowTotal,
        );
        const ended = !!rowEnd && rowEnd < today;
        const expected = budget * rowElapsedFrac;
        const pacingRatio = expected > 0 ? spend / expected : 0;
        const dailyRequired =
          rowRemaining > 0 ? (budget - spend) / rowRemaining : 0;
        // Actual daily set in the platform for THIS channel-type: sum the
        // matched creatives campaigns whose name contains the row's סוג
        // token (e.g. "GS" → ...Brand_GS + ...generic_GS, excluding
        // ...discovery). Only Google/Facebook are tracked in creatives.
        let actualDaily = 0;
        if ((platform === "google" || platform === "facebook") && campaignType) {
          const token = campaignType.toLowerCase();
          for (const c of projCampaigns) {
            if (c.platform === platform && c.nameLower.includes(token)) {
              actualDaily += c.dailyBudget;
            }
          }
        }

        rows.push({
          row: r + 1,
          channel,
          campaignType,
          platform,
          budget,
          spend,
          pacingRatio,
          dailyRequired,
          endIso: rowEnd,
          ended,
          actualDaily,
        });

        const key = platform === "other" ? "other" : platform;
        const agg = platform === "other" ? other : platforms[platform];
        agg.budget += budget;
        agg.spend += spend;
        agg.rowCount += 1;
        agg.dailyRequired += dailyRequired;
        if (!ended) {
          expActive[key] += expected;
          spendActive[key] += spend;
        }
      }
    }

    // Platform pacing over ACTIVE channels only.
    const finishPacing = (agg: PlatformAgg, key: string) => {
      agg.pacingRatio = expActive[key] > 0 ? spendActive[key] / expActive[key] : 0;
    };
    finishPacing(other, "other");
    for (const p of E3_PLATFORMS) finishPacing(platforms[p], p);

    // Actual daily budget per platform (creatives sheet) — Google + FB.
    const db = budgets.byProject[tab.toLowerCase()];
    if (db) {
      platforms.google.actualDaily = db.google || 0;
      platforms.facebook.actualDaily = db.facebook || 0;
    }

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
      managers: info?.managers || [],
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
      plan: mediaPlan[tab.toLowerCase()] || null,
    });
  });

  return { generatedAt: new Date().toISOString(), projects };
}

function emptyAgg(): PlatformAgg {
  return {
    budget: 0,
    spend: 0,
    rowCount: 0,
    pacingRatio: 0,
    dailyRequired: 0,
    actualDaily: 0,
  };
}
function emptyPlatforms(): Record<Platform, PlatformAgg> {
  return {
    google: emptyAgg(),
    facebook: emptyAgg(),
    taboola: emptyAgg(),
    outbrain: emptyAgg(),
  };
}

async function buildKeyInfo(
  subjectEmail: string,
): Promise<
  Map<string, { name: string; company: string; managers: string[] }>
> {
  const out = new Map<
    string,
    { name: string; company: string; managers: string[] }
  >();
  try {
    const { headers, rows } = await readKeysCached(subjectEmail);
    const iSlug = headers.findIndex((h) => /campaign\s*id/i.test(h));
    const iCompany = headers.indexOf("חברה");
    const iName = headers.findIndex((h) => /^(פרוייקט|פרויקט|project)$/i.test(h));
    const iMgr = headers.indexOf("מנהל קמפיינים");
    for (const row of rows) {
      const slug = clean(iSlug >= 0 ? row[iSlug] : row[5]);
      if (!slug) continue;
      out.set(slug.toLowerCase(), {
        name: clean(iName >= 0 ? row[iName] : row[0]) || slug,
        company: clean(iCompany >= 0 ? row[iCompany] : row[1]),
        managers: canonicalManagers(clean(iMgr >= 0 ? row[iMgr] : "")),
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
