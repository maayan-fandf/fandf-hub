/**
 * Pure types + math for the NATIVE project report — the in-hub rebuild of
 * the Apps Script dashboard (phase 1: top-funnel + trends). Shared by the
 * server reader (lib/reportData.ts) and the client tab components, so keep
 * this module free of server-only imports.
 *
 * Every formula here mirrors the Apps Script source exactly so the native
 * numbers stay byte-identical with the legacy iframe while both run in
 * parallel: sumAdPlatform (Index.html:7606), kpiAlert (:7833), deltaBadge
 * (:7872), renderFunnelDiagnosis (:7900), the top-funnel derived ratios
 * (:7993). Change them only together with the Apps Script until the
 * legacy report is retired.
 *
 * MEETING BASIS. Every תיאומים / ביצועים field in these payload types
 * follows one convention (the full statement lives in lib/meetingBasis):
 * no prefix = LEAD-ENTRY (לפי כניסת ליד), `dated*` = MEETING-DATE (לפי
 * מועד הפגישה), `undefined` = that basis has no source → render "—", never
 * the other basis. The page-level switch picks one; the swap helpers at
 * the bottom of this file (applyBasisToChannels / applyBasisToCreatives /
 * totalsForBasis) are the only place a surface should turn the pair into
 * the numbers it shows.
 */

import type { MeetingBasis } from "@/lib/meetingBasis";

export type { MeetingBasis } from "@/lib/meetingBasis";

export type ReportPlat = "google" | "facebook" | "taboola" | "outbrain";

export const REPORT_PLATS: ReportPlat[] = [
  "google",
  "facebook",
  "taboola",
  "outbrain",
];

export const PLAT_LABELS: Record<ReportPlat, string> = {
  facebook: "Facebook",
  google: "Google",
  taboola: "Taboola",
  outbrain: "Outbrain",
};

/** Darkest→lightest shade ramps — biggest pie slice gets the darkest.
 *  Same palettes as the legacy `_AD_PLATFORM_PIE_PALETTES_`. */
export const PLAT_PALETTES: Record<ReportPlat, string[]> = {
  facebook: ["#1e3a8a", "#1d4ed8", "#2563eb", "#3b82f6", "#60a5fa", "#93c5fd"],
  google: ["#7f1d1d", "#991b1b", "#b91c1c", "#dc2626", "#ef4444", "#f87171"],
  taboola: ["#064e3b", "#047857", "#059669", "#10b981", "#34d399", "#6ee7b7"],
  outbrain: ["#7c2d12", "#9a3412", "#c2410c", "#ea580c", "#f97316", "#fb923c"],
};

/** The mid-tone brand color per platform (used for dots/labels). */
export const PLAT_COLORS: Record<ReportPlat, string> = {
  facebook: "#2563eb",
  google: "#dc2626",
  taboola: "#059669",
  outbrain: "#ea580c",
};

export type PlatCampaign = {
  name: string;
  imp: number;
  clk: number;
  cost: number;
  leads: number;
};

export type PlatTotals = {
  impressions: number;
  clicks: number;
  cost: number;
  /** Google rows sum their leads column here (legacy: out.google.conversions). */
  conversions: number;
  /** FB / Taboola / Outbrain leads (legacy: out.<plat>.leads). */
  leads: number;
  campaigns: PlatCampaign[];
};

export type AdPlatform = Record<ReportPlat, PlatTotals>;

export type DailyPoint = {
  date: string; // YYYY-MM-DD
  cost: number;
  leads: number;
  impressions: number;
  clicks: number;
};

export type SmTotals = {
  impressions: number;
  clicks: number;
  cost: number;
  ctr: number;
  cpc: number;
  /** Google-only ("המרות (Google)" card stays Google-specific). */
  conversions: number;
  /** Facebook-only. */
  fbLeads: number;
  /** Taboola + Outbrain leads folded into funnel ratios. */
  otherLeads: number;
};

export type ReportWindow = { startIso: string; endIso: string };

export type ReportSubCampaign = {
  name: string;
  spend: number;
  budget: number;
  leads: number;
  scheduled: number;
  meetings: number;
};

/** A תיאומים / ביצועים pair on ONE basis, in the ערוצים vocabulary
 *  (`meetings` = ביצועים). */
export type ReportMeetingTotals = { scheduled: number; meetings: number };

/** A תיאומים / ביצועים pair on ONE basis, in the קמפיינים vocabulary
 *  (`held` = ביצועים). */
export type ReportMeetingPair = { scheduled: number; held: number };

/**
 * Where a project's dated meeting counts came from, and how far they can
 * be trusted. Rendered as the caption under the ערוצים table so the reader
 * can see what the page-level "לפי מועד הפגישה" switch is showing. Its
 * presence is also the ערוצים/overview availability test for the dated
 * basis: null ⇒ no dated source ⇒ "—".
 */
export type DatedSourceInfo = {
  platform: "bmby" | "sehel" | "salesforce";
  /** "authoritative" ⇒ the source records a per-MEETING outcome.
   *  "partial" ⇒ some meetings have no resolved outcome, so the held
   *  figure is a floor rather than a count (Sehel). */
  heldConfidence: "authoritative" | "partial";
  /** Meetings in the window still awaiting an outcome. */
  unresolved: number;
  /** Dated meetings that matched NO channel row in the table — either the
   *  lead carried no source, or its channel has no spend row (BMBY's
   *  "other"/minisite, say). Surfaced because the dated column's total
   *  would otherwise look inexplicably short against the funnel. */
  unmatchedScheduled: number;
  unmatchedMeetings: number;
  /** Dated meetings whose source names a channel this project splits into
   *  several rows — a lead logged as plain "google-search" where the table
   *  separates brand / generic / competitors. The CRM cannot say which row
   *  earned it, so it is reported here rather than assigned to one row or
   *  (as an earlier version did) to all of them. */
  ambiguousScheduled: number;
  ambiguousMeetings: number;
};

/** One row of the ערוצים tab — an ALL CLIENTS channel row enriched with
 *  platform attribution + pacing inputs (legacy `p.channels[i]`). */
export type ReportChannel = {
  channel: string;
  /** classifyChannel bucket ("google"/"facebook"/… or "other"). */
  platform: string;
  budget: number;
  spend: number;
  leads: number;
  /** ALL CLIENTS `לידים פיקסל` — the platform/pixel-recorded event count
   *  for the same window, the internal cross-check against CRM `leads`.
   *  Feeds the לידים cell's tooltip + divergence ⚠️. undefined ⇒ nothing
   *  was measured: the cell is blank (no pixel on this channel), the column
   *  is missing, or this is a client render (NativeProjectRail strips it
   *  from the payload). A numeric 0 is the opposite — a tracked channel
   *  that fired no events — and must survive to the tooltip. */
  pixelLeads?: number;
  /** Of `leads`, how many are NEW — read from the same CRM report cells
   *  the row's `לידים CRM` formula sums (lib/crmSheetSplits). `leads` itself
   *  counts returning (and on some tabs duplicate) inquiries too, so the
   *  cell reads "26 (11 חדשים)". Live mode only; undefined when the
   *  project's formula or report layout cannot be read. */
  newLeads?: number;
  /**
   * תיאומים / ביצועים on the LEAD-ENTRY basis. Where they come from:
   *   live mode   — the ALL CLIENTS current row (pushed daily; matched the
   *                 BMBY owner-lead rule exactly on The 57).
   *   month mode  — owner decision D1: the LIVE warehouse lead-entry count
   *                 (BMBY owner-lead / Sehel registration cohort) attributed
   *                 to the rows like range mode, NOT the frozen חודשי
   *                 literals. Salesforce keeps its frozen חודשי numbers.
   *   range mode  — the CRM funnel's lead-entry source maps via
   *                 buildAttributor.
   */
  scheduled: number;
  meetings: number;
  /** Of the live `scheduled` — the sheet's `תיאום וביטול`, which counts
   *  cancelled meetings too — how many were cancelled: "4 (1 בוטלו)". Read
   *  from the formula's own cancellation terms (lib/crmSheetSplits). Live
   *  mode, lead-entry basis only: applyBasisToChannels drops it with the
   *  dated swap, since it is a part of THIS number and no other. */
  cancelledScheduled?: number;
  /**
   * The SAME two stages counted by when the meeting actually HAPPENED,
   * rather than by when the lead was created (which is what `scheduled`
   * and `meetings` above are). Sourced per CRM platform — see
   * lib/datedChannelMeetings.ts for why the two differ and by how much.
   *
   * undefined ⇒ no dated source for this project's CRM (and then
   * `ProjectReportData.datedSource` is null): the cells render "—" under the
   * dated basis. When a dated source exists every row carries both fields,
   * 0 included, so a row with no meetings reads 0 rather than "—".
   * Meetings no row could claim are NOT in any row — they are
   * datedSource.unmatched* / ambiguous* (the "לא שויכו לשורה" row).
   */
  datedScheduled?: number;
  datedMeetings?: number;
  /** Range mode only: this row's עלות is wholly or partly a pro-rated
   *  share of a monthly figure rather than summed daily spend. Set by
   *  buildRangeReportChannels; it both drives the tab's disclosure note and
   *  suppresses the per-row trend popover, because no daily series exists
   *  that adds up to an estimated number — showing one would put a total
   *  in the popover that contradicts the cell beside it. */
  spendEstimated?: boolean;
  /** Sheet קצב יומי — the required daily budget ((G−H)/days-left). */
  dailyRate: number;
  startIso: string;
  endIso: string;
  costPerLead: number;
  costPerScheduled: number;
  costPerMeeting: number;
  subCampaigns: ReportSubCampaign[];
  /** Σ ACTIVE matched platform campaigns' configured daily budgets;
   *  null when the channel has no סוג tokens / no campaign matched. */
  configuredDaily: number | null;
  /** Live/paused dot (legacy c.campaignStatus). */
  campaignStatus: "none" | "active" | "paused" | "mixed";
  /** Platform-level trailing-7-day average daily spend — attached only
   *  when this row is its platform's ONLY channel (else the platform
   *  average would be meaningless per-row). */
  avg7d: number | null;
  /** Daily series for THIS ROW's campaigns only — the same campaigns
   *  `configuredDaily` sums, matched by the row's סוג tokens. Feeds the
   *  ערוצים trend popover so it stops showing the whole platform on every
   *  row of that platform (cazar's two facebook rows both reported the
   *  platform's ₪6,921 / 15 leads while their own cells read ₪4,877/12 and
   *  ₪2,044/0 — and the popover header prints the channel name, so it read
   *  as that row's data). Undefined when the row has no tokens or nothing
   *  matched; the client then falls back to the platform series. */
  daily?: DailyPoint[];
};

/**
 * How the ערוצים table's free-range rows were assembled, so the tab can
 * say it rather than presenting estimates as measurements.
 *
 * A free range crosses two different kinds of source: money that is
 * recorded per day (and so can be summed exactly) and money that is
 * recorded per month (and so can only be apportioned). The reader is
 * entitled to know which cells are which.
 */
export type RangeBasis = {
  /** Channels whose spend is REAL platform spend summed over the range. */
  realSpend: string[];
  /** Channels whose spend was pro-rated out of ALL CLIENTS monthly rows. */
  prorated: string[];
  /** Where the לידים / תיאומים / ביצועים columns came from. */
  outcomes: "crm" | "prorated";
  /** CRM leads in the window that no table row could claim, and those the
   *  CRM knows about but cannot split between rows sharing a canonical
   *  channel. Both are zero on the "prorated" path. */
  unattributedLeads: number;
  ambiguousLeads: number;
  /** Total leads the CRM counted in the window (the denominator for the
   *  two above). */
  totalCrmLeads: number;
  /**
   * The rule behind the CRM maps the תיאומים / ביצועים columns were taken
   * from (CrmMeetingBasisInfo.lead), when `outcomes` is "crm"; null on the
   * "prorated" path. Range mode takes whatever maps the funnel has, and on
   * a Sheet-routed Sehel project or a BMBY D3 fallback those are a
   * "status-snapshot" — LEADS by current stage, not meeting events — which
   * month mode refuses outright (MonthLeadSource "no-warehouse"). A range
   * keeps the numbers (design §2.3) but must say what unit they are in, so
   * the tab reads this rather than captioning them as lead-entry events.
   * Optional only so a payload built before it existed still type-checks.
   */
  leadRule?: "owner-lead" | "registration-cohort" | "status-snapshot" | null;
  /** With leadRule "status-snapshot": the snapshot is BMBY's D3 fallback
   *  (the warehouse does not cover the range), not a CRM that only records
   *  statuses — picks FIXED_BADGES.warehouseFallback's wording. */
  warehouseFallback?: boolean;
};

/**
 * Month mode only: where the ערוצים rows' LEAD-ENTRY תיאומים / ביצועים —
 * and so `totals.scheduled` / `totals.meetings` — came from (owner decision
 * D1, lib/meetingBasis). Set by lib/reportData.
 *
 * ALL CLIENTS' חודשי rows are literals pasted at month end, while every
 * other lead-entry surface (קמפיינים joins, CRM tiles) is recomputed live —
 * and lead-entry keeps growing after the month closes. So a past month
 * reads the live warehouse count instead, attributed to the rows the way
 * range mode does. Leads, spend and every other column stay ALL CLIENTS.
 */
export type MonthLeadSource = {
  /** "warehouse" — the live CRM lead-entry count (BMBY owner-lead / Sehel
   *  registration cohort). "frozen" — the ALL CLIENTS חודשי numbers. */
  source: "warehouse" | "frozen";
  /**
   * Why frozen (absent when source is "warehouse"):
   *   "salesforce"   no warehouse — the frozen numbers ARE the intended
   *                  source (D1), not a caveat.
   *   "no-crm"       no CRM mapping, or the funnel could not be read.
   *   "no-warehouse" the funnel's lead maps are a status snapshot of leads,
   *                  not events. On Sehel that is the Sheet route — the
   *                  CRM source itself records statuses. On BMBY it is the
   *                  D3 fallback: BMBY records meeting events, but the
   *                  warehouse does not cover this month (flag off or
   *                  unreachable, no project_id / journey, or crmData's
   *                  warehouseCoversWindow failed), so the caption names
   *                  coverage, not the CRM, as the reason.
   *   "low-coverage" the CRM's source names cover under half of the month's
   *                  CRM leads (range mode's rule), so a live split would
   *                  read as zeros next to real spend.
   * Everything but "salesforce" is a fallback the table should label.
   */
  frozenReason?: "salesforce" | "no-crm" | "no-warehouse" | "low-coverage";
  platform: "bmby" | "sehel" | "salesforce" | null;
  /** The funnel's lead-entry rule when one was read (CrmMeetingBasisInfo.lead). */
  rule: "owner-lead" | "registration-cohort" | "status-snapshot" | null;
  /** The coverage test's numbers (0 when no funnel was read). */
  totalCrmLeads: number;
  attributedLeads: number;
  /** Live lead-entry meetings no row could claim / several rows share.
   *  NOT in any row and NOT in `totals` — lead-entry totals are Σ rows by
   *  design, in every mode — and named in the ערוצים caption instead, which
   *  is what reconciles the table with the CRM card. Zero when frozen. */
  unattributed: ReportMeetingTotals;
  ambiguous: ReportMeetingTotals;
  /** Live lead-entry meetings the CRM counted but filed under no source at
   *  all (the funnel's scalar tiles minus Σ its maps): a Sehel registration
   *  with a blank source, a BMBY owner lead with neither media_source_clean
   *  nor channel_key. Same treatment as the two above. Optional only so a
   *  payload built before it existed still type-checks; zero when frozen. */
  unsourced?: ReportMeetingTotals;
  /** Σ of the חודשי numbers, whichever source won — what the table showed
   *  before D1, for an internal "was N" note. */
  frozen: ReportMeetingTotals;
};

export type ProjectReportData = {
  project: string;
  slug: string;
  mode: "live" | "month" | "range";
  window: ReportWindow;
  prevWindow: ReportWindow | null;
  adPlatform: AdPlatform;
  prevAdPlatform: AdPlatform | null;
  /** Full unfiltered per-platform daily series (client windows it). */
  daily: Record<ReportPlat, DailyPoint[]>;
  /** Google daily split into Search vs Discovery-family (PMax / Demand-Gen
   *  / Display) by campaign name, so the ערוצים trend popover can show a
   *  distinct series for google-search vs google-discovery — `daily.google`
   *  is the combined platform series that made both rows look identical. */
  dailyGoogleByKind?: { search: DailyPoint[]; discovery: DailyPoint[] };
  /** ALL CLIENTS channel rows enriched for the ערוצים tab. In range mode
   *  these are folded across the months the range spans — see
   *  reportData's buildRangeReportChannels and `rangeBasis` below. */
  channels: ReportChannel[];
  /** Provenance for the channels' `datedScheduled`/`datedMeetings`. Null ⇒
   *  this table has no dated source: under the page switch's לפי מועד
   *  הפגישה its meeting cells render "—". Non-null with zeros is a mapped,
   *  synced period with no meetings. Also one of the two inputs to the
   *  switch's availability (NativeProjectRail → MeetingBasisAvailability). */
  datedSource: DatedSourceInfo | null;
  /** How the free-range channel rows were derived. Null outside range
   *  mode, where every number comes from one ALL CLIENTS row and there is
   *  nothing to disclose. */
  rangeBasis: RangeBasis | null;
  /** Month mode's lead-entry meeting source (D1). null in live and range
   *  mode, and in a month with no ALL CLIENTS rows (nothing to replace).
   *  Optional only so payloads built before lib/reportData set it still
   *  type-check. */
  monthLeadSource?: MonthLeadSource | null;
  /** קריאייטיבים tab data (null when the creative sheet has nothing
   *  for the project or the fetch failed — the tab shows an empty note). */
  creatives: ReportCreatives | null;
  /** Company (Keys חברה) — for the header tag. */
  company: string;
  /** Landing page URL string (may hold several space/comma-separated). */
  landingUrl: string;
  /** Budget-pacing badge + bars (null in range mode). */
  pacing: ReportPacing | null;
  /** End-of-period forecast strip (live mode only; null otherwise). */
  forecast: ReportForecast | null;
  /** Period-over-period anomaly chips. */
  anomalies: ReportAnomaly[];
  /** Previous-month funnel (day-ratio-scaled) — feeds the util delta. */
  prevFunnel: PrevFunnel | null;
  /** Per-channel monthly rows for the historical-trend section. */
  monthlyRaw: MonthlyChannelRow[];
  /** Today (Asia/Jerusalem) — server-injected so the monthly-trend
   *  projection agrees between SSR and client. */
  todayIso: string;
  /** Budget-desk tab name (== מזהה מע"פ) — the write key for inline
   *  budget-cell edits (/api/campaigns/budget lookup mode). "" when the
   *  budget master didn't resolve the project. */
  tabSlug: string;
  /** Budget-desk summary for the תקציב חודשי strip (live mode, internal
   *  only; null when unavailable). */
  budgetSummary: {
    e3: number;
    allocated: number;
    delta: number;
    remainingDays: number;
    totalDays: number;
  } | null;
  /** ALL CLIENTS per-channel rows for the window mode ([] in range mode).
   *  `scheduled` / `meetings` here are LEAD-ENTRY. */
  totals: {
    budget: number;
    spend: number;
    leads: number;
    relevant: number;
    scheduled: number;
    meetings: number;
    sales: number;
  } | null;
  /**
   * The overview's תיאומים / ביצועים on the MEETING-DATE basis:
   *   Σ channels[].datedScheduled + datedSource.unmatchedScheduled
   *     + datedSource.ambiguousScheduled
   * (and the same for meetings), so it equals the ערוצים סה״כ row including
   * its "לא שויכו לשורה" line, and the dated funnel cards divide spend by it.
   *
   * null ⇒ no dated source (datedSource is null) → the cards show "—".
   * Optional only so payloads built before the report reader sets it still
   * type-check; read it through totalsForBasis(), which treats undefined as
   * null.
   */
  datedTotals?: ReportMeetingTotals | null;
};

export function emptyPlatTotals(): PlatTotals {
  return {
    impressions: 0,
    clicks: 0,
    cost: 0,
    conversions: 0,
    leads: 0,
    campaigns: [],
  };
}

export function emptyAdPlatform(): AdPlatform {
  return {
    google: emptyPlatTotals(),
    facebook: emptyPlatTotals(),
    taboola: emptyPlatTotals(),
    outbrain: emptyPlatTotals(),
  };
}

/** Legacy `sumAdPlatform` (Index.html:7606). */
export function sumAdPlatform(ap: AdPlatform): SmTotals {
  const g = ap.google;
  const f = ap.facebook;
  const t = ap.taboola;
  const o = ap.outbrain;
  const imp = g.impressions + f.impressions + t.impressions + o.impressions;
  const clk = g.clicks + f.clicks + t.clicks + o.clicks;
  const cost = g.cost + f.cost + t.cost + o.cost;
  return {
    impressions: imp,
    clicks: clk,
    cost,
    ctr: imp > 0 ? clk / imp : 0,
    cpc: clk > 0 ? cost / clk : 0,
    conversions: g.conversions,
    fbLeads: f.leads,
    otherLeads: t.leads + o.leads,
  };
}

/** Paid-ad-attributable leads (NOT the CRM total — see Index.html:7984). */
export function adLeadsOf(sm: SmTotals): number {
  return sm.fbLeads + sm.conversions + sm.otherLeads;
}

export type KpiTone = "" | "red" | "amber" | "green";

/** Legacy `kpiAlert` thresholds (Index.html:7833). Low-volume skips. */
export function kpiAlert(
  metric: string,
  value: number,
  ctx: { impressions: number; clicks: number; fbCost: number; googleCost: number },
): KpiTone {
  if (metric === "ctr" && ctx.impressions > 500) {
    if (value < 0.005) return "red";
    if (value < 0.01) return "amber";
    if (value >= 0.02) return "green";
  }
  if (metric === "clickToLead" && ctx.clicks > 50) {
    if (value === 0) return "red";
    if (value < 0.02) return "amber";
    if (value >= 0.1) return "green";
  }
  if (metric === "impToLead" && ctx.impressions > 5000) {
    if (value === 0) return "red";
    if (value < 0.0005) return "amber";
  }
  if (metric === "fbLeads" && ctx.fbCost > 200) {
    if (value === 0) return "red";
  }
  if (metric === "conversions" && ctx.googleCost > 200) {
    if (value === 0) return "red";
  }
  return "";
}

/** Cost-per-outcome tone for the funnel-flow cards (Index.html:7856):
 *  costPerScheduled ≤2000 green / ≤3000 amber / else red;
 *  costPerMeeting ≤5000 / ≤9000 / else red. Value 0 → no tone. */
export function costPerTone(
  metric: "costPerScheduled" | "costPerMeeting",
  value: number,
): KpiTone {
  if (!value || value <= 0) return "";
  if (metric === "costPerScheduled")
    return value <= 2000 ? "green" : value <= 3000 ? "amber" : "red";
  return value <= 5000 ? "green" : value <= 9000 ? "amber" : "red";
}

export type DeltaInfo = {
  /** "none" (·/— under 3% or neutral), "new" (prev=0), "good", "bad". */
  cls: "none" | "new" | "good" | "bad";
  arrow: string;
  /** "+12%" style text ("" for the new/none-both-zero cases). */
  text: string;
  prev: number;
};

/** Legacy `deltaBadge` semantics (Index.html:7872). Null = no previous data. */
export function deltaInfo(
  current: number,
  previous: number | null | undefined,
  goodDir: "up" | "down" | "neutral",
): DeltaInfo | null {
  if (previous == null) return null;
  const prev = Number(previous) || 0;
  const cur = Number(current) || 0;
  if (prev === 0 && cur === 0)
    return { cls: "none", arrow: "", text: "—", prev };
  if (prev === 0) return { cls: "new", arrow: "", text: "חדש", prev };
  const pct = (cur - prev) / prev;
  const arrow = cur > prev ? "▲" : cur < prev ? "▼" : "•";
  let cls: DeltaInfo["cls"];
  if (goodDir === "neutral" || Math.abs(pct) < 0.03) cls = "none";
  else {
    const isBetter = goodDir === "down" ? cur < prev : cur > prev;
    cls = isBetter ? "good" : "bad";
  }
  return {
    cls,
    arrow,
    text: (pct >= 0 ? "+" : "") + (pct * 100).toFixed(0) + "%",
    prev,
  };
}

export type FunnelDx = {
  kind: "nodata" | "site" | "quality" | "ads" | "mixed" | "ok";
  icon: string;
  /** Hebrew verdict — trusted, self-authored HTML (only <b> tags). */
  verdictHtml: string;
  /** Platforms with spend/impressions but zero clicks (tracking gap). */
  integrity: string[];
  ctrNow: number;
  cvrNow: number;
  ctrDelta: number;
  cvrDelta: number;
  ctrState: "down" | "up" | "stable";
  cvrState: "down" | "up" | "stable";
};

/**
 * Legacy `renderFunnelDiagnosis` (Index.html:7900) — CTR (ad) vs
 * click→lead CVR (site/traffic) current-vs-previous, naming the culprit.
 * Returns null when there is no previous window to compare against.
 */
export function diagnoseTopFunnel(
  sm: SmTotals,
  prevSm: SmTotals | null,
  ap: AdPlatform,
  prev: AdPlatform | null,
): FunnelDx | null {
  if (!prevSm) return null;
  const MIN_CLK = 30,
    MIN_IMP = 1000,
    TH = 0.15;
  const adLeads = adLeadsOf(sm);
  const prevAdLeads = adLeadsOf(prevSm);
  const cvrNow = sm.clicks > 0 ? Math.min(adLeads / sm.clicks, 1) : 0;
  const cvrPrev =
    prevSm.clicks > 0 ? Math.min(prevAdLeads / prevSm.clicks, 1) : 0;
  const ctrNow = sm.ctr || 0,
    ctrPrev = prevSm.ctr || 0;
  const rel = (n: number, p: number) => (p > 0 ? (n - p) / p : n > 0 ? 1 : 0);

  const plats: { name: string; now: PlatTotals; prev: PlatTotals; leadKey: "leads" | "conversions" }[] = [
    { name: "Facebook", now: ap.facebook, prev: prev?.facebook ?? emptyPlatTotals(), leadKey: "leads" },
    { name: "Google", now: ap.google, prev: prev?.google ?? emptyPlatTotals(), leadKey: "conversions" },
    { name: "Taboola", now: ap.taboola, prev: prev?.taboola ?? emptyPlatTotals(), leadKey: "leads" },
    { name: "Outbrain", now: ap.outbrain, prev: prev?.outbrain ?? emptyPlatTotals(), leadKey: "leads" },
  ];
  const integrity: string[] = [];
  const declinedCvr: string[] = [];
  let activeCvr = 0;
  for (const pl of plats) {
    const cN = pl.now.clicks,
      cP = pl.prev.clicks;
    if ((pl.now.cost > 0 || pl.now.impressions > MIN_IMP) && cN === 0)
      integrity.push(pl.name);
    if (cN >= MIN_CLK && cP >= MIN_CLK) {
      activeCvr++;
      const cvN = Math.min(pl.now[pl.leadKey] / cN, 1);
      const cvP = Math.min(pl.prev[pl.leadKey] / cP, 1);
      if (rel(cvN, cvP) <= -TH) declinedCvr.push(pl.name);
    }
  }

  if (sm.clicks < MIN_CLK || sm.impressions < MIN_IMP || prevSm.clicks < MIN_CLK) {
    return {
      kind: "nodata",
      icon: "🔬",
      verdictHtml: `אין מספיק נפח להשוואה אמינה בתקופה הזו (צריך ≥${MIN_CLK} קליקים בשתי התקופות).`,
      integrity,
      ctrNow,
      cvrNow,
      ctrDelta: 0,
      cvrDelta: 0,
      ctrState: "stable",
      cvrState: "stable",
    };
  }

  const ctrD = rel(ctrNow, ctrPrev),
    cvrD = rel(cvrNow, cvrPrev);
  const cls = (d: number): "down" | "up" | "stable" =>
    d <= -TH ? "down" : d >= TH ? "up" : "stable";
  const ctrS = cls(ctrD),
    cvrS = cls(cvrD);

  let kind: FunnelDx["kind"], icon: string, verdictHtml: string;
  if (cvrS === "down" && ctrS !== "down") {
    if (declinedCvr.length >= 2) {
      kind = "site";
      icon = "🌐";
      verdictHtml = `כנראה בעיה ב<b>אתר / דף הנחיתה</b> — ה-CVR ירד <b>בכל הפלטפורמות</b> (${declinedCvr.join(", ")}) בעוד ה-CTR יציב. דף הנחיתה הוא המכנה המשותף — בדקו שינוי בעמוד, תקלת טופס, מהירות טעינה, התאמת הצעה.`;
    } else if (declinedCvr.length === 1 && activeCvr >= 2) {
      kind = "quality";
      icon = "🎯";
      verdictHtml = `ירידת CVR ב-<b>${declinedCvr[0]}</b> בלבד (שאר הפלטפורמות יציבות) — כנראה <b>איכות תנועה/קהל</b> בפלטפורמה הזו, לא האתר.`;
    } else {
      kind = "site";
      icon = "🌐";
      verdictHtml = `ה-CVR ירד וה-CTR יציב — כנראה <b>האתר/דף הנחיתה</b> או איכות התנועה. (פלטפורמה פעילה אחת — לא ניתן לבודד לחלוטין.) בדקו את דף הנחיתה.`;
    }
  } else if (ctrS === "down" && cvrS !== "down") {
    kind = "ads";
    icon = "🎯";
    verdictHtml = `כנראה בעיה ב<b>מודעות</b> (קריאייטיב/קהל) — ה-CTR ירד וה-CVR יציב. בדקו עייפות קריאייטיב + רענון, ותדירות/קהל.`;
  } else if (ctrS === "down" && cvrS === "down") {
    kind = "mixed";
    icon = "⚠️";
    verdictHtml = `ירידה <b>רוחבית</b> — גם ה-CTR וגם ה-CVR ירדו. בדקו הצעה/מסר, עונתיות, או <b>תקלת מעקב המרות</b> (לא רק מודעה או אתר).`;
  } else if (ctrS === "up" && cvrS === "down") {
    kind = "quality";
    icon = "ℹ️";
    verdictHtml = `ה-CTR <b>עלה</b> אך ה-CVR <b>ירד</b> — המודעות מביאות תנועה רחבה/זולה אך פחות איכותית. בדקו התאמת קהל/הצעה.`;
  } else {
    kind = "ok";
    icon = "✅";
    verdictHtml = `המשפך <b>יציב</b> — אין ירידה משמעותית ב-CTR או ב-CVR לעומת התקופה הקודמת.`;
  }

  return {
    kind,
    icon,
    verdictHtml,
    integrity,
    ctrNow,
    cvrNow,
    ctrDelta: ctrD,
    cvrDelta: cvrD,
    ctrState: ctrS,
    cvrState: cvrS,
  };
}

/* ------------------------------ header math ------------------------------ */

export type ReportPacing = {
  cls: "green" | "yellow" | "red" | "neutral";
  label: string;
  detail: string;
  spendPct: number;
  dayPct: number;
};

/** Legacy computePacing (Index.html:4387). `todayIso` = Asia/Jerusalem
 *  day, injected so server + client agree. */
export function computePacing(
  totals: { budget: number; spend: number },
  window: ReportWindow,
  todayIso: string,
): ReportPacing {
  if (!totals.budget)
    return { cls: "neutral", label: "אין תקציב", detail: "", spendPct: 0, dayPct: 0 };
  const spendPct = (totals.spend / totals.budget) * 100;
  let dayPct: number | null = null;
  if (window.startIso && window.endIso) {
    const start = Date.parse(window.startIso);
    const end = Date.parse(window.endIso);
    const today = Date.parse(todayIso);
    const total = end - start;
    if (total > 0)
      dayPct = Math.max(0, Math.min(100, ((today - start) / total) * 100));
  }
  if (dayPct === null)
    return { cls: "neutral", label: "תאריכים חסרים", detail: "", spendPct, dayPct: 0 };
  if (dayPct === 0)
    return { cls: "neutral", label: "טרם החל", detail: "", spendPct, dayPct };
  const ratio = spendPct / dayPct;
  const detail = `תקציב ${Math.round(spendPct)}% · ימים ${Math.round(dayPct)}%`;
  if (ratio >= 0.9 && ratio <= 1.1)
    return { cls: "green", label: "בקצב תקין", detail, spendPct, dayPct };
  if (ratio >= 0.7 && ratio <= 1.3)
    return { cls: "yellow", label: "יש לבדוק", detail, spendPct, dayPct };
  if (ratio < 0.7)
    return { cls: "red", label: "מתחת לקצב", detail, spendPct, dayPct };
  return { cls: "red", label: "מעל הקצב", detail, spendPct, dayPct };
}

/** One raw per-channel monthly row (from ALL CLIENTS חודשי rows). */
export type MonthlyChannelRow = {
  month: string;
  channel: string;
  spend: number;
  leads: number;
  scheduled: number;
  meetings: number;
  budget: number;
};

/** One aggregated calendar-month row (from ALL CLIENTS חודשי rows). */
export type MonthlyRow = {
  month: string; // YYYY-MM
  spend: number;
  leads: number;
  scheduled: number;
  meetings: number;
  budget: number;
};

export type ProjMetric = "spend" | "leads" | "scheduled" | "meetings";

export type ProjectionPrimitives = {
  currentMonthKey: string;
  daysInMonth: number;
  dayOfMonth: number;
  monthPct: number;
  currentIdx: number;
  isCurrentPartial: boolean;
  isStrictlyMonthly: boolean;
  hasHistory: boolean;
  periodStartMonth: string;
  periodEndMonth: string;
  monthBudget: number | null;
  /** monthly array, possibly with a synthesized current-month placeholder. */
  monthly: MonthlyRow[];
  liveSoFar: (m: ProjMetric) => number;
  historicalBaseline: (m: ProjMetric) => number | null;
  significanceGate: (family: "spend" | "counts") => boolean;
  segmentProjection: (m: ProjMetric) => number | null;
};

/**
 * Legacy `buildProjectionPrimitives` (Index.html:8198) — the shared
 * projection engine behind the מגמה היסטורית mini cards' current-month
 * dot + the forecast strip. `todayIso` (Asia/Jerusalem) is injected so
 * server + client agree. `totals` = the live נוכחי window totals (p.totals);
 * `monthly` = the (channel-filtered) per-month aggregate; `window` = the
 * project flight envelope. Byte-for-byte with the Apps Script.
 */
export function buildProjectionPrimitives(
  monthlyIn: MonthlyRow[],
  totals: { spend: number; leads: number; scheduled: number; meetings: number; budget: number },
  window: ReportWindow,
  todayIso: string,
): ProjectionPrimitives {
  const monthly = monthlyIn.map((r) => ({ ...r }));
  const [ty, tm, td] = todayIso.split("-").map(Number);
  const currentMonthKey = `${ty}-${String(tm).padStart(2, "0")}`;
  const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const dayOfMonth = td;
  const monthPct = daysInMonth > 0 ? dayOfMonth / daysInMonth : 0;

  const hasData = (r: MonthlyRow) =>
    (r.spend || 0) + (r.leads || 0) + (r.scheduled || 0) + (r.meetings || 0) > 0;
  let currentIdx = monthly.findIndex((r) => r.month === currentMonthKey);

  const periodStartMonth = window.startIso ? window.startIso.slice(0, 7) : "";
  const periodEndMonth = window.endIso ? window.endIso.slice(0, 7) : "";
  const isStrictlyMonthly =
    !!periodStartMonth && !!periodEndMonth && periodStartMonth === periodEndMonth;

  // Period-validity: fixed-period → now ∈ [start, end]; monthly-recurring
  // (start only) → always in-period; no start → false. Compare ISO days.
  let periodValid = false;
  if (window.startIso && window.endIso) {
    if (
      window.endIso > window.startIso &&
      todayIso >= window.startIso &&
      todayIso <= window.endIso
    )
      periodValid = true;
  } else if (window.startIso) {
    periodValid = true;
  }

  const isCurrentPartial =
    currentIdx >= 0 && monthPct >= 0.1 && monthPct <= 1 && periodValid;

  // Synthesize a placeholder for the current month if archive hasn't landed.
  if (isCurrentPartial && currentIdx === -1) {
    let ins = monthly.findIndex((r) => r.month > currentMonthKey);
    if (ins < 0) ins = monthly.length;
    monthly.splice(ins, 0, {
      month: currentMonthKey,
      spend: 0,
      leads: 0,
      scheduled: 0,
      meetings: 0,
      budget: 0,
    });
    currentIdx = ins;
  }

  const t = totals as Record<ProjMetric, number> & { budget: number };
  const liveCache = new Map<ProjMetric, number>();
  const liveSoFar = (metric: ProjMetric): number => {
    const c = liveCache.get(metric);
    if (c !== undefined) return c;
    if (!isCurrentPartial) {
      liveCache.set(metric, 0);
      return 0;
    }
    let v = 0;
    if (t[metric] != null) {
      if (periodStartMonth && periodEndMonth) {
        let priorSum = 0;
        monthly.forEach((r, i) => {
          if (i === currentIdx) return;
          if (
            r.month >= periodStartMonth &&
            r.month < currentMonthKey &&
            r.month <= periodEndMonth
          )
            priorSum += r[metric] || 0;
        });
        v = Math.max(0, (t[metric] || 0) - priorSum);
      } else {
        v = Math.max(0, t[metric] || 0);
      }
    }
    liveCache.set(metric, v);
    return v;
  };

  const monthBudget =
    isCurrentPartial && monthly[currentIdx] && monthly[currentIdx].budget > 0
      ? monthly[currentIdx].budget
      : null;

  const completedMonths: MonthlyRow[] = [];
  for (let i = 0; i < monthly.length; i++) {
    if (i === currentIdx) continue;
    const row = monthly[i];
    if (!row || row.month >= currentMonthKey || !hasData(row)) continue;
    completedMonths.push(row);
  }
  const hasHistory = completedMonths.length > 0;

  const baselineCache = new Map<ProjMetric, number | null>();
  const historicalBaseline = (metric: ProjMetric): number | null => {
    if (baselineCache.has(metric)) return baselineCache.get(metric)!;
    if (!hasHistory) {
      baselineCache.set(metric, null);
      return null;
    }
    const lastN = completedMonths.slice(-3).map((r) => r[metric] || 0).sort((a, b) => a - b);
    const mid = Math.floor(lastN.length / 2);
    const median =
      lastN.length % 2 === 0 ? (lastN[mid - 1] + lastN[mid]) / 2 : lastN[mid];
    baselineCache.set(metric, median);
    return median;
  };

  const significanceGate = (family: "spend" | "counts"): boolean => {
    if (!isCurrentPartial || monthPct < 0.1) return false;
    if (family === "spend")
      return liveSoFar("spend") >= Math.max(200, (monthBudget || 0) * 0.15);
    if (family === "counts") return liveSoFar("leads") >= 3;
    return false;
  };

  const budgetFallbackSpend = (): number | null => {
    if (!isCurrentPartial || !monthBudget) return null;
    if (significanceGate("spend")) return null;
    return monthBudget;
  };

  const segmentProjection = (metric: ProjMetric): number | null => {
    if (!isCurrentPartial) return null;
    if (isStrictlyMonthly && periodStartMonth === currentMonthKey) {
      const planned = t.budget || 0;
      if (planned > 0) {
        if (metric === "spend") return planned;
        const liveSpend = liveSoFar("spend");
        const live = liveSoFar(metric);
        if (liveSpend > 0) return planned * (live / liveSpend);
      }
    }
    const family = metric === "spend" ? "spend" : "counts";
    if (!significanceGate(family)) {
      if (metric === "spend") {
        const fb = budgetFallbackSpend();
        if (fb !== null) return fb;
      }
      return null;
    }
    const live = liveSoFar(metric);
    if (!hasHistory) {
      if (metric === "spend") return live / monthPct;
      const liveSpend = liveSoFar("spend");
      if (liveSpend > 0) return (liveSpend / monthPct) * (live / liveSpend);
      return live / monthPct;
    }
    const linear = live / monthPct;
    const baseline = historicalBaseline(metric);
    let blended =
      baseline !== null && baseline > 0
        ? (1 - monthPct) * baseline + monthPct * linear
        : linear;
    if (metric !== "spend") {
      const cap = Math.max(2 * live, 3 * (baseline || 0));
      if (cap > 0) blended = Math.min(blended, cap);
    }
    return blended;
  };

  return {
    currentMonthKey,
    daysInMonth,
    dayOfMonth,
    monthPct,
    currentIdx,
    isCurrentPartial,
    isStrictlyMonthly,
    hasHistory,
    periodStartMonth,
    periodEndMonth,
    monthBudget,
    monthly,
    liveSoFar,
    historicalBaseline,
    significanceGate,
    segmentProjection,
  };
}

export type ReportForecast = {
  spend: number;
  leads: number;
  scheduled: number;
  meetings: number;
  budget: number;
  daysLeft: number;
};

const FORECAST_METRICS = ["spend", "leads", "scheduled", "meetings"] as const;
type ForecastMetric = (typeof FORECAST_METRICS)[number];

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Legacy computeForecast (Index.html:4301) + its projection primitives
 * (buildProjectionPrimitives) — projected end-of-period spend/leads/
 * scheduled/meetings by segment-summing every calendar month in the
 * window: past = actuals, current = pace projection, future = median
 * baseline (or planned budget for spend). null when < 10% elapsed / not
 * started / finished / no dates. `todayIso` = Asia/Jerusalem day.
 */
export function computeForecast(
  window: ReportWindow,
  monthly: MonthlyRow[],
  budgetTotal: number,
  totals: { spend: number; leads: number; scheduled: number; meetings: number },
  todayIso: string,
): ReportForecast | null {
  if (!window.startIso || !window.endIso) return null;
  const start = Date.parse(`${window.startIso}T00:00:00`);
  const end = Date.parse(`${window.endIso}T00:00:00`);
  const today = Date.parse(`${todayIso}T00:00:00`);
  const total = end - start;
  if (total <= 0) return null;
  const elapsed = today - start;
  if (elapsed <= 0 || elapsed >= total) return null;
  const pct = elapsed / total;
  if (pct < 0.1) return null;

  const rowByMonth = new Map(monthly.map((r) => [r.month, r]));
  const currentMonthKey = todayIso.slice(0, 7);
  const [ty, tm, td] = todayIso.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const monthPct = td / daysInMonth;

  // liveSoFar(metric): current-month accrual = window totals minus prior
  // in-period completed months (clamped ≥0).
  const priorSum = (k: ForecastMetric) => {
    let s = 0;
    for (const r of monthly) if (r.month < currentMonthKey) s += r[k];
    return s;
  };
  const liveSoFar = (k: ForecastMetric) =>
    Math.max(0, (totals as Record<ForecastMetric, number>)[k] - priorSum(k));

  // historicalBaseline: median of up to the last 3 completed months.
  const completed = monthly
    .filter((r) => r.month < currentMonthKey)
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .slice(0, 3);
  const historicalBaseline = (k: ForecastMetric) =>
    median(completed.map((r) => r[k]));

  const curRow = rowByMonth.get(currentMonthKey);
  const monthBudget = curRow?.budget ?? 0;
  const liveSpend = liveSoFar("spend");
  const spendGate = liveSpend >= Math.max(200, monthBudget * 0.15);
  const countsGate = liveSoFar("leads") >= 3;
  const isCurrentPartial =
    !!curRow && monthPct >= 0.1 && monthPct <= 1;

  const segmentProjection = (k: ForecastMetric): number | null => {
    if (!isCurrentPartial) return null;
    // Single-month shortcut: the live period IS this calendar month.
    if (window.startIso.slice(0, 7) === currentMonthKey && window.endIso.slice(0, 7) === currentMonthKey) {
      if (k === "spend") return budgetTotal;
      return liveSpend > 0 ? budgetTotal * (liveSoFar(k) / liveSpend) : null;
    }
    const gatePasses = k === "spend" ? spendGate : countsGate;
    if (!gatePasses) return k === "spend" && monthBudget > 0 ? monthBudget : null;
    const live = liveSoFar(k);
    const baseline = historicalBaseline(k);
    if (baseline === null) {
      // No history → linear (spend) / efficiency (counts).
      if (k === "spend") return live / monthPct;
      return liveSpend > 0 ? (liveSpend / monthPct) * (live / liveSpend) : null;
    }
    const linear = live / monthPct;
    const w = monthPct;
    const blended = (1 - w) * baseline + w * linear;
    if (k === "spend") return blended;
    return Math.min(blended, Math.max(2 * live, 3 * baseline));
  };

  // Enumerate every calendar month from start to end inclusive.
  const monthKeys: string[] = [];
  let cy = new Date(start).getUTCFullYear();
  let cm = new Date(start).getUTCMonth() + 1;
  const endKey = `${new Date(end).getUTCFullYear()}-${String(new Date(end).getUTCMonth() + 1).padStart(2, "0")}`;
  for (let i = 0; i < 60; i++) {
    const mk = `${cy}-${String(cm).padStart(2, "0")}`;
    monthKeys.push(mk);
    if (mk >= endKey) break;
    cm++;
    if (cm > 12) {
      cm = 1;
      cy++;
    }
  }

  const agg = { spend: 0, leads: 0, scheduled: 0, meetings: 0 };
  for (const mk of monthKeys) {
    const row = rowByMonth.get(mk);
    for (const k of FORECAST_METRICS) {
      if (mk < currentMonthKey) {
        agg[k] += row ? row[k] : 0;
      } else if (mk === currentMonthKey) {
        const proj = segmentProjection(k);
        agg[k] += proj !== null ? proj : row ? row[k] : 0;
      } else {
        const baseline = historicalBaseline(k);
        if (baseline !== null) agg[k] += baseline;
        else if (k === "spend" && row && row.budget > 0) agg[k] += row.budget;
      }
    }
  }
  return {
    spend: agg.spend,
    leads: agg.leads,
    scheduled: agg.scheduled,
    meetings: agg.meetings,
    budget: budgetTotal,
    daysLeft: Math.max(0, Math.round((end - today) / 86400000)),
  };
}

export type PrevFunnel = {
  spend: number;
  leads: number;
  scheduled: number;
  meetings: number;
  costPerLead: number;
  ratioApplied: number;
};

/** Legacy computePrevFunnel (Index.html:4413) — previous calendar month
 *  from monthlyRaw, day-ratio-scaled to the elapsed portion of the
 *  current period. null when no prior-month rows. */
export function computePrevFunnel(
  window: ReportWindow,
  monthly: MonthlyRow[],
  todayIso: string,
): PrevFunnel | null {
  if (!window.startIso || !monthly.length) return null;
  const [y, m] = window.startIso.split("-").map(Number);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prevMonth = `${prevY}-${String(prevM).padStart(2, "0")}`;
  const rows = monthly.filter((r) => r.month === prevMonth);
  if (!rows.length) return null;
  const sum = (k: keyof MonthlyRow) =>
    rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const rawSpend = sum("spend");
  const rawLeads = sum("leads");
  const rawSched = sum("scheduled");
  const rawMeet = sum("meetings");
  const startMs = Date.parse(window.startIso);
  const endMs = window.endIso ? Date.parse(window.endIso) : Date.parse(todayIso);
  const todayMs = Date.parse(todayIso);
  const effEnd = todayMs < endMs ? todayMs : endMs;
  const daysElapsed = Math.max(1, Math.round((effEnd - startMs) / 86400000) + 1);
  const daysInPrev = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
  const ratio = Math.min(1, daysElapsed / daysInPrev);
  const leads = Math.round(rawLeads * ratio);
  const scheduled = Math.round(rawSched * ratio);
  const meetings = Math.round(rawMeet * ratio);
  const spend = rawSpend * ratio;
  return {
    spend,
    leads,
    scheduled,
    meetings,
    costPerLead: leads > 0 ? spend / leads : 0,
    ratioApplied: ratio,
  };
}

export type ReportAnomaly = { type: "good" | "bad"; text: string };

/**
 * Whether an anomaly chip is built from MEETING counts — today only "🏆 זינוק
 * בביצועי פגישה" (detectAnomalies below: this period's lead-entry meetings
 * against last month's ALL CLIENTS row). Such a chip is lead-entry only and
 * has no dated twin, so the page (ReportHeader) and the AI summary input
 * (reportAiSummary) both drop it under the "לפי מועד הפגישה" switch — through
 * this one predicate, so the two cannot drift apart. ReportAnomaly carries no
 * metric key, hence the wording test; the stems also cover any future
 * תיאומים rule, which would have the same problem, and none of the other
 * rules' texts (CTR, CPC, המרות Google, לידים, חשיפות, הוצאה, עלות לליד)
 * contains either.
 */
export function isMeetingAnomaly(a: ReportAnomaly): boolean {
  return /ביצועי פגישה|תיאומ/.test(a.text);
}

/** Legacy detectAnomalies (Index.html:4465) — period-over-period media
 *  + CRM anomaly chips (pickChannelAlerts covers the per-channel ones). */
export function detectAnomalies(
  totals: { spend: number; leads: number; scheduled: number; meetings: number },
  prevFunnel: PrevFunnel | null,
  sm: SmTotals,
  prevSm: SmTotals | null,
): ReportAnomaly[] {
  const out: ReportAnomaly[] = [];
  const pctD = (cur: number, prev: number) => {
    if (prev === 0) return cur > 0 ? "+∞" : "0%";
    const p = ((cur - prev) / prev) * 100;
    return (p >= 0 ? "+" : "") + p.toFixed(0) + "%";
  };
  const drop = (cur: number, prev: number, t: number) => prev > 0 && cur < prev * (1 - t);
  const rise = (cur: number, prev: number, t: number) => prev > 0 && cur > prev * (1 + t);

  if (sm && prevSm) {
    if (drop(sm.ctr, prevSm.ctr, 0.3) && sm.impressions > 1000)
      out.push({ type: "bad", text: `📉 CTR ירד משמעותית (${pctD(sm.ctr, prevSm.ctr)}) — מ-${fmtPct2(prevSm.ctr)} ל-${fmtPct2(sm.ctr)}` });
    if (rise(sm.cpc, prevSm.cpc, 0.35))
      out.push({ type: "bad", text: `💸 CPC עלה בחדות (${pctD(sm.cpc, prevSm.cpc)}) — מ-${fmtILS(prevSm.cpc)} ל-${fmtILS(sm.cpc)}` });
    if (prevSm.conversions > 0 && sm.conversions === 0)
      out.push({ type: "bad", text: `⛔ המרות Google צנחו ל-0 (מ-${fmtInt(prevSm.conversions)} בתקופה הקודמת)` });
    if (prevSm.fbLeads > 0 && sm.fbLeads === 0)
      out.push({ type: "bad", text: `⛔ לידים בפייסבוק צנחו ל-0 (מ-${fmtInt(prevSm.fbLeads)} בתקופה הקודמת)` });
    if (rise(sm.impressions, prevSm.impressions, 0.5))
      out.push({ type: "good", text: `🚀 זינוק בחשיפות (${pctD(sm.impressions, prevSm.impressions)}) — מ-${fmtInt(prevSm.impressions)} ל-${fmtInt(sm.impressions)}` });
  }

  if (prevFunnel) {
    const p = prevFunnel;
    if (rise(totals.leads, p.leads, 0.5))
      out.push({ type: "good", text: `🎯 זינוק בלידים (${pctD(totals.leads, p.leads)}) — מ-${fmtInt(p.leads)} ל-${fmtInt(totals.leads)}` });
    if (drop(totals.leads, p.leads, 0.3) && p.leads > 5)
      out.push({ type: "bad", text: `⚠️ לידים ירדו ב-${pctD(totals.leads, p.leads)} — מ-${fmtInt(p.leads)} ל-${fmtInt(totals.leads)}` });
    if (rise(totals.meetings, p.meetings, 0.4))
      out.push({ type: "good", text: `🏆 זינוק בביצועי פגישה (${pctD(totals.meetings, p.meetings)}) — מ-${fmtInt(p.meetings)} ל-${fmtInt(totals.meetings)}` });
    if (rise(totals.spend, p.spend, 0.3) && drop(totals.leads, p.leads, 0.2))
      out.push({ type: "bad", text: `🔻 הוצאה עלתה (${pctD(totals.spend, p.spend)}) אך לידים ירדו (${pctD(totals.leads, p.leads)}) — ירידה ביעילות` });
    const curCpl = totals.leads > 0 ? totals.spend / totals.leads : 0;
    if (rise(curCpl, p.costPerLead, 0.5) && totals.leads > 3)
      out.push({ type: "bad", text: `📈 עלות לליד עלתה ב-${pctD(curCpl, p.costPerLead)} — מ-${fmtILS(p.costPerLead)} ל-${fmtILS(curCpl)}` });
  }
  return out;
}

/* ---------------------------- creatives types ---------------------------- */

export type ReportAdDaily = { date: string; cost: number; leads: number };

export type ReportFbAd = {
  account: string;
  campaign: string;
  ad: string;
  status: string;
  /** "Link to promoted post" — only from the assets lookup. */
  url: string;
  destUrl: string;
  body: string;
  title: string;
  thumb: string;
  image: string;
  impressions: number;
  clicks: number;
  cost: number;
  leads: number;
  cpl: number;
  ctr: number;
  /** Warehouse CRM joins (0/absent hides the CRM row). `crmLeads` has no
   *  basis — leads created in the window, grouped by their own UTM. */
  crmLeads: number;
  /**
   * LEAD-ENTRY תיאומים / ביצועים of this creative, and spend ÷ each (0 when
   * the count is 0). Their meaning FLIPPED with the page-level switch: they
   * used to be dated. Now:
   *   BMBY       — owner-lead rule: events whose owner lead (lib/meetingBasis
   *                assignOwnerLeads) was created in the window and carries
   *                this campaign|ad in its own UTM.
   *   Sehel      — registration cohort, credited by the client's UTM;
   *                held = status "הלקוח הגיע לפגישה" (D2).
   *   Salesforce — lead rows created in the window, by current stage.
   */
  scheduled: number;
  held: number;
  costPerSched: number;
  costPerHeld: number;
  /**
   * The same four on the MEETING-DATE basis: events dated in the window,
   * credited to the client's FIRST lead (by lead_id) when it is this
   * creative. undefined ⇒ no dated join source (Salesforce;
   * `ReportCreatives.meetingBases.dated` is false) → "—". When the source
   * exists, a creative with no dated events carries 0, not undefined.
   */
  datedScheduled?: number;
  datedHeld?: number;
  datedCostPerSched?: number;
  datedCostPerHeld?: number;
  /** True when these CRM figures cover the whole creative rather than this
   *  one card. Format variants ("… - Video" / "- Static" / "- Carousel") are
   *  separate ads with separate spend, but the CRM cannot tell them apart —
   *  Meta's utm_content drops the suffix, so 0 of 618 rows in
   *  fb-creative-meetings carry one. The counts are therefore attached to a
   *  single variant of the group instead of repeated on each, and this flag
   *  lets the card say so. */
  meetingsAtGroupLevel?: boolean;
  ageDays: number;
  ctrEarly: number;
  ctrRecent: number;
  fatigued: boolean;
  fatigueReason: "" | "declining" | "long";
  isWinner: boolean;
  daily: ReportAdDaily[];
  /** Lifetime history behind the card's hover panel. INTERNAL ONLY — stripped
   *  from the payload for clients in NativeProjectRail. null when the ad has
   *  nothing to add beyond what the card face already shows. */
  history?: ReportAdHistory | null;
  /** This card exists only because a creative for it survives in the 365-day
   *  assets tab — the ad has no row in the metrics window at all, so every
   *  figure on it would be a zero that means "not measured here", not "no
   *  spend". The card renders the creative and says אין נתונים בטווח instead
   *  of a stats grid. Appended after the top-N slice, so it can never displace
   *  a card that does carry numbers. */
  noWindowData?: boolean;
  /** The creative shown on this card came from the Supabase warehouse rather
   *  than the `facebook-ads-assets 365` tab — the fallback in
   *  lib/warehouseCreatives.ts. Undefined on the normal path. Worth telling
   *  the reader: the warehouse keeps a creative long after it stops running,
   *  so a fallback image can be older than the card's numbers. */
  imageFromWarehouse?: boolean;
  /** The status pill was read from the Supabase warehouse
   *  (meta_ad_status.effective_status) because the assets tab had none.
   *  A stricter reading than the sheet gives — it accounts for a paused
   *  parent campaign or ad set — so the pill says where it came from. */
  statusFromWarehouse?: boolean;
  /** The status pill came from our own nightly Meta pull (the
   *  `effective_status` column of the fb-ad-previews tab), because neither
   *  the assets tab nor the warehouse had one. The only source with no
   *  account-level blind spots. */
  statusFromMeta?: boolean;
  /** Warehouse `last_seen` for that creative — the last date Meta reported
   *  delivery. Only set alongside `imageFromWarehouse`; "" when unknown. */
  imageLastSeen?: string;
  /** Meta ad-preview links from `כל מודעות פפיסבוק`, one per creative behind
   *  this ad name (six Digitel ad names carry 2–3). Reaches back 365 days,
   *  where the assets tab only reaches 60 — so most cards that render
   *  📷 אין תצוגה still have a working link here.
   *
   *  INTERNAL ONLY, and for a harder reason than `history`: the URL only
   *  resolves for a viewer holding a Business Manager session on the ad
   *  account. A client would get a Facebook error page, so the link must
   *  never reach them (stripped in NativeProjectRail).
   *
   *  The `d=` token is reminted by every Supermetrics refresh of that tab, so
   *  a link cached longer than the refresh interval will 400. Don't persist
   *  these anywhere. */
  previews?: string[];
  /** Creation date of an ad pulled LIVE from the Graph API by the רענון
   *  button (lib/fbNewAds.ts), not from any sheet or the warehouse. Set only
   *  on those cards: it is what marks a card as "launched since the feeds
   *  last ran" and it carries no numbers, because none exist yet. */
  liveCreatedIso?: string;
  /** That live ad's campaign matches no project's `campaign ID` pattern in
   *  Keys. Shown rather than hidden on purpose — an ad running under a
   *  campaign nobody registered is invisible to every other surface in the
   *  hub, and surfacing it is half the value of the refresh. */
  unmappedCampaign?: boolean;
  /** Every ad set the live ad was launched into — one creative typically
   *  goes out to several audiences at once (five on גינדי מרום ראשון,
   *  2026-09-23), and the card is one per creative. Live cards only. */
  adSets?: string[];
};

/** One month of an ad's life. cost/leads come from the ad-metrics tab
 *  (unclipped), scheduled/held from the `h:` whole-month warehouse buckets.
 *  scheduled/held are LEAD-ENTRY (owner leads created that month — additive
 *  across months); dated* are events dated in that month, undefined where
 *  there is no dated source. */
export type ReportAdHistoryMonth = {
  month: string;
  cost: number;
  leads: number;
  scheduled: number;
  held: number;
  datedScheduled?: number;
  datedHeld?: number;
};

/** A span of an ad's history (before the report / whole life). Same basis
 *  convention as ReportAdHistoryMonth. */
export type ReportAdHistoryTotals = {
  cost: number;
  leads: number;
  scheduled: number;
  held: number;
  datedScheduled?: number;
  datedHeld?: number;
};

/** An ad's whole observable life, for the קריאייטיבים card hover. */
export type ReportAdHistory = {
  /** Floor of the ad-metrics tab for this project. The Supermetrics connector
   *  exports a ROLLING lookback (~200d), so this is the deepest per-ad COST
   *  history that exists — and the panel must say so, because meeting history
   *  reaches much further back (some projects to 2019) and a ₪/תיאום computed
   *  over the difference would divide real meetings by ₪0. */
  since: string;
  months: ReportAdHistoryMonth[];
  /** [since, window.startIso) — the observable life BEFORE this report. */
  before: ReportAdHistoryTotals;
  /** Sum of `months` — the whole observable life. */
  total: ReportAdHistoryTotals;
};

export type ReportFbAdSet = {
  /** The campaign this ad set ran in. Part of the row's IDENTITY, not a
   *  label: one ad-set name is rebuilt in every new campaign, and grouping
   *  without the campaign added their costs together and presented the total
   *  as a single audience. */
  campaign: string;
  name: string;
  cost: number;
  leads: number;
  cpl: number;
  /** CRM figures for this row. They cover EVERY ad set sharing this name when
   *  `crmAtNameLevel` is set — the meetings source has no campaign dimension,
   *  so they are attached to the highest-spending row rather than repeated on
   *  each, which would show the same meetings two or three times over. */
  crmLeads: number;
  /** LEAD-ENTRY, same rules as ReportFbAd.scheduled (grouped by utm_term). */
  scheduled: number;
  held: number;
  costPerSched: number;
  costPerHeld: number;
  /** MEETING-DATE, same rules as ReportFbAd.datedScheduled. */
  datedScheduled?: number;
  datedHeld?: number;
  datedCostPerSched?: number;
  datedCostPerHeld?: number;
  /** True when the CRM figures above span every campaign that reuses this
   *  ad-set name, not just this row's. The card says so rather than letting
   *  them read as this one audience's. */
  crmAtNameLevel?: boolean;
  daily: ReportAdDaily[];
  /** Who the ad set was aimed at, from the nightly Meta pull
   *  (lib/fbAdsetTargetingExport → the `fb-adset-targeting` tab). Absent when
   *  the pull has not seen this ad set — an older one, or a name the sheet
   *  and Meta spell differently. */
  targetAgeMin?: number;
  targetAgeMax?: number;
  /** "male" / "female". Absent when the ad set targets everyone, which is
   *  the overwhelming default — a value here is the notable case. */
  targetGenders?: string;
  /** Human-readable zones, e.g. ["קטמונים ירושלים (1mi)"]. Meta's own geo
   *  primitives here are `places` and `custom_locations`, never cities or
   *  regions — see zonesOf in lib/metaGraph. */
  targetZones?: string[];
  /** Parallel to targetZones: [lat, lon, radiusKm] for each zone that is a
   *  pin, null for a whole region. Drives the hover minimap — a coordinate
   *  is unreadable, a circle over the country is not. */
  targetZonePoints?: ([number, number, number] | null)[];
  /** "home" / "recent" — residents of the zone vs people recently in it. */
  targetLocTypes?: string[];
  /** This card merges several ad sets that share a name but NOT a targeting
   *  set, so the shown audience covers only part of the row. The card says so
   *  rather than presenting one campaign's audience as the whole. */
  targetAmbiguous?: boolean;
};

export type ReportGoogleAd = {
  account: string;
  campaign: string;
  status: string;
  impressions: number;
  finalUrl: string;
  headlines: string[];
  descriptions: string[];
  /**
   * CRM outcomes for the leads this CAMPAIGN produced — the same
   * event-in-window definition the Facebook cards and the keyword table
   * already use.
   *
   * BMBY only, and 0 rather than undefined when unavailable: Google tags
   * the numeric campaign ID in utm_campaign, so the join runs through the
   * קמפיין ID גוגל id→name lookup, and a campaign whose leads all carry an
   * unexpanded {campaigned} placeholder resolves to nothing. `hasCrm` says
   * which case a zero is.
   *
   * `scheduled`/`held` are LEAD-ENTRY (owner-lead rule), `dated*` are
   * MEETING-DATE (first-touch, events dated in the window). Both BMBY-only.
   */
  scheduled: number;
  held: number;
  datedScheduled?: number;
  datedHeld?: number;
  /** False when no CRM row was found on EITHER basis — the card then omits
   *  the columns instead of printing two zeros that look like a result.
   *  True with a zero pair on the selected basis is a measured zero. */
  hasCrm: boolean;
};

export type ReportKeyword = {
  keyword: string;
  impressions: number;
  clicks: number;
  conversions: number;
  /** LEAD-ENTRY. The 57, Sept, "גיא ודורון לוי מתחם האלף": 0 / 0. */
  scheduled: number;
  held: number;
  /** MEETING-DATE. Same keyword: 3 / 1. undefined ⇒ no dated source. */
  datedScheduled?: number;
  datedHeld?: number;
};

export type ReportCreatives = {
  fb: {
    cost: number;
    leads: number;
    cpl: number;
    /** ACTIVE ads in the (unsliced) topAds list. */
    adCount: number;
    topAds: ReportFbAd[];
    topAdSets: ReportFbAdSet[];
    /**
     * The ad cards were rebuilt from the Supabase warehouse because the
     * `facebook-ads-metrics` tab held nothing for this project — see
     * lib/warehouseAdMetrics.ts. The KPIs above are untouched (they come
     * from the ad-set tab), so this says "the cards, not the totals".
     *
     * INTERNAL: stripped from the client payload in NativeProjectRail,
     * alongside the per-card 🗄️ marker it belongs with.
     */
    adsFromWarehouse?: boolean;
    /**
     * The ad cards were pulled straight from the Meta API for the report's
     * own window, because the `facebook-ads-metrics` tab had nothing for
     * this project — see lib/metaAdMetrics.ts. Preferred over the warehouse
     * fallback below. Same INTERNAL treatment: stripped for client view.
     */
    adsFromMeta?: boolean;
    /**
     * First day those cards cover. The warehouse only began recording leads
     * part-way through its life, so the rebuilt rows start LATER than the
     * report window usually does — on a live-flight window that can be
     * months later. The cards would then not add up to the KPIs above them,
     * which are summed over the whole window from the ad-set tab, so the
     * page prints this date rather than leaving the gap to be discovered.
     */
    adsWarehouseFrom?: string;
  };
  google: {
    clicks: number;
    conversions: number;
    topKeywords: ReportKeyword[];
    ads: ReportGoogleAd[];
    /** Demand Gen ads, each with the images and copy it is built from. Empty
     *  when the project runs no Demand Gen campaigns. */
    dgAds: ReportGoogleDgAd[];
  };
  /**
   * Which bases the CRM joins above were computed on — the קמפיינים
   * availability test. `lead` false ⇒ no CRM join at all (no mapping, or the
   * join failed). `dated` false ⇒ no dated join source (Salesforce: always
   * `{lead: true, dated: false}`) → every dated* field is undefined and the
   * cards show "—" with BASIS_COPY.sfDatedCreatives.
   *
   * Optional only for payloads built before the creatives reader sets it;
   * applyBasisToCreatives treats a missing value as `{lead: true, dated:
   * false}`.
   */
  meetingBases?: { lead: boolean; dated: boolean };
  /**
   * Meetings the group rows above could not take because the fb / gs lead
   * they are credited to carried no usable UTM (empty, numeric id, unexpanded
   * placeholder). Per basis: on lead-entry that lead is the OWNER lead, on
   * meeting-date the client's FIRST lead. With them, Σ audiences + untagged.fb
   * = the ערוצים facebook row, and Σ keywords + untagged.gs = google-search
   * (within the top-N cut). INTERNAL ONLY — the line is CSS-hidden under
   * `.rpt-clientview` (class rpt-basis-untagged).
   *
   * A side is undefined when that basis has no source; the whole field is
   * undefined on Salesforce, whose capture sheet has no owner-lead notion.
   */
  untagged?: ReportUntaggedMeetings;
};

/** See ReportCreatives.untagged. */
export type ReportUntaggedMeetings = {
  fb: { lead?: ReportMeetingPair; dated?: ReportMeetingPair };
  gs: { lead?: ReportMeetingPair; dated?: ReportMeetingPair };
};

/**
 * One Demand Gen ad and the assets it is assembled from — several images plus
 * several headlines/descriptions, the way Google's own asset list shows it.
 *
 * There is deliberately NO ad-level cost/impressions here. Google reports
 * metrics PER ASSET (verified: 28 distinct cost values across one ad's 30
 * assets), and an impression is credited to every asset shown in it, so adding
 * an ad's rows up overstates its spend — median 1.8x across the portfolio,
 * worst case 6x. The honest ad-level figure would need the Ad report, not the
 * asset report, so the card shows per-asset numbers only.
 */
export type ReportGoogleDgAd = {
  campaign: string;
  /** ENABLED / PAUSED / REMOVED, or "mixed" when merged ads disagree. */
  status: string;
  campaignStatus: string;
  /** Ad groups this identical creative set runs in. Advertisers routinely
   *  target several audiences with one set of assets, so this is normally
   *  several — the card is merged and lists them rather than repeating the
   *  same 25 images four times. */
  adGroups: string[];
  adIds: string[];
  /** Media assets STILL attached to the ad. See `imagesRetired`. */
  images: ReportGoogleAsset[];
  /**
   * Media whose LINK to the ad was removed, still reported because it had
   * impressions inside the query's rolling 60-day window — the same thing
   * `copyRetired` is for, and marked the same way (empty `performance`).
   *
   * Split out 2026-08-26 after Shbn-holon's Demand Gen card showed four
   * swapped-out creatives (the 10542-* set: ₪615, ₪463, ₪189, ₪22) beside
   * the five that are actually running (10623-*), all under one 🟢 פעילה
   * pill. The pill was right — the AD is enabled — but a reader takes a
   * live-looking card to mean every creative on it is live, and these had
   * been replaced. 39 of 1,079 media rows tab-wide carry a blank rating;
   * they touch 7 of 95 ads and empty none of them.
   */
  imagesRetired: ReportGoogleAsset[];
  /** Text assets STILL attached to the ad — what Google Ads shows when you open
   *  it. See `copyRetired` for the ones that only look attached. */
  copy: ReportGoogleCopy[];
  /**
   * Text assets whose LINK to the ad was removed, still reported because they
   * had impressions inside the query's rolling 60-day window.
   *
   * Kept apart rather than dropped: these are real impressions on copy that
   * really served, so the numbers are worth keeping — but listing them beside
   * the live copy made the card disagree with the Google Ads UI. anda/discovery
   * rendered 7 headlines and 5 descriptions against an ad carrying 3 and 4. The
   * five extras were an older payment-terms line (20/80, since replaced by
   * 15/85), three other retired headlines, and a description differing from the
   * live one by one definite article (רובע השקמים → רובע שקמים).
   *
   * Google marks them by omission: a removed link comes back with an EMPTY
   * `performance`, a live one always carries a rating (usually the placeholder
   * "Pending information"). Measured across the whole discovery tab, 12 of 93
   * Demand Gen ads reported more than 5 headlines — impossible, the format caps
   * at 5 — and splitting on blank performance brought every one of them back
   * under the cap without moving a single genuinely live asset.
   */
  copyRetired: ReportGoogleCopy[];
  /** Largest single-asset cost in the ad. Used only to order the ads — a
   *  lower bound on the ad's spend, never displayed as its total. */
  topAssetCost: number;
};

/**
 * One Demand Gen creative asset, de-duplicated across the ad groups and ads it
 * appears in. Google links the same uploaded image to many ads, so the raw tab
 * carries a row per (ad, asset); the numbers here are that asset's totals.
 *
 * NB the source query has no Date dimension — it is a rolling 60-day snapshot,
 * NOT the report window the FB cards obey. The block says so in its subtitle;
 * don't silently compare these against window-scoped figures.
 */
export type ReportGoogleAsset = {
  /** tpc.googlesyndication.com URL. Verified hotlinkable — plain <img src>. */
  imageUrl: string;
  /** youtube.com/watch?v=… for video assets; "" for images. */
  videoUrl: string;
  /** Uploaded filename when Google has one ("לוגו-צרפתי_1:1.jpg"). Often "". */
  name: string;
  /** "Marketing image" / "Square marketing image" / "Logo" / … A `Logo` row IS
   *  the ad's business image. */
  fieldType: string;
  /** Google's own rating. Mostly "Pending information" — 1,357 of 1,511 rows
   *  at the time of writing — so it is displayed but never sorted on. */
  performance: string;
  /** CTA shown with this asset, where Google reports one. */
  cta: string;
  /** Per-asset landing page. */
  finalUrl: string;
  /** How many OTHER ads in this project reuse the same image. 152 of the 323
   *  distinct images run in more than one ad, so this is common enough to be
   *  worth saying on the card. 0 = unique to this ad. */
  sharedWith: number;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
};

/** A text asset — headline, long headline, description or business name —
 *  with the numbers Google attributes to it. `fieldType` distinguishes them;
 *  the copy itself all arrives through one `assetTextText` field. */
export type ReportGoogleCopy = {
  fieldType: string;
  text: string;
  /** Google's rating — mostly the placeholder "Pending information". EMPTY
   *  means the asset's link to the ad was removed; see `copyRetired`. */
  performance: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
};

/** Legacy `fbStatusInfo` (Index.html:3597) — FB ad status → pill. */
export function fbStatusInfo(raw: string): { label: string; cls: string } {
  const s = String(raw || "").toUpperCase().trim();
  if (!s) return { label: "", cls: "" };
  if (s === "ACTIVE") return { label: "🟢 פעילה", cls: "active" };
  if (s === "PAUSED") return { label: "⏸ מושהית", cls: "paused" };
  if (s === "ADSET_PAUSED") return { label: "⏸ קהל מושהה", cls: "paused" };
  if (s === "CAMPAIGN_PAUSED") return { label: "⏸ קמפיין מושהה", cls: "paused" };
  if (s === "DELETED") return { label: "🗑 נמחקה", cls: "deleted" };
  if (s === "ARCHIVED") return { label: "🗑 בארכיון", cls: "deleted" };
  if (
    s === "DISAPPROVED" ||
    s === "PENDING_REVIEW" ||
    s === "PENDING_BILLING_INFO" ||
    s === "WITH_ISSUES"
  )
    return { label: "⚠️ בעיה", cls: "issue" };
  return { label: raw, cls: "other" };
}

/* --------------------------- channels tab math --------------------------- */

export type ChannelPacing = {
  cls: "pacing-on" | "pacing-mild" | "pacing-warn" | "pacing-severe" | "";
  action: "" | "lower" | "raise" | "investigate";
  /** Tooltip lines (plain text). */
  lines: string[];
};

/**
 * Legacy `pacingCellAttrs` (Index.html:6365), simplified: the 12%
 * configured-vs-planned rule drives ⬇/⬆, the ±10% actual-vs-plan variance
 * drives 🔍/the no-config fallback, and a negative planned (sheet formula
 * went negative = budget exhausted) is severe. Omitted vs legacy: the
 * per-campaign escalation detail (needs per-campaign daily actuals the
 * hub doesn't aggregate yet).
 */
export function computeChannelPacing(c: {
  dailyRate: number;
  configuredDaily: number | null;
  avg7d: number | null;
}): ChannelPacing {
  const planned = c.dailyRate;
  if (!planned) return { cls: "", action: "", lines: [] };
  if (planned < 0) {
    const lines = [
      `⚠️ תקציב התקופה נוצל — הקצב היומי הנדרש שלילי (${fmtILS(planned)})`,
    ];
    if (c.configuredDaily != null)
      lines.push(`מוגדר בפלטפורמה: ${fmtILS(c.configuredDaily)}`);
    lines.push("💡 מומלץ לעצור או לצמצם משמעותית — המשך הוצאה = חריגה נוספת");
    return { cls: "pacing-severe", action: "lower", lines };
  }
  const PACE_TOL = 0.12;
  const lines: string[] = [`מתוכנן: ${fmtILS(planned)}`];
  let action: ChannelPacing["action"] = "";
  let gap = 0;
  const hasConfig = c.configuredDaily != null && c.configuredDaily > 0;
  if (hasConfig) {
    const configured = c.configuredDaily!;
    lines.push(`מוגדר בפלטפורמה: ${fmtILS(configured)}`);
    const configVsPlan = (configured - planned) / planned;
    gap = Math.abs(configVsPlan);
    if (configVsPlan > PACE_TOL) {
      action = "lower";
      lines.push(
        `💡 מומלץ להוריד את התקציב בפלטפורמה ל־${fmtILS(planned)} (כרגע מוגדר ${fmtILS(configured)}, פער ${Math.round(gap * 100)}% מהתכנון)`,
      );
    } else if (configVsPlan < -PACE_TOL) {
      action = "raise";
      lines.push(
        `💡 מומלץ להעלות את התקציב בפלטפורמה ל־${fmtILS(planned)} (כרגע מוגדר ${fmtILS(configured)})`,
      );
    } else if (c.avg7d != null) {
      const variance = (c.avg7d - planned) / planned;
      lines.push(`ממוצע 7 ימים: ${fmtILS(c.avg7d)}`);
      if (variance > 0.1) {
        action = "investigate";
        gap = Math.abs(variance);
        lines.push(
          `🔍 התקציב מוגדר כהלכה (${fmtILS(configured)}) אבל הפלטפורמה מוציאה ${fmtILS(c.avg7d)}/יום (פער ${Math.round(variance * 100)}%) — בדקו שינויי CPC / CBO / עונתיות, לא תקציב`,
        );
      } else if (variance < -0.1) {
        action = "investigate";
        gap = Math.abs(variance);
        lines.push(
          `🔍 התקציב מוגדר כהלכה (${fmtILS(configured)}) אבל הפלטפורמה מוציאה רק ${fmtILS(c.avg7d)}/יום — בדקו קהלים / הצעות מחיר / קריאייטיבים, לא תקציב`,
        );
      }
    }
  } else if (c.avg7d != null) {
    // No configured budget known (Taboola/Outbrain/unmatched) —
    // spend-variance fallback.
    const variance = (c.avg7d - planned) / planned;
    gap = Math.abs(variance);
    lines.push(`ממוצע 7 ימים: ${fmtILS(c.avg7d)}`);
    if (variance > 0.1) {
      action = "lower";
      lines.push(`💡 מומלץ להוריד את התקציב היומי ל־${fmtILS(planned)}`);
    } else if (variance < -0.1) {
      action = "raise";
      lines.push(`💡 מומלץ להעלות את התקציב היומי ל־${fmtILS(planned)}`);
    }
  }
  const cls =
    action === "lower" || action === "raise"
      ? gap >= 0.5
        ? "pacing-severe"
        : "pacing-warn"
      : action === "investigate"
        ? "pacing-mild"
        : "pacing-on";
  return { cls, action, lines };
}

/** Legacy `costStyle` (Index.html:6164) — green→red heat on cost-per
 *  cells, same hue bands for rows and totals. undefined for v ≤ 0. */
export function costHeatStyle(
  metric: "costPerLead" | "costPerScheduled" | "costPerMeeting",
  v: number,
): { background: string; color: string; fontWeight: number } | undefined {
  if (!v || v <= 0) return undefined;
  const [lo, hi] =
    metric === "costPerLead"
      ? [150, 700]
      : metric === "costPerScheduled"
        ? [1500, 4500]
        : [4000, 12000];
  let t = (v - lo) / (hi - lo);
  t = Math.max(0, Math.min(1, t));
  const hue = Math.round(140 - t * 140);
  return {
    background: `hsl(${hue},70%,88%)`,
    color: `hsl(${hue},70%,26%)`,
    fontWeight: 600,
  };
}

/** Legacy `convCls` (Index.html:6183) — conversion-rate cell tone. */
export function convTone(r: number | null): "none" | "green" | "amber" | "red" {
  if (r === null) return "none";
  if (r >= 0.6) return "green";
  if (r >= 0.3) return "amber";
  return "red";
}

export type ChannelAlert = { type: "good" | "bad"; text: string };

/** Legacy `pickAlerts(p.channels)` (Index.html:4520) — the two
 *  per-channel strip chips. `icon` renders the channel display name. */
export function pickChannelAlerts(
  channels: ReportChannel[],
  icon: (name: string) => string,
): ChannelAlert[] {
  const out: ChannelAlert[] = [];
  const active = channels.filter((c) => c.spend > 0);
  const withLeads = active
    .filter((c) => c.leads > 0 && c.costPerLead > 0)
    .sort((a, b) => a.costPerLead - b.costPerLead);
  if (withLeads.length) {
    const best = withLeads[0];
    out.push({
      type: "good",
      text: `⭐ הערוץ המוביל: ${icon(best.channel)} — ${fmtILS(best.costPerLead)} לליד`,
    });
  }
  const noLeads = active.filter((c) => c.leads === 0 && c.spend > 500);
  if (noLeads.length) {
    out.push({
      type: "bad",
      text: `⚠️ תקציב ללא לידים: ${noLeads.map((c) => icon(c.channel)).join(", ")}`,
    });
  }
  return out;
}

/* --------------------------- paid diagnosis --------------------------- */

export type PaidDiagCard = {
  tone: "bad" | "warn" | "good" | "info";
  icon: string;
  head: string;
  /** Trusted self-authored HTML (only <b> tags). */
  bodyHtml: string;
  sample?: string;
  tipHtml?: string;
};

/**
 * Native port of the self-contained rules of diagnosePaidChannels
 * (Index.html:3999): waste alarm (🔴 בזבוז תקציב), CPL outlier, quality
 * leak, winner (⭐), concentration (📊), and the all-clear. The
 * portfolio-benchmark rules (project-vs-P75, per-channel-family) are
 * omitted — they need cross-project distributions the native report
 * doesn't load. Max 3 cards, priority-sorted, deduped by head.
 */
export function diagnosePaidChannels(channels: ReportChannel[]): PaidDiagCard[] {
  const MIN_SPEND = 500;
  const WASTE_SHARE = 0.1;
  const CPL_OUTLIER_MULT = 2.0;
  const QUALITY_RATIO = 0.5;
  const WINNER_MULT = 0.7;
  const CONCENTRATION = 0.6;

  const all = channels.filter((c) => c.spend > 0);
  if (!all.length) return [];
  const paid = all.filter((c) => c.spend >= MIN_SPEND || c.leads > 0);
  const totalSpend = all.reduce((s, c) => s + c.spend, 0);
  const totalLeads = all.reduce((s, c) => s + c.leads, 0);
  const totalSched = all.reduce((s, c) => s + c.scheduled, 0);
  const paidLeads = paid.reduce((s, c) => s + c.leads, 0);
  const paidSpend = paid.reduce((s, c) => s + c.spend, 0);
  const paidAvgCpl = paidLeads > 0 ? paidSpend / paidLeads : 0;
  const projAvgConv = totalLeads > 0 ? totalSched / totalLeads : 0;
  const tier = (c: ReportChannel) =>
    c.leads >= 10 && c.scheduled >= 5
      ? "robust"
      : c.leads >= 10
        ? "robust-cpl"
        : c.leads >= 3
          ? "directional"
          : "early";

  type Card = PaidDiagCard & { priority: number };
  const cards: Card[] = [];

  // Rule 1 — waste alarm 🔴
  for (const c of all) {
    if (c.leads === 0 && (c.spend >= MIN_SPEND || c.spend >= totalSpend * WASTE_SHARE)) {
      cards.push({
        priority: 1,
        tone: "bad",
        icon: "🔴",
        head: `בזבוז תקציב: ${c.channel}`,
        bodyHtml: `הוצאת <b>${fmtILS(c.spend)}</b> על ${c.channel} וקיבלת <b>0 לידים</b> בתקופה זו.`,
        sample:
          c.spend >= totalSpend * WASTE_SHARE
            ? `${fmtPct2(c.spend / totalSpend)} מסך ההוצאה על מדיה בתשלום`
            : undefined,
        tipHtml:
          "השבת/הורד תקציב, בדוק פיקסל ומעקב המרות, ושקול לחזור לטירגוט/קריאייטיב שעבד בעבר.",
      });
    }
  }
  // Rule 2 — CPL outlier 🟠
  for (const c of paid) {
    const t = tier(c);
    if ((t === "robust" || t === "robust-cpl") && paidAvgCpl > 0 && c.costPerLead > paidAvgCpl * CPL_OUTLIER_MULT) {
      cards.push({
        priority: 2,
        tone: "warn",
        icon: "🟠",
        head: `עלות לליד גבוהה חריג: ${c.channel}`,
        bodyHtml: `CPL של ${c.channel}: <b>${fmtILS(c.costPerLead)}</b> — <b>${(c.costPerLead / paidAvgCpl).toFixed(1)}×</b> מהממוצע של המדיה בתשלום (${fmtILS(paidAvgCpl)}).`,
        tipHtml:
          "בדוק קריאייטיב, טירגוט, והתאמת הודעה לדף נחיתה. שקול להעביר חלק מהתקציב לערוצים יעילים יותר עד שה-CPL ישתפר.",
      });
    }
  }
  // Rule 3 — quality leak 📉
  for (const c of paid) {
    if (tier(c) !== "robust") continue;
    const conv = c.leads > 0 ? c.scheduled / c.leads : 0;
    if (projAvgConv > 0 && conv > 0 && conv < projAvgConv * QUALITY_RATIO) {
      cards.push({
        priority: 3,
        tone: "warn",
        icon: "📉",
        head: `איכות לידים נמוכה: ${c.channel}`,
        bodyHtml: `${c.channel} מייצר לידים, אבל רק <b>${fmtPct2(conv)}</b> מתואמים לפגישה — לעומת ${fmtPct2(projAvgConv)} ממוצע הפרויקט.`,
        tipHtml:
          "הלידים ככל הנראה בעלי כוונה נמוכה. חדד טירגוט, הוסף שאלות סינון לטופס, או הקטן תקציב עד שתמצא קהל איכותי יותר.",
      });
    }
  }
  // Rule 4 — winner ⭐
  for (const c of paid) {
    if (tier(c) === "robust" && c.costPerLead > 0 && c.costPerLead <= paidAvgCpl * WINNER_MULT) {
      const extras = [
        c.costPerScheduled > 0 ? ` · עלות לתיאום ${fmtILS(c.costPerScheduled)}` : "",
        c.costPerMeeting > 0 ? ` · עלות לפגישה ${fmtILS(c.costPerMeeting)}` : "",
      ].join("");
      cards.push({
        priority: 4,
        tone: "good",
        icon: "⭐",
        head: `ערוץ מוביל: ${c.channel}`,
        bodyHtml: `${c.channel}: <b>${fmtILS(c.costPerLead)}</b> לליד${extras}. יעיל פי <b>${(paidAvgCpl / c.costPerLead).toFixed(1)}</b> מממוצע המדיה בתשלום.`,
        tipHtml:
          "זהו ערוץ מוכח — שקול להגדיל את התקציב בהדרגה (30-50% בבת אחת) ולבדוק אם היעילות נשמרת בסקייל.",
      });
    }
  }
  // Rule 6 — concentration 📊
  if (all.length > 1) {
    const top = [...all].sort((a, b) => b.spend - a.spend)[0];
    const share = totalSpend > 0 ? top.spend / totalSpend : 0;
    if (share >= CONCENTRATION) {
      cards.push({
        priority: 6,
        tone: "info",
        icon: "📊",
        head: `ריכוז תקציב: ${top.channel}`,
        bodyHtml: `${top.channel} מהווה <b>${fmtPct2(share)}</b> מכלל ההוצאה על מדיה בתשלום (${fmtILS(top.spend)} מתוך ${fmtILS(totalSpend)}).`,
        tipHtml:
          "תלות-יתר בערוץ בודד = סיכון תפעולי. שקול לבדוק 1-2 ערוצים נוספים עם 10-15% מהתקציב.",
      });
    }
  }
  // All-clear ✅
  if (!cards.length && paid.length > 0) {
    cards.push({
      priority: 99,
      tone: "good",
      icon: "✅",
      head: "מדיה בתשלום נראית מאוזנת",
      bodyHtml:
        "אין אזהרות פעילות — אין ערוץ מבזבז תקציב, אין חריג CPL, ואין ריכוז-יתר בערוץ אחד.",
    });
  }

  const seen = new Set<string>();
  return cards
    .sort((a, b) => a.priority - b.priority)
    .filter((c) => (seen.has(c.head) ? false : (seen.add(c.head), true)))
    .slice(0, 3)
    .map(({ priority: _p, ...rest }) => rest);
}

/* ---------------------------- meeting basis ---------------------------- */

/*
 * The client edge of the page-level meeting switch. Both bases ship in the
 * payload; these turn the pair into the one set of numbers a surface shows,
 * so sorting, totals, charts and diagnosis cards read the substituted rows
 * and cannot disagree with the table above them — the pattern the ערוצים
 * tab's local toggle proved before it was lifted to the page.
 *
 * All of them take the EFFECTIVE basis (useMeetingBasis().basis, which is
 * already lead-entry when the project has no dated source anywhere) and are
 * pure, so wrap the call in useMemo keyed on (payload, basis).
 */

/** Dated meetings no ערוצים row could claim: the "לא שויכו לשורה" row and
 *  the overview pies' extra slice. */
export function datedUnattributed(ds: DatedSourceInfo): ReportMeetingTotals {
  return {
    scheduled: ds.unmatchedScheduled + ds.ambiguousScheduled,
    meetings: ds.unmatchedMeetings + ds.ambiguousMeetings,
  };
}

/**
 * The definition of `ProjectReportData.datedTotals`, in one place so the
 * reader that sets it and any surface that re-derives it (the ערוצים סה״כ
 * row under a channel filter) cannot drift: Σ row dated counts + the
 * unattributed remainder. null when there is no dated source.
 */
export function computeDatedTotals(
  channels: readonly Pick<ReportChannel, "datedScheduled" | "datedMeetings">[],
  ds: DatedSourceInfo | null,
): ReportMeetingTotals | null {
  if (!ds) return null;
  const un = datedUnattributed(ds);
  let scheduled = un.scheduled;
  let meetings = un.meetings;
  for (const c of channels) {
    scheduled += c.datedScheduled ?? 0;
    meetings += c.datedMeetings ?? 0;
  }
  return { scheduled, meetings };
}

/**
 * The overview's תיאומים / ביצועים on `basis` — LEAD-ENTRY from
 * `data.totals`, MEETING-DATE from `data.datedTotals`. null ⇒ that basis
 * has no number here: render "—" (BasisDash), never the other basis.
 * Spend, leads and sales are basis-free; read them from `data.totals`.
 */
export function totalsForBasis(
  data: Pick<ProjectReportData, "totals" | "datedTotals">,
  basis: MeetingBasis,
): ReportMeetingTotals | null {
  if (basis === "dated") return data.datedTotals ?? null;
  return data.totals
    ? { scheduled: data.totals.scheduled, meetings: data.totals.meetings }
    : null;
}

/**
 * ערוצים rows with `scheduled` / `meetings` / `costPerScheduled` /
 * `costPerMeeting` holding `basis`'s numbers. "lead" returns the SAME array
 * (the payload is already lead-entry), so a memo downstream does not
 * recompute. "dated" substitutes datedScheduled / datedMeetings and divides
 * the row's spend by them; `dated*` stay on the rows untouched.
 *
 * Precondition for "dated": `data.datedSource` is non-null. Rows then carry
 * both dated fields (a missing one reads as 0); without a dated source the
 * caller renders "—" instead of calling this.
 */
export function applyBasisToChannels(
  channels: ReportChannel[],
  basis: MeetingBasis,
): ReportChannel[] {
  if (basis === "lead") return channels;
  return channels.map((c) => {
    const scheduled = c.datedScheduled ?? 0;
    const meetings = c.datedMeetings ?? 0;
    return {
      ...c,
      scheduled,
      meetings,
      // A part of the lead-entry תיאומים, not of these.
      cancelledScheduled: undefined,
      costPerScheduled: scheduled > 0 ? c.spend / scheduled : 0,
      costPerMeeting: meetings > 0 ? c.spend / meetings : 0,
    };
  });
}

/** Whether the קמפיינים CRM joins exist on `basis` (see
 *  ReportCreatives.meetingBases; a payload without it is lead-only). */
export function creativesBasisAvailable(
  c: Pick<ReportCreatives, "meetingBases"> | null | undefined,
  basis: MeetingBasis,
): boolean {
  if (!c) return false;
  return (c.meetingBases ?? { lead: true, dated: false })[basis];
}

/** applyBasisToCreatives' result: the payload plus which basis its
 *  unprefixed meeting fields now hold. */
export type BasisAppliedCreatives = ReportCreatives & {
  meetingBasis: MeetingBasis;
  /**
   * `meetingBasis` has no source for this project (Salesforce under dated).
   * Every scheduled / held / costPer* has been ZEROED — not left holding the
   * other basis — and every one of them must render "—" (BasisDash with
   * BASIS_COPY.dashNoSource[meetingBasis]), not 0. Google campaign rows get
   * `hasCrm: false`, which already hides their columns.
   */
  meetingBasisMissing: boolean;
};

/**
 * קמפיינים payload with every ad / ad set / keyword / Google campaign row —
 * and each ad's history months, `before` and `total` — carrying `basis`'s
 * numbers in `scheduled` / `held` / `costPerSched` / `costPerHeld`.
 *
 *   lead, available  → shallow copy; the rows are already lead-entry.
 *   dated, available → dated* substituted; a row with no dated field reads
 *                      0 (the source exists and credited it nothing). Costs
 *                      use datedCostPer* when set, else spend ÷ count.
 *   either, missing  → counts and costs zeroed + meetingBasisMissing.
 *
 * Basis-free fields (crmLeads, meetingsAtGroupLevel, crmAtNameLevel, spend,
 * ordering) are untouched, so card order never moves on a flip. `untagged`
 * is not swapped — read it with untaggedFor().
 */
export function applyBasisToCreatives(
  c: ReportCreatives,
  basis: MeetingBasis,
): BasisAppliedCreatives {
  const missing = !creativesBasisAvailable(c, basis);
  if (basis === "lead" && !missing) {
    return { ...c, meetingBasis: basis, meetingBasisMissing: false };
  }
  const costPer = (cost: number, n: number, given: number | undefined) =>
    given ?? (n > 0 ? cost / n : 0);
  const row = <T extends ReportFbAd | ReportFbAdSet>(r: T): T => {
    if (missing)
      return { ...r, scheduled: 0, held: 0, costPerSched: 0, costPerHeld: 0 };
    const scheduled = r.datedScheduled ?? 0;
    const held = r.datedHeld ?? 0;
    return {
      ...r,
      scheduled,
      held,
      costPerSched: costPer(r.cost, scheduled, r.datedCostPerSched),
      costPerHeld: costPer(r.cost, held, r.datedCostPerHeld),
    };
  };
  const pair = <T extends ReportMeetingPair & { datedScheduled?: number; datedHeld?: number }>(
    r: T,
  ): T =>
    missing
      ? { ...r, scheduled: 0, held: 0 }
      : { ...r, scheduled: r.datedScheduled ?? 0, held: r.datedHeld ?? 0 };
  const ad = (a: ReportFbAd): ReportFbAd => {
    const out = row(a);
    if (a.history) {
      out.history = {
        ...a.history,
        months: a.history.months.map(pair),
        before: pair(a.history.before),
        total: pair(a.history.total),
      };
    }
    return out;
  };
  return {
    ...c,
    fb: {
      ...c.fb,
      topAds: c.fb.topAds.map(ad),
      topAdSets: c.fb.topAdSets.map(row),
    },
    google: {
      ...c.google,
      topKeywords: c.google.topKeywords.map(pair),
      ads: c.google.ads.map((g) => ({
        ...pair(g),
        hasCrm: missing ? false : g.hasCrm,
      })),
    },
    meetingBasis: basis,
    meetingBasisMissing: missing,
  };
}

/** The untagged remainder for one platform on one basis; undefined when
 *  that basis has no source (render nothing — the line is internal). */
export function untaggedFor(
  c: Pick<ReportCreatives, "untagged"> | null | undefined,
  platform: "fb" | "gs",
  basis: MeetingBasis,
): ReportMeetingPair | undefined {
  return c?.untagged?.[platform][basis];
}

/* ------------------------------ formatters ------------------------------ */

/**
 * Leads a row needs before it can wear the 🏆.
 *
 * Shared, because the two sides had drifted: the ad cards have applied it
 * since the legacy report (lib/reportCreatives picks the winner over rows
 * with `leads >= WINNER_MIN_LEADS`), while the ad-set list simply crowned
 * `topAdSets[0]` — the cheapest CPL at ANY volume — so an audience that
 * produced one lead for ₪40 outranked one that produced thirty for ₪60.
 * Three is not magic; it is the floor the cards already used, and it clears
 * 69% of rows.
 */
export const WINNER_MIN_LEADS = 3;

/**
 * THE card key for a Facebook ad, as a string both sides of the wire can
 * build: `campaign|ad`, lowercased, with the ad name normalised by the two
 * functions below.
 *
 * It lives here, in the shared module, because it is used on BOTH sides and
 * they have to agree byte for byte. The server groups metrics rows into cards
 * with it (lib/reportCreatives), the warehouse and Meta fallbacks key their
 * imagery with it (lib/warehouseCreatives, lib/metaAdMetrics), and the
 * client sends it to /api/report/fb-new-ads as the list of creatives it is
 * ALREADY showing, so "מודעות שעלו עכשיו" can leave those out.
 *
 * That last one is where a private copy per file stopped being tenable:
 * Meta writes the same ad name with a varying number of invisible bidi marks
 * (U+200E/U+200F) — on אחוזת אפרידר, 2026-09-22, three creatives came back
 * under nine different spellings, up to four marks apart — so an un-normalised
 * key matched neither itself nor the card already on the page, and the same
 * ad was reported as new three times over.
 */
export function fbCardKey(campaign: string, ad: string): string {
  return `${String(campaign ?? "").trim()}|${normCardName(adNameOf(ad))}`.toLowerCase();
}

/**
 * Ad name → card identity: strip the invisible bidi / zero-width marks Meta
 * sprinkles through Hebrew names, collapse whitespace.
 *
 * Deliberately NOT lib/fbCreatives' `normAdName`, which additionally drops a
 * trailing " - Video / Static / Carousel". That one is right where it lives
 * (the CRM join: Meta's utm_content drops the suffix, so the metrics side has
 * to as well) and wrong for a card: those are separate ads with separate
 * budgets and separate results, and merging them hid the comparison the
 * קריאייטיבים tab exists to make (חלומות בן שמן, 2026-08-12).
 */
export function normCardName(s: unknown): string {
  return String(s ?? "")
    .replace(/[​-‏‪-‮⁦-⁩⁠­﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A pure-date ad name ("2026-05-27") gets auto-typed by Sheets and comes
 *  back as "5/27/2026"; normalise any date-looking render to ISO so a sheet
 *  row, a warehouse row and Meta's own answer land on one key (legacy
 *  `fbAdName_`). */
export function adNameOf(v: unknown): string {
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : s;
}

export const fmtInt = (n: number): string =>
  new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 }).format(
    Math.round(n || 0),
  );

export const fmtILS = (n: number): string => `₪${fmtInt(n)}`;

/** Two-decimal percent, e.g. 0.0123 → "1.23%". */
export const fmtPct2 = (n: number): string => `${((n || 0) * 100).toFixed(2)}%`;

export const fmtDateHe = (iso: string): string => {
  if (!iso) return "";
  const p = iso.split("-");
  return `${p[2]}/${p[1]}/${p[0]}`;
};

/* ─── Month segmentation (free-range pro-rating) ──────────────────── */

export type MonthSegment = {
  /** "YYYY-MM" of the calendar month this segment belongs to. */
  month: string;
  /** First day of the month that is inside the range (ISO). */
  startIso: string;
  /** Last day of the month that is inside the range (ISO). */
  endIso: string;
  /** How many of the month's days fall inside the range. */
  daysInRange: number;
  /** How many days the whole calendar month has. */
  daysInMonth: number;
};

/**
 * Split an inclusive ISO range into per-calendar-month segments.
 *
 * The basis for pro-rating anything ALL CLIENTS records per month onto a
 * free date range: its finest grain is one calendar month (rowType
 * "חודשי"), so a range that starts mid-July has to take July's numbers
 * × daysInRange/daysInMonth. Returns [] on a malformed or inverted range.
 *
 * Lives here rather than in reportData because CrmFunnelCard pro-rates the
 * same way for the funnel's channel costs, and two copies of this arithmetic
 * would eventually disagree about a month boundary.
 */
export function monthSegments(from: string, to: string): MonthSegment[] {
  const out: MonthSegment[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return out;
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth(); // 0-based
  for (;;) {
    const monthStart = new Date(Date.UTC(y, m, 1));
    const monthEnd = new Date(Date.UTC(y, m + 1, 0)); // last day of month
    const daysInMonth = monthEnd.getUTCDate();
    const segStart = monthStart > start ? monthStart : start;
    const segEnd = monthEnd < end ? monthEnd : end;
    const daysInRange =
      Math.round((segEnd.getTime() - segStart.getTime()) / 86400000) + 1;
    if (daysInRange > 0) {
      out.push({
        month: `${y}-${String(m + 1).padStart(2, "0")}`,
        startIso: segStart.toISOString().slice(0, 10),
        endIso: segEnd.toISOString().slice(0, 10),
        daysInRange,
        daysInMonth,
      });
    }
    if (y === end.getUTCFullYear() && m === end.getUTCMonth()) break;
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}
