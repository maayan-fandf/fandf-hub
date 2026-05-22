/**
 * Pure types + constants for the budget master, with NO server-only
 * imports (no googleapis / next-cache). Safe to import from the client
 * BudgetGrid as well as the server data layer (lib/budgetMaster.ts).
 */

const CLEAN = /[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g;
const clean = (s: unknown) =>
  String(s ?? "").replace(CLEAN, "").replace(/\s+/g, " ").trim();

export type Platform = "google" | "facebook" | "taboola" | "outbrain";

/** The platforms whose G allocations must sum to E3. */
export const E3_PLATFORMS: Platform[] = [
  "google",
  "facebook",
  "taboola",
  "outbrain",
];

export const PLATFORM_LABELS: Record<Platform, string> = {
  google: "Google",
  facebook: "Facebook",
  taboola: "Taboola",
  outbrain: "Outbrain",
};

/**
 * Classify a raw מזהה BMBY channel label into one of the four paid
 * platforms or "other". The labels are extremely inconsistent in the
 * sheet (90+ spellings), so this is a best-effort normalizer. Generic
 * native/content rows (article/כתבה/news/teads/jerusalempost) fall to
 * "other" by design — only explicitly-labeled Taboola/Outbrain count.
 */
export function classifyChannel(raw: string): Platform | "other" {
  const n = clean(raw).toLowerCase();
  if (!n) return "other";
  if (/taboola|טאבולה/.test(n)) return "taboola";
  if (/outbrain|אאוטבריין|אאוטברין/.test(n)) return "outbrain";
  if (/google|גוגל|discover|discovery|dicovery|pmax|dv360|\bdv\b|youtube|\byt\b/.test(n))
    return "google";
  if (/facebook|פייסבוק|\bfb\b|\bmeta\b|instagram|אינסטג/.test(n))
    return "facebook";
  return "other";
}

export type BudgetRow = {
  /** Absolute 1-based row number in the project tab (for write-back). */
  row: number;
  /** Raw מזהה BMBY label as it appears in the sheet. */
  channel: string;
  /** סוג קמפיין (col F) — campaign sub-type, e.g. GS/leadgen/wl. */
  campaignType: string;
  platform: Platform | "other";
  /** תקציב חודשי מאושר (col G) — the editable allocation. */
  budget: number;
  /** עלות (col H) — spend so far this window. */
  spend: number;
  /** spend ÷ expected-spend-by-today (>1 over-pace, <1 under-pace). */
  pacingRatio: number;
  /** (budget − spend) ÷ days-remaining — the daily budget to set so the
   *  allocation spends out exactly by the end date. */
  dailyRequired: number;
};

export type PlatformAgg = {
  budget: number;
  spend: number;
  rowCount: number;
  pacingRatio: number;
  dailyRequired: number;
};

export type ReconStatus = "ok" | "over" | "under" | "no-target";

export type BudgetProject = {
  /** Tab name == project slug (מזהה מע"פ). The write-back key. */
  tab: string;
  name: string;
  company: string;
  /** E3 — תקציב פרוגרמטי. */
  e3: number;
  startIso: string;
  endIso: string;
  totalDays: number;
  remainingDays: number;
  rows: BudgetRow[];
  platforms: Record<Platform, PlatformAgg>;
  other: PlatformAgg;
  /** Σ G across the four paid platforms. */
  allocated: number;
  allocatedSpend: number;
  /** allocated − e3. */
  delta: number;
  reconStatus: ReconStatus;
  /** False when the "פעילות נוכחית" table couldn't be located. */
  hasActivityTable: boolean;
};

export type BudgetMaster = {
  generatedAt: string;
  projects: BudgetProject[];
};
