/**
 * Pure types + constants for the budget master, with NO server-only
 * imports (no googleapis / next-cache). Safe to import from the client
 * BudgetGrid as well as the server data layer (lib/budgetMaster.ts).
 */

const CLEAN = /[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g;
const clean = (s: unknown) =>
  String(s ?? "").replace(CLEAN, "").replace(/\s+/g, " ").trim();

export type Platform =
  | "google"
  | "facebook"
  | "tiktok"
  | "taboola"
  | "outbrain";

/** The platforms whose G allocations must sum to E3. */
export const E3_PLATFORMS: Platform[] = [
  "google",
  "facebook",
  "tiktok",
  "taboola",
  "outbrain",
];

export const PLATFORM_LABELS: Record<Platform, string> = {
  google: "Google",
  facebook: "Facebook",
  tiktok: "TikTok",
  taboola: "Taboola",
  outbrain: "Outbrain",
};

/**
 * Classify a raw מזהה BMBY channel label into one of the four paid
 * platforms or "other". The labels are extremely inconsistent in the
 * sheet (90+ spellings), so this is a best-effort normalizer. Generic
 * native/content rows (article/כתבה/news/teads/jerusalempost) fall to
 * "other" by design — only explicitly-labeled Taboola/Outbrain/TikTok count.
 *
 * DV / DV360 / dv-360 (Display & Video 360) is NOT part of the
 * internally-managed budget (owner decision 2026-05-23) → it must be
 * caught BEFORE the Google branch and routed to "other".
 *
 * Teads is a rebrand/alias of Outbrain → classified as outbrain
 * (owner note 2026-05-23).
 */
export function classifyChannel(raw: string): Platform | "other" {
  const n = clean(raw).toLowerCase();
  if (!n) return "other";
  if (/\bdv[\s-]?360\b|\bdv\b/.test(n)) return "other";
  if (/taboola|טאבולה/.test(n)) return "taboola";
  if (/outbrain|אאוטבריין|אאוטברין|teads|טידס/.test(n)) return "outbrain";
  if (/tik[\s-]?tok|טיק[\s-]?טוק/.test(n)) return "tiktok";
  if (/google|גוגל|discover|discovery|dicovery|pmax|youtube|\byt\b/.test(n))
    return "google";
  if (/facebook|פייסבוק|\bfb\b|\bmeta\b|instagram|אינסטג/.test(n))
    return "facebook";
  return "other";
}

/**
 * The ONE shared signal_key for a project×platform pacing alert, used by
 * all three surfaces — the morning feed (Apps Script `_buildSignalKey_`),
 * this budget desk, and the dashboard project-page pacing cell — so a
 * "טיפלתי" on any of them suppresses the same alert everywhere via the
 * Firestore `alertDismissals` store. Must stay byte-identical to the Apps
 * Script `_buildSignalKey_(slug, 'pacing-variance', 'platform|'+platform)`.
 */
export function pacingPlatformKey(
  slug: string,
  platform: Platform | "other",
): string {
  const s = String(slug || "").toLowerCase().trim() || "(no-slug)";
  const p = String(platform || "").toLowerCase().trim();
  return `${s}|pacing-variance|platform|${p}`;
}

/**
 * Per-ROW (per-channel) pacing key (2026-05-25) — each channel row
 * snoozes independently, so dismissing facebook-israel no longer fades
 * facebook-ashdod. Shared across all three surfaces: the morning feed
 * (Apps Script `channel|<channel>`), this budget desk, and the dashboard
 * pacing cell (`_pacingChannelKey`). Must stay byte-identical to those.
 */
export function pacingChannelKey(slug: string, channel: string): string {
  const s = String(slug || "").toLowerCase().trim() || "(no-slug)";
  const c = String(channel || "").toLowerCase().trim() || "(no-channel)";
  return `${s}|pacing-variance|channel|${c}`;
}

/** Display order for the budget desk's manager grouping. */
export const MANAGER_ORDER = ["Maayan Sachs", "Nadav Eedelman"];
export const UNASSIGNED_MANAGER = "ללא מנהל";

/**
 * Normalize the raw Keys "מנהל קמפיינים" cell into canonical manager
 * label(s). Co-managed projects (e.g. "Maayan Sachs, nadav eedelman")
 * resolve to BOTH so each manager sees the project in their group.
 */
export function canonicalManagers(raw: string): string[] {
  const lc = (raw || "").toLowerCase();
  const out: string[] = [];
  if (/maayan|מעין/.test(lc)) out.push("Maayan Sachs");
  if (/nadav|נדב/.test(lc)) out.push("Nadav Eedelman");
  return out;
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
  /** spend ÷ expected-spend-by-today (>1 over-pace, <1 under-pace).
   *  Uses THIS channel's own flight window (col B/C), not the project
   *  envelope — channels can have irregular dates. */
  pacingRatio: number;
  /** (budget − spend) ÷ days-remaining-for-this-channel — the daily
   *  budget to set so the allocation spends out exactly by the channel's
   *  own end date. */
  dailyRequired: number;
  /** This channel's own end date (col C / סיום), ISO. May differ from
   *  the project envelope. */
  endIso: string;
  /** True when this channel's flight has already ended (endIso < today).
   *  Ended channels don't raise pacing alerts. */
  ended: boolean;
  /** Actual daily budget currently set in the platform for THIS campaign
   *  (matched by the campaign-name cell against the creatives sheet).
   *  0 when the row isn't a single named campaign or has no match. */
  actualDaily: number;
  /** Status of the FB/Google campaigns matched to this row (by סוג token):
   *  'active' all active · 'paused' all paused · 'mixed' some of each ·
   *  'none' no matched platform campaign. Drives the active/paused dot. */
  campaignStatus: "none" | "active" | "paused" | "mixed";
};

export type PlatformAgg = {
  budget: number;
  spend: number;
  rowCount: number;
  pacingRatio: number;
  dailyRequired: number;
  /** Actual daily budget currently configured in the ad platform —
   *  Σ of active campaigns' daily budgets from the creatives sheet
   *  (fb-campaigns / קמפיין ID גוגל). Only Google + Facebook are
   *  tracked there; 0 for Taboola/Outbrain. */
  actualDaily: number;
  /** Actual avg daily SPEND over the last 7 days (standardized daily
   *  file). Drives the pacing diagnosis (plan vs configured vs actual). */
  actual7d: number;
};

/** Per-project current media-plan snapshot from the "פריסה נוכחית" tab. */
export type MediaPlanRow = {
  budget: number;
  spend: number;
  spendPct: number;
  leads: number;
  cpl: number;
  meetings: number;
  meetingPct: number;
  startIso: string;
  endIso: string;
  timePct: number;
};

export type ReconStatus = "ok" | "over" | "under" | "no-target";

export type BudgetProject = {
  /** Tab name == project slug (מזהה מע"פ). The write-back key. */
  tab: string;
  name: string;
  company: string;
  /** Google Ads Customer ID (digits) for this project's account, resolved
   *  Keys "Google ads account" → Accounts-lookup col G. Empty if unknown.
   *  Used as the `Account` column for Editor's multi-account import. */
  gAdsAccountId?: string;
  /** Readable ad-account names from Keys — surfaced as an "Account name"
   *  helper column in the budget export (sorting / sanity-check). */
  gAdsAcctName?: string;
  fbAcctName?: string;
  /** Canonical campaign-manager label(s) from Keys (מנהל קמפיינים).
   *  Co-managed projects list more than one. Empty = unassigned. */
  managers: string[];
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
  /** Current media-plan snapshot (פריסה נוכחית) for the הראה פריסה panel. */
  plan: MediaPlanRow | null;
};

export type BudgetMaster = {
  generatedAt: string;
  projects: BudgetProject[];
};
