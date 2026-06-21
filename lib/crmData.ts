/**
 * CRM-funnel data for the project overview page.
 *
 * Data source: the external "Consolidated" workbook (env CRM_SHEET_ID,
 * default 1YOL2Rry…), which aggregates per-lead data from the three CRMs
 * F&F's clients use — BMBY, Sehel and Salesforce. Updated by an upstream
 * pipeline (currently daily; the workbook owner controls the cadence).
 * The hub is a read-only consumer.
 *
 * Join model: Keys (the dashboard's canonical project registry) carries
 * two columns — `CRM` (the account name in the external CRM, e.g.
 * "אפרידר גינות רחובות") and `CRM platform` ("bmby" / "sehel" /
 * "salesforce"). Each project resolves to AT MOST one (platform,
 * account) pair; CRM rows
 * whose `פרויקט` doesn't match any Keys.CRM are ignored (orphan
 * projects upstream that haven't been onboarded yet — Maayan's call).
 *
 * Caching: React `cache()` per-request dedup only. Multiple components
 * on the same page (CRM card, morning-alert enrichment) call into this
 * without paying for the Sheets read twice within a request.
 *
 * No cross-request `unstable_cache` layer. The raw "מאגר במבי" /
 * "מאגר שכל" tabs are huge and grow continuously (~50K×27 and ~29K×20
 * at the 2026-05-12 migration probe); once serialized they exceed
 * Next.js's hard 2MB per-entry `unstable_cache` limit, so every
 * cross-request cache write threw "items over 2MB can not be cached"
 * as an unhandledRejection and degraded /morning + /projects/[project].
 * Dropping the layer also aligns with the App-Hosting multi-instance
 * preference (feedback_unstable_cache_multi_instance). The CRM workbook
 * only updates daily and one Sheets read per request is acceptable.
 */
import { cache } from "react";
import { sheetsClient } from "@/lib/sa";
import { driveFolderOwner } from "@/lib/sa";
import { readKeysCached } from "@/lib/keys";
import { computeCrmEnrichment, type CrmEnrichment } from "./crmEnrichment";
import {
  useSupabaseCrmEnrichment,
  supabaseCrmProjectAllowed,
  supabaseConfigured,
  supabaseRowsAll,
} from "./supabase";
import { fbAdSpendByCreative, normAdName } from "./fbCreatives";

// Source workbook for per-lead CRM data. Migrated 2026-05-12 from the
// previous "Consolidated" sheet (1YOL2Rry…) to the now-canonical
// "ארכיון מחולל דוחות" workbook (1tYtnB1V…) — same upstream pipeline,
// new container + restructured tabs (more rows, fewer columns, Hebrew
// tab names: "מאגר במבי" / "מאגר שכל"). Schema notes:
//   - BMBY: dropped `is_meeting` (derive from סטאטוס startsWith "פגישה")
//     and `איש מכירות` (no seller list anymore — empty array on output).
//   - Sehel: lost the merged-banner row 1 — header is now row 1.
const CRM_SHEET_ID =
  process.env.CRM_SHEET_ID || "1tYtnB1Ve8RcsZ9_PpRuZyE0jlhD6r-Q35yLO5_7FhEQ";

export type CrmPlatform = "bmby" | "sehel" | "salesforce";

export type CrmFunnel = {
  platform: CrmPlatform;
  /** Keys.CRM value used as the join key (the canonical account name
   *  on the external CRM side — surfaced for the badge so users can
   *  tell why a particular cohort was selected). */
  crmAccount: string;
  leads: number;
  contacted: number;
  /** "תואמה פגישה" — leads where a meeting was scheduled at any point
   *  in the lifecycle, including upcoming meetings AND cancellations
   *  ("פגישה בוטלה" still counts as scheduled per Maayan's definition).
   *  Broader than `meetings` — always `scheduledMeetings >= meetings`.
   *  BMBY: status.includes("פגישה"). Sehel: status.includes("פגישה")
   *  OR a meeting date is set — best-guess equivalent pending upstream
   *  clarification. */
  scheduledMeetings: number;
  /** "פגישות" — meetings that actually took place (held). Subset of
   *  scheduledMeetings. BMBY: status matches "פגישה 1/2/3" or "פגישה
   *  התקיימה". Sehel: status in {אחרי פגישה, פגישה ללא סיכום} —
   *  the post-meeting stages, best-guess pending upstream answer. */
  meetings: number;
  /** "חוזים/עסקאות" — leads at the contract/sale terminal status. A
   *  CURRENT-snapshot count (not dated), so windowed figures drift; it's
   *  independent of `meetings` (a held lead can also sign). BMBY: "חוזה";
   *  Sehel: "| עסקה"; Salesforce: "טופס הרשמה" (the registration = the
   *  conversion goal). 0 when none. */
  contracts: number;
  /** meetings / leads as a 0-100 number (UI formats with %). null when
   *  leads === 0 so the card can show "—" instead of dividing by zero. */
  meetingRatePct: number | null;
  /** Top-5 salespeople by lead count. BMBY only — Sehel doesn't carry
   *  a salesperson column. Empty for sehel. */
  topSellers: { label: string; count: number }[];
  /** Untruncated source-aware matrices for client-side re-aggregation
   *  when the section's chip filter narrows the cohort. The CRM card is
   *  a client component that owns chip state and re-derives every view
   *  (KPI tiles, status funnel, objections × source matrix, pie,
   *  trendline) from these on every chip toggle — so the funnel reads
   *  consistently across all five surfaces under any source mix.
   *
   *  Size is naturally bounded: ~20 statuses × ~20 sources, ~50
   *  objections × ~20 sources. JSON-friendly Record shapes — no Maps
   *  cross the server/client boundary. */
  sourceMatrices: {
    /** All sources observed in the cohort, sorted desc by total leads.
     *  Drives chip ordering + the section-wide source→color palette. */
    allSources: string[];
    /** Canonical funnel order for every status present in the cohort
     *  (BMBY_STATUS_FUNNEL_ORDER / SEHEL_STATUS_FUNNEL_ORDER intersected
     *  with observed). Client picks top-N by selected-source count and
     *  re-sorts the picks by this list so the funnel narrative is
     *  preserved under any chip selection. */
    statusFunnelOrder: string[];
    /** source → lead count. Every counted row contributed once. */
    leadsBySource: Record<string, number>;
    /** source → contacted count. Subset of leadsBySource. */
    contactedBySource: Record<string, number>;
    /** source → scheduledMeetings (תואמה פגישה) count. */
    scheduledMeetingsBySource: Record<string, number>;
    /** source → meetings (held) count. Subset of scheduledMeetingsBySource. */
    meetingsBySource: Record<string, number>;
    /** source → contracts (חוזה / עסקה / טופס הרשמה) count. */
    contractsBySource: Record<string, number>;
    /** status → (source → count). Drives the chip-filtered status
     *  funnel: for each row at status S, sum its source columns that
     *  the chips have selected. */
    statusBySource: Record<string, Record<string, number>>;
    /** objection → (source → count). Drives the chip-filtered
     *  objections matrix + pie. */
    objectionBySource: Record<string, Record<string, number>>;
  };
  /** Daily time series for the trendline chart under the source pie.
   *  One entry per calendar day in the filtered cohort, with per-source
   *  counts of {leads, scheduled, held}. The trendline client component
   *  sums these on the fly based on which sources are currently picked
   *  in the chip row (state shared with the pie), so the chart and the
   *  pie always reflect the same source filter. Empty when the cohort
   *  has zero rows. Sorted ascending by date. */
  dailyTimeSeries: {
    date: string; // YYYY-MM-DD
    bySource: {
      source: string;
      leads: number;
      scheduledMeetings: number;
      meetings: number;
    }[];
  }[];
  /** Earliest and latest dates seen in the matched rows (formatted
   *  YYYY-MM-DD). Surfaces upstream freshness — when the latest date
   *  is more than a few days behind today, the upstream pipeline has
   *  paused. */
  dateRange: { from: string; to: string };
  /** Stale-leads detection (cross-period, ignores monthFilter): any
   *  lead sitting in an early-funnel stage for more than 14 days, no
   *  matter when it entered. Drives the `stale-leads` alert. Sales-team
   *  follow-up gap surface — the count is the number of leads that
   *  sat idle past the threshold; `oldestDays` is the most extreme
   *  case (good for severity grading); `byStage` shows which stages
   *  the staleness concentrates in. Empty (count=0) when nothing
   *  qualifies. */
  staleLeads: {
    count: number;
    oldestDays: number;
    byStage: { stage: string; count: number }[];
  };
  /** When the cohort is filtered to a single calendar month, this is the
   *  exact "YYYY-MM". Empty in project-window or no-filter mode. UI uses
   *  it to render the "חודש: …" filter chip. */
  monthFilter: string;
  /** Human label of the active date window when it's a project-flight-
   *  date range (dd/MM/yyyy–dd/MM/yyyy) rather than a single month.
   *  Empty in month / no-filter mode. */
  windowLabel: string;
  /** Data-freshness note: the latest in-window CRM-record date (YYYY-MM-DD)
   *  when the data ends ≥ a few days before the window's *expected* end
   *  (= min(window end, today) — future days can't carry data yet). Empty
   *  when the data is current to the window. Drives the "⚠️ נתונים עד …" chip;
   *  the window chip (windowLabel / monthFilter) already shows the *requested*
   *  range, so this surfaces only the meaningful requested-vs-covered gap. */
  dataLagThrough?: string;
  /** Per-paid-channel media cost attributed onto this funnel — the
   *  "Monthly Channel Leads" logic from the anda costs workbook ported
   *  to the Hub. Channel spend comes from ALL CLIENTS over the SAME
   *  window; it's attributed to the leads whose `מקור הגעה` token
   *  canonicalizes to that channel (composite sources count toward each
   *  channel they name), and CPL / CP-meeting use the funnel's OWN
   *  per-source counts (the CRM-attribution lens). Sorted by spend desc;
   *  empty when no spend was supplied (e.g. month-rewind mode). */
  channelCosts?: {
    channel: string; // canonical key (google-search / facebook / yad2 …)
    label: string;
    spend: number;
    leads: number;
    scheduled: number;
    meetings: number;
    cpl: number; // spend ÷ leads
    cps: number; // spend ÷ scheduled (תואמה)
    cpm: number; // spend ÷ meetings (held)
  }[];
  /** raw `מקור הגעה` → its channel's CPL/CP-meeting, ONLY for sources
   *  that map 1:1 to a single paid channel — drives the inline cost on
   *  the source chips. Composite / non-paid sources are omitted. */
  costBySource?: Record<string, { channel: string; cpl: number; cpm: number }>;
  /** Supabase BMBY warehouse enrichment (ADDITIVE, bmby-platform only,
   *  flag-gated by SUPABASE_CRM_ENRICHMENT). Authoritative held-meeting
   *  counts re-derived from the raw v_bmby_* views — see lib/crmEnrichment.ts.
   *  Absent/null when the flag is off, the project isn't in the warehouse,
   *  or a fetch failed: the base Sheet funnel is always intact. Whole-window
   *  figure (NOT chip-filtered). */
  supabaseEnrichment?: CrmEnrichment;
  /** Which backend produced this funnel: "sheet" (the ארכיון Google Sheet —
   *  the default / fallback) or "warehouse" (the Supabase BMBY journey,
   *  used for flag-allowed bmby projects when it's at least as complete as
   *  the Sheet on lead count). Drives the small source badge; absent ⇒
   *  "sheet". When "warehouse", the funnel's own `meetings` IS the
   *  authoritative held count, so the separate held strip is suppressed. */
  dataSource?: "sheet" | "warehouse";
  /** Facebook/Meta UTM drill (warehouse-sourced funnels only) — how the
   *  Meta leads (channel_key='fb' = fb+ig+an) split by ad placement
   *  (utm_medium), audience (utm_term) and creative (utm_content). Counts
   *  lead rows; top-8 per dimension + "אחר". Absent when the project has no
   *  Meta leads or the funnel is Sheet-sourced (UTM lives only in the
   *  warehouse). Per-segment CPL is a later slice (needs the meta_* join). */
  fbBreakdown?: {
    totalLeads: number;
    byPlacement: { label: string; leads: number }[];
    byAudience: { label: string; leads: number }[];
    /** Per creative (= ad name / utm_content). leads/scheduled/held from the
     *  warehouse; spend + cpl/cps/cpm joined from the dashboard's
     *  facebook-ads-metrics Sheet (cost ÷ leads / scheduled / held). spend=0
     *  when no matching ad-spend row (cost metrics then 0). */
    byCreative: {
      label: string;
      leads: number;
      scheduled: number;
      held: number;
      spend: number;
      cpl: number;
      cps: number;
      cpm: number;
    }[];
  };
  /** Speed-to-lead (warehouse BMBY funnels only): response time from lead
   *  arrival to the first desk touch, per media channel, from
   *  `v_bmby_leads_bucketed.response_seconds` (pre-computed upstream,
   *  clamped ~24h, ~100% populated). Median + count + the sub-60s / sub-5min
   *  shares — median + shares are used (not the mean) because the tail is
   *  long and clamped. Whole-window (NOT chip-filtered, like the held
   *  strip). Absent on Sheet/Sehel/Salesforce funnels — they carry no
   *  per-lead response timing. `bySource` keys are normSource'd, so they
   *  share the section's source→color palette. */
  speedToLead?: {
    overall: { medianSec: number; n: number; under60: number; under300: number };
    bySource: Record<
      string,
      { medianSec: number; n: number; under60: number; under300: number }
    >;
  };
  /** Returning vs new leads (warehouse BMBY only): `is_return_lead` from the
   *  view — a lead already known to BMBY (a prior inquiry, often on another
   *  project) vs genuinely new. Whole-window. `bySource` keys normSource'd
   *  so they share the section palette. */
  returningSplit?: {
    total: number;
    returning: number;
    newLeads: number;
    bySource: Record<string, { returning: number; newLeads: number }>;
    /** For returning leads: current channel → { prior channel → count } —
     *  the media channel of the client's immediately-PRIOR lead (within this
     *  project's history). Powers the "prior channels" hover on the returning
     *  table. Only ~half of returning leads have a locatable prior (pre-2024
     *  inquiries are below the warehouse floor), so the inner sums are a
     *  subset of `bySource[src].returning`. Warehouse-only. */
    priorBySource?: Record<string, Record<string, number>>;
  };
  /** Lead-arrival heatmap (warehouse BMBY only): when leads land, by
   *  Asia/Jerusalem weekday (`matrix[0]`=Sunday … `matrix[6]`=Saturday) ×
   *  hour 0-23. `matrix[wd][hr]` = lead count; `peak` = busiest cell (for
   *  color scaling). Whole-window. */
  arrivalHeatmap?: {
    matrix: number[][];
    total: number;
    peak: number;
  };
  /** Lead-journey velocity (warehouse BMBY only): DAYS from a cohort lead to
   *  the client's first held meeting that falls on/after that lead, per
   *  media channel (the lead's normSource'd source). median + avg + n (held
   *  count). lead→scheduled is NOT here — the warehouse has no booking
   *  timestamp, only the meeting date. Whole-window. */
  journeyVelocity?: {
    overall: { medianDays: number; avgDays: number; n: number };
    bySource: Record<string, { medianDays: number; avgDays: number; n: number }>;
  };
};

/* ── Sheets reads, cached ──────────────────────────────────────────── */

type RawTab = { headers: string[]; rows: unknown[][] };

async function fetchTabFromSheet(
  subjectEmail: string,
  range: string,
): Promise<RawTab> {
  const sheets = sheetsClient(subjectEmail);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CRM_SHEET_ID,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (!values.length) return { headers: [], rows: [] };
  const headers = (values[0] as unknown[]).map((h) =>
    String(h ?? "").replace(/\s+/g, " ").trim(),
  );
  return { headers, rows: values.slice(1) };
}

// BMBY: header row is row 1, data starts at row 2. Open-ended row
// bound — the new "מאגר במבי" tab held ~50K rows on the 2026-05-12
// migration probe and grows; A:AA covers all 27 cols. Per-request
// cache() only (no unstable_cache) — see the module header for why
// the cross-request layer was dropped (2MB cap + multi-instance).
const readBmby = cache((subjectEmail: string) =>
  fetchTabFromSheet(subjectEmail, "מאגר במבי!A:AA"),
);
// Sehel: header is row 1 (the old workbook had a merged banner above
// it — the new "מאגר שכל" tab dropped that). Open-ended; ~29K rows at
// migration, A:T covers all 20 named cols.
const readSehel = cache((subjectEmail: string) =>
  fetchTabFromSheet(subjectEmail, "מאגר שכל!A:T"),
);
// Salesforce: single "Salesforce" tab in the same archive workbook (the
// two שיכון ובינוי projects — Essence + שיכון ובינוי חולון — use it).
// Header is row 1; A:P covers all 16 cols (~2K rows). NOTE: the project
// and creation-date headers carry a literal "↑" sort glyph
// ("פרויקט ↑" / "תאריך יצירה ↑"), so those columns are matched by
// prefix, not exact string, in computeSalesforceFunnel.
const readSalesforce = cache((subjectEmail: string) =>
  fetchTabFromSheet(subjectEmail, "Salesforce!A:P"),
);

/* ── Utility ────────────────────────────────────────────────────────── */

function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Candidate CRM-account strings a project's CRM rows may match against.
 *
 * The Keys `CRM` column is usually one account, but a few projects map
 * to several accounts the client tracks separately, comma-joined — e.g.
 * חבר → "תדהר בין השדרות תל אביב, קיימא, כוכב הצפון אשדוד" (3 distinct
 * Sehel accounts whose leads should all roll into the one משפך CRM).
 *
 * The catch: a comma can ALSO be part of a single account *name*, not a
 * separator — הגדה's Sehel account is literally "HaGada בני דן, תל אביב"
 * and Essence's Salesforce project is "בית צורי 22,24". Splitting those
 * would break the match.
 *
 * We can't know which a comma means, so we return BOTH readings: the
 * full raw string AND each comma-split part. The row-match (exact for
 * bmby/salesforce, prefix for sehel) accepts a row matching ANY
 * candidate, counting each row once. This is purely additive over the
 * old single-string match — comma-in-name projects (הגדה/Essence) keep
 * matching via the full string; comma-separated projects (חבר) also pick
 * up each account; single-account projects yield just [raw], identical
 * to before.
 */
function crmAccountCandidates(raw: string): string[] {
  const full = String(raw ?? "").trim();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of [full, ...full.split(",").map((s) => s.trim())]) {
    if (!c) continue;
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/**
 * Canonical form for source/`מקור הגעה` strings. The source data has
 * extensive casing chaos — "facebook" / "Facebook" / "FACEBOOK" co-exist
 * in BMBY (1418 / 341 / 159 rows respectively), plus similar drift on
 * "yad2" / "Yad2", "article" / "Article", "google" / "Google",
 * "minisite" / "Minisite", etc. Lower-casing collapses them so the
 * funnel doesn't show three "facebook" slices for the same channel.
 *
 * Doesn't touch internal punctuation — comma-joined multi-source values
 * like "facebook, yad2" stay grouped as one composite source because
 * that's the granularity the CRM itself logs at. (Splitting them into
 * sub-sources would over-count leads.)
 */
function normSource(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Integer median of a numeric array (0 when empty). */
function medianOf(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Per-channel speed-to-lead from the warehouse leads' `response_seconds`
 *  (seconds from lead arrival to first desk touch). Keyed by normSource so
 *  it lines up with the funnel's source palette. null/negative are dropped;
 *  zeros kept (instant/manual entries are legitimate). Returns undefined
 *  when nothing usable — caller leaves `speedToLead` unset so the panel
 *  hides. */
function computeSpeedToLead(
  leads: { media_source_clean: string | null; response_seconds: number | null }[],
): CrmFunnel["speedToLead"] {
  const bySrc = new Map<string, number[]>();
  const all: number[] = [];
  for (const l of leads) {
    const rs = l.response_seconds;
    if (rs == null || !Number.isFinite(rs) || rs < 0) continue;
    const src = normSource(l.media_source_clean);
    if (!src) continue;
    let arr = bySrc.get(src);
    if (!arr) bySrc.set(src, (arr = []));
    arr.push(rs);
    all.push(rs);
  }
  if (all.length === 0) return undefined;
  const stat = (a: number[]) => ({
    medianSec: medianOf(a),
    n: a.length,
    under60: a.filter((x) => x < 60).length,
    under300: a.filter((x) => x < 300).length,
  });
  const bySource: NonNullable<CrmFunnel["speedToLead"]>["bySource"] = {};
  for (const [src, a] of bySrc) bySource[src] = stat(a);
  return { overall: stat(all), bySource };
}

/** Returning vs new split from the warehouse leads' `is_return_lead`.
 *  Overall + per (normSource'd) channel. undefined when nothing flagged. */
function computeReturningSplit(
  leads: { media_source_clean: string | null; is_return_lead: boolean | null }[],
): CrmFunnel["returningSplit"] {
  const bySource: NonNullable<CrmFunnel["returningSplit"]>["bySource"] = {};
  let returning = 0;
  let newLeads = 0;
  for (const l of leads) {
    if (l.is_return_lead == null) continue;
    const isRet = l.is_return_lead === true;
    if (isRet) returning++;
    else newLeads++;
    const src = normSource(l.media_source_clean);
    if (src) {
      let b = bySource[src];
      if (!b) b = bySource[src] = { returning: 0, newLeads: 0 };
      if (isRet) b.returning++;
      else b.newLeads++;
    }
  }
  const total = returning + newLeads;
  if (total === 0) return undefined;
  return { total, returning, newLeads, bySource };
}

/** For each returning lead, the media channel of the client's immediately-
 *  PRIOR lead (from the project's full history), tallied as
 *  currentSource → { priorSource → count }. Returning leads whose prior is
 *  below the warehouse floor (pre-2024) have no locatable prior and are
 *  skipped, so the sums are a subset of the returning counts. */
function computeReturningPriors(
  returningLeads: {
    client_id: string | null;
    lead_created_at: string | null;
    media_source_clean: string | null;
  }[],
  history: {
    client_id: string | null;
    lead_created_at: string | null;
    media_source_clean: string | null;
  }[],
): Record<string, Record<string, number>> {
  const byClient = new Map<string, { ts: number; src: string }[]>();
  for (const h of history) {
    const c = String(h.client_id ?? "");
    if (!c) continue;
    const ts = Date.parse(h.lead_created_at ?? "");
    if (Number.isNaN(ts)) continue;
    let a = byClient.get(c);
    if (!a) byClient.set(c, (a = []));
    a.push({ ts, src: normSource(h.media_source_clean) });
  }
  for (const a of byClient.values()) a.sort((x, y) => x.ts - y.ts);

  const out: Record<string, Record<string, number>> = {};
  for (const l of returningLeads) {
    const c = String(l.client_id ?? "");
    if (!c) continue;
    const ts = Date.parse(l.lead_created_at ?? "");
    if (Number.isNaN(ts)) continue;
    const h = byClient.get(c);
    if (!h) continue;
    let prior: string | null = null;
    for (const e of h) {
      if (e.ts < ts) prior = e.src;
      else break;
    }
    if (!prior) continue;
    const cur = normSource(l.media_source_clean);
    if (!cur) continue;
    const inner = out[cur] || (out[cur] = {});
    inner[prior] = (inner[prior] || 0) + 1;
  }
  return out;
}

// IL weekday+hour formatter for the arrival heatmap (created once).
const IL_WEEKDAY_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Jerusalem",
  weekday: "short",
  hour: "2-digit",
  hour12: false,
});
const WD_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Lead-arrival heatmap: weekday(Sun=0..Sat=6) × hour(0-23) count, in
 *  Asia/Jerusalem (lead_created_at is a UTC timestamp). undefined when
 *  nothing parseable. */
function computeArrivalHeatmap(
  leads: { lead_created_at: string | null }[],
): CrmFunnel["arrivalHeatmap"] {
  const matrix: number[][] = Array.from({ length: 7 }, () =>
    new Array<number>(24).fill(0),
  );
  let total = 0;
  let peak = 0;
  for (const l of leads) {
    if (!l.lead_created_at) continue;
    const d = new Date(l.lead_created_at);
    if (Number.isNaN(d.getTime())) continue;
    const parts: Record<string, string> = {};
    for (const p of IL_WEEKDAY_HOUR.formatToParts(d)) parts[p.type] = p.value;
    const wd = WD_INDEX[parts.weekday];
    let hr = parseInt(parts.hour, 10);
    if (hr === 24) hr = 0; // some ICU builds emit "24" for midnight
    if (wd == null || !Number.isFinite(hr) || hr < 0 || hr > 23) continue;
    const v = ++matrix[wd][hr];
    total++;
    if (v > peak) peak = v;
  }
  if (total === 0) return undefined;
  return { matrix, total, peak };
}

/** Lead→held journey velocity (days), per channel. For each cohort client
 *  (first lead by lead_id order), find their first HELD meeting on/after the
 *  lead (1-day slack for same-day) and count the day gap, attributed to the
 *  lead's source. Skips clients whose only held meeting predates the lead
 *  (the audit's cross-period skew). undefined when nothing qualifies. */
function computeJourneyVelocity(
  leads: {
    client_id: string | null;
    lead_created_at: string | null;
    media_source_clean: string | null;
  }[],
  meetings: { client_id: string | null; appointment_outcome: string | null; meeting_date: string | null }[],
): CrmFunnel["journeyVelocity"] {
  const DAY = 86400000;
  const heldByClient = new Map<string, number[]>();
  for (const m of meetings) {
    if (m.appointment_outcome !== "held" || !m.meeting_date) continue;
    const c = String(m.client_id ?? "");
    if (!c) continue;
    const ms = Date.parse(m.meeting_date);
    if (Number.isNaN(ms)) continue;
    let arr = heldByClient.get(c);
    if (!arr) heldByClient.set(c, (arr = []));
    arr.push(ms);
  }
  for (const arr of heldByClient.values()) arr.sort((a, b) => a - b);

  const seen = new Set<string>();
  const bySrc = new Map<string, number[]>();
  const all: number[] = [];
  for (const l of leads) {
    const c = String(l.client_id ?? "");
    if (!c || seen.has(c)) continue;
    seen.add(c);
    const held = heldByClient.get(c);
    if (!held) continue;
    const leadMs = Date.parse(l.lead_created_at ?? "");
    if (Number.isNaN(leadMs)) continue;
    const firstAfter = held.find((d) => d >= leadMs - DAY);
    if (firstAfter == null) continue;
    const days = Math.max(0, Math.round((firstAfter - leadMs) / DAY));
    const src = normSource(l.media_source_clean);
    if (src) {
      let a = bySrc.get(src);
      if (!a) bySrc.set(src, (a = []));
      a.push(days);
    }
    all.push(days);
  }
  if (all.length === 0) return undefined;
  const stat = (a: number[]) => ({
    medianDays: medianOf(a),
    avgDays: Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10,
    n: a.length,
  });
  const bySource: NonNullable<CrmFunnel["journeyVelocity"]>["bySource"] = {};
  for (const [s, a] of bySrc) bySource[s] = stat(a);
  return { overall: stat(all), bySource };
}

/**
 * Inferred sales-funnel stage order for each platform. Public BMBY/Sehel
 * docs don't expose this taxonomy externally, so the orderings here are
 * a best-guess from the values we observed in the data plus standard
 * real-estate sales-funnel logic:
 *
 *   raw lead → first contact → active conversation → meeting scheduled →
 *   meeting(s) held → in purchase → contract
 *
 * Anything that doesn't fit the linear funnel (cancelled, returned to
 * pool, disqualified, no-answer) trails the funnel as "off-funnel side
 * states" so the bar reads left-to-right as a coherent progression.
 *
 * Update these arrays if BMBY/Sehel confirm a different order — the
 * funnel chart's status row picks top-N by selected-source count and
 * re-sorts the picks by the array's position; unknown stages append at
 * the end via `buildSourceMatrices`.
 */
export const BMBY_STATUS_FUNNEL_ORDER = [
  "ליד",
  "אינטרנט",
  "טלפון",
  "בטיפול",
  "אין מענה 1",
  "אין מענה 2",
  "אין מענה 3",
  "ליצור קשר",
  "נקבעה פגישה",
  "פגישה 1",
  "פגישה 2",
  "פגישה 3",
  "פגישה התקיימה",
  // שיחת מכירה sits late in the funnel — confirmed by Maayan
  // 2026-05-12: it's the closing/conversion conversation that happens
  // after meetings and right before the lead enters purchase.
  "שיחת מכירה",
  "ברכישה",
  "חוזה",
  // off-funnel side states — visually trail the linear funnel
  "פגישה בוטלה",
  "מאגר",
  "תעסוקה",
  "מסחר קטן",
  "הרשמה",
  "לא רלוונטי",
];

export const SEHEL_STATUS_FUNNEL_ORDER = [
  "| פניה חדשה",
  "| נוצר קשר ראשוני",
  "| בקשר",
  "| נשלחו חומרים",
  "| לקראת פגישה",
  "| לתאם פגישה מחדש",
  "| פגישה ללא סיכום",
  "| אחרי פגישה",
  "| פגישות",
  "| עסקה",
  // off-funnel side states
  "| הרשמה",
];

/**
 * Salesforce — F&F's third CRM. Unlike BMBY/Sehel (where the meeting
 * metrics are inferred from free-text status taxonomies), Salesforce's
 * funnel is defined explicitly by Maayan's status→bucket matrix
 * (2026-05-24). The three cumulative buckets map onto the existing
 * CrmFunnel KPIs:
 *
 *   ליד חדש (every status)  → leads
 *   נקבעה או בוטלה פגישה    → scheduledMeetings (תואמה פגישה)
 *   התבצעה פגישה           → meetings (held)
 *
 *   מצב ליד               ליד חדש  נקבעה/בוטלה  התבצעה
 *   לא רלוונטי              ✓
 *   חדש                    ✓
 *   ניסיון יצירת קשר        ✓
 *   אין מענה               ✓
 *   שיחה                   ✓
 *   ניסיון תיאום פגישה      ✓         ✓
 *   טופס הרשמה             ✓         ✓          ✓
 *   פגישה התקיימה          ✓         ✓          ✓
 *   ליד חוזר               ✓
 *
 * (טופס הרשמה — registering for the דיור-למשתכן lottery — is the real
 * conversion goal for these projects, so the owner counts it the same as
 * a held meeting.) `contacted` (נוצר קשר) isn't one of the matrix
 * buckets; it's derived as "any status past חדש" — i.e. a salesperson
 * has worked the lead — mirroring BMBY's "an outreach attempt was
 * logged" notion of contacted.
 */
const SALESFORCE_SCHEDULED_STATUSES = new Set<string>([
  "ניסיון תיאום פגישה",
  "טופס הרשמה",
  "פגישה התקיימה",
]);
const SALESFORCE_HELD_STATUSES = new Set<string>([
  "טופס הרשמה",
  "פגישה התקיימה",
]);

export const SALESFORCE_STATUS_FUNNEL_ORDER = [
  "חדש",
  "ניסיון יצירת קשר",
  "אין מענה",
  "שיחה",
  "ניסיון תיאום פגישה",
  "טופס הרשמה",
  "פגישה התקיימה",
  // off-funnel side states
  "ליד חוזר",
  "לא רלוונטי",
];

/**
 * Action-required early-funnel stages for the stale-leads detection.
 *
 * Deliberately TIGHTER than "everything before נקבעה פגישה" — that
 * broader interpretation surfaced ~16K rows across the BMBY workbook
 * (~80% of all leads) because `טלפון` is the steady-state of the
 * pipeline, not an actionable early stage. The probe on 2026-05-12
 * confirmed: with the broad set, every project fired a stale-leads
 * alert in the hundreds. With the tighter set + contact-recency
 * filter, the same probe surfaced 7 projects with 5-40 each — the
 * truly fell-through-the-cracks subset.
 *
 *   BMBY:  ליד / ליצור קשר / אין מענה N / בטיפול. These are explicit
 *          "needs a follow-up touch" states. Excludes טלפון
 *          (in-pipeline default) and אינטרנט (source-state default).
 *   Sehel: פניה חדשה / נוצר קשר ראשוני / נשלחו חומרים. Excludes
 *          בקשר (active conversation, similar steady-state role to
 *          טלפון in BMBY).
 *
 * A row also has to clear a contact-recency check below before
 * counting as stale — both entry AND last contact must be older than
 * STALE_LEAD_DAYS. Salespeople who touched a lead recently shouldn't
 * see their workflow flagged.
 */
const BMBY_EARLY_FUNNEL_STAGES = new Set<string>([
  "ליד",
  "ליצור קשר",
  "אין מענה 1",
  "אין מענה 2",
  "אין מענה 3",
  "בטיפול",
]);
const SEHEL_EARLY_FUNNEL_STAGES = new Set<string>([
  "| פניה חדשה",
  "| נוצר קשר ראשוני",
  "| נשלחו חומרים",
]);
// Salesforce: needs-a-follow-up early states. Salesforce carries NO
// contact/update timestamp (only תאריך יצירה), so the stale check has
// no contact-recency anchor — it relies on creation date alone. That's
// acceptable here: a lead created >14d ago that's STILL in one of these
// untouched/early states genuinely fell through the cracks.
const SALESFORCE_EARLY_FUNNEL_STAGES = new Set<string>([
  "חדש",
  "ניסיון יצירת קשר",
  "אין מענה",
]);
const STALE_LEAD_DAYS = 14;

/* ── Date-window filter ─────────────────────────────────────────────── */

/**
 * The active date filter applied to a funnel cohort.
 *   - `month`: a single "YYYY-MM" — the dashboard's month-rewind view.
 *   - `range`: an inclusive [from,to] ISO window — the project's flight
 *     dates (התחלה→סיום from ALL CLIENTS). This is the DEFAULT so the CRM
 *     card matches the report header's date envelope instead of the bare
 *     calendar month.
 * `label` is the human string shown on the section chip.
 */
type DateWindow =
  | { kind: "month"; month: string; label: string }
  | { kind: "range"; from: string; to: string; label: string };

/**
 * Whether a row's (already date-only "YYYY-MM-DD") entry date falls in
 * the window. Undated rows are excluded whenever a window is active —
 * matches the prior month-filter behavior, where "".startsWith(month)
 * evaluated false.
 */
function rowInWindow(d: string, w: DateWindow | null): boolean {
  if (!w) return true;
  if (!d) return false;
  return w.kind === "month" ? d.startsWith(w.month) : d >= w.from && d <= w.to;
}

/** ISO "YYYY-MM-DD" → "dd/MM/yyyy" for the window chip label. */
function ddmmyyyy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** YYYY-MM-DD for "today" in Asia/Jerusalem — same anchor as the rest of
 *  the codebase (agenda, currentMonthIL, dismissals). */
function todayIsoIL(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Last calendar day of a "YYYY-MM" month, as YYYY-MM-DD. */
function lastDayOfMonthIso(month: string): string {
  const [y, mo] = month.split("-").map(Number); // mo is 1-based
  const day = new Date(y, mo, 0).getDate(); // day 0 of the next month = last of this one
  return `${month}-${String(day).padStart(2, "0")}`;
}

/**
 * Data-freshness gap for the CRM-funnel card. Given the active window and
 * the latest CRM-record date inside it (`dataTo`, "YYYY-MM-DD" or ""),
 * returns `dataTo` when the data ends at least FRESHNESS_LAG_DAYS before the
 * window's *expected* end — `min(window end, today)`, since days still in the
 * future can't carry data yet — else "". The window chip already shows the
 * *requested* range; this surfaces only the meaningful gap between what was
 * requested and what the source actually covers (a pipeline-lag tell, most
 * relevant for the sheet-fed CRMs). Pure; today is Asia/Jerusalem.
 */
const FRESHNESS_LAG_DAYS = 3;
function dataFreshnessLag(window: DateWindow | null, dataTo: string): string {
  if (!window || !dataTo) return "";
  const windowEnd =
    window.kind === "month" ? lastDayOfMonthIso(window.month) : window.to;
  const today = todayIsoIL();
  const expectedEnd = windowEnd < today ? windowEnd : today; // min(windowEnd, today)
  if (dataTo >= expectedEnd) return "";
  const lagDays =
    (Date.parse(`${expectedEnd}T00:00:00Z`) - Date.parse(`${dataTo}T00:00:00Z`)) /
    86_400_000;
  return lagDays >= FRESHNESS_LAG_DAYS ? dataTo : "";
}

/**
 * Convert the per-day per-source matrix into the flat, sorted array
 * shape the trendline component consumes. Dates ascending so the chart
 * walks left-to-right (or right-to-left in RTL; the SVG is direction-
 * agnostic, but the lib output stays in chronological order so
 * client-side sorting isn't needed).
 */
function buildDailyTimeSeries(
  matrix: Map<
    string,
    Map<string, { leads: number; scheduledMeetings: number; meetings: number }>
  >,
): CrmFunnel["dailyTimeSeries"] {
  const days = [...matrix.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return days.map(([date, perSource]) => ({
    date,
    bySource: [...perSource.entries()].map(([source, counts]) => ({
      source,
      leads: counts.leads,
      scheduledMeetings: counts.scheduledMeetings,
      meetings: counts.meetings,
    })),
  }));
}

function dateOnly(value: unknown): string {
  // Source data can be either "YYYY-MM-DD" (BMBY entry date), "dd-mm-yyyy hh:mm"
  // (Sehel registration), or a sheets serial number when the cell is
  // typed as date but UNFORMATTED_VALUE returns the underlying number.
  // We just need a comparable string for min/max display — normalize
  // to ISO YYYY-MM-DD when possible, fall back to as-is.
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  // ISO already
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  // dd-mm-yyyy, dd/mm/yyyy or dd.mm.yyyy (day-first). The Sehel
  // "מאגר שכל" tab mixes separators — older rows use "-", newer rows
  // (from ~May 2026) use "/". Because readSehel reads with
  // dateTimeRenderOption:"FORMATTED_STRING", we get whatever the cell
  // displays verbatim, so the parser MUST accept both. When it only
  // matched "-", every slash-formatted row fell through to the raw
  // "dd/mm/yyyy" string, which fails the window's startsWith("YYYY-MM")
  // / `>= from` checks → the entire current-month cohort silently
  // dropped to zero leads and the CRM funnel card collapsed (e.g.
  // אחוזת אפרידר: 211 June leads counted as 0). See probe-dateonly-fix.
  const m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  // sheets serial (days since 1899-12-30). Convert to YYYY-MM-DD.
  const n = Number(raw);
  if (Number.isFinite(n) && n > 25000 && n < 80000) {
    const ms = (n - 25569) * 86400 * 1000;
    const iso = new Date(ms).toISOString().slice(0, 10);
    // Defensive: the Sehel aggregate's CRM workbook had a locale bug
    // where dd-mm-yyyy text was coerced to a serial under en_US
    // (mm-dd-yyyy) interpretation — so e.g. "11-05-2026" (May 11) ended
    // up stored as serial 46331 ≈ 2026-11-05 (Nov 5). The locale was
    // flipped and the source archives are clean text, but rows
    // converted before the fix stay numeric forever. CRM registration
    // / update dates can never legitimately be in the future, so when
    // a serial decodes to a date >1 day past today AND both fields are
    // ≤12 (so the swap is reversible), assume the swap and un-swap it.
    if (iso > horizonIso()) {
      const [y, mm, dd] = iso.split("-");
      const dN = Number(dd);
      const mN = Number(mm);
      if (dN >= 1 && dN <= 12 && mN >= 1 && mN <= 12) {
        // Swap day/month → returns the date the row was meant to carry.
        return `${y}-${dd}-${mm}`;
      }
    }
    return iso;
  }
  return raw.slice(0, 10);
}

/** "today + 1 day" in Asia/Jerusalem, ISO. Used as the future-date
 *  threshold in the defensive serial swap above. One-day buffer
 *  absorbs server/UTC offset edge cases at midnight. Memoized per
 *  process — the value only changes once a day and dateOnly is hot. */
let _horizonCache = { ms: 0, iso: "" };
function horizonIso(): string {
  const nowMs = Date.now();
  if (nowMs - _horizonCache.ms < 60_000) return _horizonCache.iso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(nowMs + 86400_000));
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  _horizonCache = { ms: nowMs, iso: `${y}-${m}-${d}` };
  return _horizonCache.iso;
}

/* ── BMBY funnel ───────────────────────────────────────────────────── */

async function computeBmbyFunnel(
  subjectEmail: string,
  crmAccount: string,
  window: DateWindow | null,
): Promise<CrmFunnel | null> {
  const { headers, rows } = await readBmby(subjectEmail);
  const funnel = aggregateBmbyFunnel(headers, rows, crmAccount, window);
  if (funnel) funnel.dataSource = "sheet";
  return funnel;
}

/** Pure BMBY funnel aggregation over already-loaded rows. Shared by the
 *  Sheet path (computeBmbyFunnel) and the warehouse path
 *  (computeBmbyFunnelFromWarehouse, which feeds it synthetic rows in the
 *  same column layout). Keeping it row-source-agnostic means the source
 *  pies, status funnel, objections matrix, daily trend and stale-leads
 *  detection are all built by ONE code path — no duplication, guaranteed
 *  shape parity between the two backends. */
function aggregateBmbyFunnel(
  headers: string[],
  rows: unknown[][],
  crmAccount: string,
  window: DateWindow | null,
): CrmFunnel | null {
  if (!rows.length) return null;
  const iEntry = headers.indexOf("תאריך כניסה");
  const iStatus = headers.indexOf("סטאטוס");
  const iSource = headers.indexOf("מקור הגעה");
  const iProject = headers.indexOf("פרויקט");
  const iObjection = headers.indexOf("התנגדויות");
  const iContactDate = headers.indexOf("תאריך קשר");
  // `is_meeting` (the boolean column the old workbook carried) was dropped
  // in the 2026-05-12 schema migration. Verified via
  // scripts/probe-ismeeting-redundancy.mjs that the legacy flag was 100%
  // derivable from `סטאטוס.includes("פגישה")` (706 of 706 meeting rows
  // matched against the old data; zero false negatives). The same status
  // taxonomy is present in the new workbook — re-verified during the
  // migration probe — so the in-code derivation matches what `is_meeting`
  // would have told us, exactly. `איש מכירות` was also dropped in the same
  // schema change; topSellers returns [] for BMBY now (UI already
  // handles empty cleanly).
  if (iProject < 0) return null;

  // One project can map to several comma-joined CRM accounts; a comma
  // can also be part of a single account name. crmAccountCandidates
  // returns both readings — match ANY. See its doc for the overload.
  const targets = crmAccountCandidates(crmAccount).map(norm);
  let leads = 0;
  let scheduledMeetings = 0; // תואמה פגישה — broad, includes cancelled
  let meetings = 0;          // פגישות — narrow, actually-held only
  let contacted = 0;
  let contracts = 0;         // חוזה — signed (current-status snapshot)
  const byStatus = new Map<string, number>();
  const byObjection = new Map<string, number>();
  const bySource = new Map<string, number>();
  // Per-KPI source breakdowns for the hover-popover pies on the KPI
  // tiles. Each Map tracks, for the subset of rows that contributed to
  // that KPI, which `מקור הגעה` they came from. leadsBySource is
  // equivalent to the full bySource map (every counted row is a lead),
  // but kept separate for clarity at the render site.
  const leadsBySource = new Map<string, number>();
  const contactedBySource = new Map<string, number>();
  const scheduledMeetingsBySource = new Map<string, number>();
  const meetingsBySource = new Map<string, number>();
  const contractsBySource = new Map<string, number>();
  // Stale-leads tracking: runs BEFORE the monthFilter check below so
  // it sees every row of the project, not just the filtered cohort.
  // A lead that came in 60 days ago and is STILL in "טלפון" today is
  // stale regardless of which month the user is currently viewing.
  let staleCount = 0;
  let staleOldestDays = 0;
  const staleByStage = new Map<string, number>();
  const staleThresholdMs = STALE_LEAD_DAYS * 86400_000;
  const nowMs = Date.now();
  // Daily time series — date → source → { leads, scheduled, meetings }.
  // Same per-source tracking as the maps above so the trendline can be
  // filtered client-side by the selected source set without re-reading
  // the sheet.
  const dailySourceMatrix = new Map<
    string,
    Map<string, { leads: number; scheduledMeetings: number; meetings: number }>
  >();
  // For each objection, a map of source → count. We materialize this only
  // for rows where BOTH an objection AND a source are present (otherwise
  // the cross-tab adds noise without information).
  const objectionSourceMatrix = new Map<string, Map<string, number>>();
  // For each status, a map of source → count. Parallel to
  // objectionSourceMatrix but for the funnel-stage breakdown. Lets each
  // funnel row render the source mix that fed into that stage, sharing
  // the source→color legend with the objections cross-tab.
  const statusSourceMatrix = new Map<string, Map<string, number>>();
  let minDate = "";
  let maxDate = "";

  for (const row of rows) {
    const arr = row as unknown[];
    const proj = norm(arr[iProject]);
    if (!targets.includes(proj)) continue;

    // Stale-leads check — runs against EVERY project row (deliberately
    // before the monthFilter bail below). A row counts as stale when
    // ALL of:
    //   1. status is in the action-required early-funnel set
    //   2. תאריך כניסה > 14d ago
    //   3. תאריך קשר is empty OR > 14d ago (no recent touch)
    // The contact-recency check is critical — without it, the alert
    // surfaces the entire historical pipeline. Probe on 2026-05-12
    // showed: filter (3) drops the noise floor from ~16K alerts to a
    // handful of genuinely-abandoned leads per project.
    if (iEntry >= 0) {
      const stRow = String(arr[iStatus] ?? "").trim();
      if (stRow && BMBY_EARLY_FUNNEL_STAGES.has(stRow)) {
        const dEntry = dateOnly(arr[iEntry]);
        if (dEntry) {
          const entryMs = Date.parse(dEntry + "T00:00:00");
          if (!Number.isNaN(entryMs) && nowMs - entryMs > staleThresholdMs) {
            // Contact-recency: use last touch (contact date if set,
            // otherwise entry date) as the "days since last activity"
            // anchor. Both must be > threshold for the row to qualify.
            let lastTouchMs = entryMs;
            if (iContactDate >= 0) {
              const dContact = dateOnly(arr[iContactDate]);
              if (dContact) {
                const contactMs = Date.parse(dContact + "T00:00:00");
                if (!Number.isNaN(contactMs)) lastTouchMs = contactMs;
              }
            }
            if (nowMs - lastTouchMs > staleThresholdMs) {
              staleCount++;
              staleByStage.set(stRow, (staleByStage.get(stRow) || 0) + 1);
              const days = Math.floor((nowMs - lastTouchMs) / 86400_000);
              if (days > staleOldestDays) staleOldestDays = days;
            }
          }
        }
      }
    }

    // Date-window filter — apply before everything else so KPIs, status,
    // objections, etc. are all consistent against the same row cohort.
    if (window && iEntry >= 0) {
      if (!rowInWindow(dateOnly(arr[iEntry]), window)) continue;
    }
    leads++;
    // Two meeting metrics (per Maayan, 2026-05-12):
    //
    //   תואמה פגישה (scheduled) — any "פגישה" status, including
    //     "נקבעה פגישה" (set but not yet held) and "פגישה בוטלה"
    //     (cancelled). Catches everyone who reached the meeting stage
    //     in their lifecycle. Equivalent to the legacy `is_meeting=1`
    //     boolean (verified via probe-ismeeting-redundancy.mjs).
    //
    //   פגישות (held) — only statuses where a meeting actually took
    //     place: numbered visits ("פגישה 1/2/3") and the explicit
    //     "פגישה התקיימה". Excludes the scheduled-only ("נקבעה פגישה")
    //     and cancelled ("פגישה בוטלה") variants.
    //
    // Always scheduledMeetings >= meetings. The diff is exactly the
    // "no-show + pending" subset, which is small but operationally
    // meaningful (it's the gap between "we got them to commit" and
    // "they actually showed up").
    const st = String(arr[iStatus] ?? "").trim();
    const isScheduledMeeting = st.includes("פגישה");
    const isHeldMeeting =
      /^פגישה\s+\d+$/.test(st) || st === "פגישה התקיימה";
    const isContract = st === "חוזה";
    if (isScheduledMeeting) scheduledMeetings++;
    if (isHeldMeeting) meetings++;
    if (isContract) contracts++;
    // "Contacted" proxy: row has a non-empty תאריך קשר. The CRM populates
    // this the first time a salesperson logs an outreach attempt, so it's
    // a reasonable "did anyone try?" signal short of pulling the full
    // activity log.
    const isContacted = iContactDate >= 0 && String(arr[iContactDate] ?? "").trim() !== "";
    if (isContacted) contacted++;
    if (st) byStatus.set(st, (byStatus.get(st) || 0) + 1);
    const obj = String(arr[iObjection] ?? "").trim();
    if (obj) byObjection.set(obj, (byObjection.get(obj) || 0) + 1);
    const src = normSource(arr[iSource]);
    if (src) {
      bySource.set(src, (bySource.get(src) || 0) + 1);
      leadsBySource.set(src, (leadsBySource.get(src) || 0) + 1);
      if (isContacted) contactedBySource.set(src, (contactedBySource.get(src) || 0) + 1);
      if (isScheduledMeeting) scheduledMeetingsBySource.set(src, (scheduledMeetingsBySource.get(src) || 0) + 1);
      if (isHeldMeeting) meetingsBySource.set(src, (meetingsBySource.get(src) || 0) + 1);
    }
    if (obj && src) {
      let m2 = objectionSourceMatrix.get(obj);
      if (!m2) { m2 = new Map<string, number>(); objectionSourceMatrix.set(obj, m2); }
      m2.set(src, (m2.get(src) || 0) + 1);
    }
    if (st && src) {
      let m3 = statusSourceMatrix.get(st);
      if (!m3) { m3 = new Map<string, number>(); statusSourceMatrix.set(st, m3); }
      m3.set(src, (m3.get(src) || 0) + 1);
    }
    const d = dateOnly(arr[iEntry]);
    // Daily time series — record this row's contribution to its
    // (date, source) bucket. Rows without a parseable date or source
    // can't be plotted, so they're skipped here (still counted in the
    // overall KPIs above).
    if (d && src) {
      let perDay = dailySourceMatrix.get(d);
      if (!perDay) {
        perDay = new Map();
        dailySourceMatrix.set(d, perDay);
      }
      let bucket = perDay.get(src);
      if (!bucket) {
        bucket = { leads: 0, scheduledMeetings: 0, meetings: 0 };
        perDay.set(src, bucket);
      }
      bucket.leads++;
      if (isScheduledMeeting) bucket.scheduledMeetings++;
      if (isHeldMeeting) bucket.meetings++;
    }
    if (d) {
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
  }

  if (leads === 0) return null;
  return {
    platform: "bmby",
    crmAccount,
    leads,
    contacted,
    scheduledMeetings,
    meetings,
    contracts,
    meetingRatePct: leads > 0 ? (meetings / leads) * 100 : null,
    // איש מכירות column dropped in the 2026-05-12 schema migration —
    // no seller breakdown anymore; UI already handles empty cleanly.
    topSellers: [],
    sourceMatrices: buildSourceMatrices({
      allSourcesMap: bySource,
      statusObserved: byStatus,
      funnelOrder: BMBY_STATUS_FUNNEL_ORDER,
      leadsBySource, contactedBySource,
      scheduledMeetingsBySource, meetingsBySource,
      contractsBySource,
      statusSourceMatrix, objectionSourceMatrix,
    }),
    dailyTimeSeries: buildDailyTimeSeries(dailySourceMatrix),
    dateRange: { from: minDate, to: maxDate },
    staleLeads: {
      count: staleCount,
      oldestDays: staleOldestDays,
      byStage: [...staleByStage.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([stage, count]) => ({ stage, count })),
    },
    monthFilter: window?.kind === "month" ? window.month : "",
    windowLabel: window?.kind === "range" ? window.label : "",
  };
}

/* ── BMBY funnel from the Supabase warehouse (journey events) ──────────
 * Produces the SAME CrmFunnel as the Sheet path by synthesizing one row
 * per warehouse lead (cohort = leads created in the window) carrying the
 * columns aggregateBmbyFunnel reads, then running the identical
 * aggregation. A lead's meeting state is joined from v_bmby_journey_meetings
 * by client_id: a HELD event → "פגישה התקיימה" (counts scheduled+held); any
 * other meeting event → "נקבעה פגישה" / "פגישה בוטלה" (scheduled only);
 * otherwise the lead's client_status maps to an early/late funnel stage.
 * Source token = media_source_clean (same token family the Sheet uses, so
 * the cost-join canonicalizer and the source chips work unchanged).
 *
 * Returns null — so the caller keeps the Sheet funnel — on: no key, no
 * window (unbounded fetch), unknown project, or zero in-window leads.
 *
 * NOTE: held counts reflect the warehouse's CONFIRMED outcomes, which are
 * logged retrospectively, so current-month held is naturally low and grows
 * through the month (see lib/crmEnrichment.ts). Stale-leads detection here
 * is window-scoped (the Sheet path sees all-time rows) — acceptable for v1. */
async function computeBmbyFunnelFromWarehouse(
  crmAccount: string,
  window: DateWindow | null,
): Promise<CrmFunnel | null> {
  if (!supabaseConfigured() || !window) return null;
  // Window bounds [from, toExcl).
  let from = "";
  let toExcl = "";
  if (window.kind === "month") {
    from = `${window.month}-01`;
    const [y, mo] = window.month.split("-").map(Number);
    toExcl =
      mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
  } else {
    from = window.from;
    const d = new Date(`${window.to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    toExcl = d.toISOString().slice(0, 10);
  }
  // Resolve numeric project_id (the leads view keys on it).
  const proj = await supabaseRowsAll<{ project_id: number }>(
    `v_report_v2_bmby_projects?select=project_id&project_name=eq.${encodeURIComponent(crmAccount)}`,
  );
  const pid = proj[0]?.project_id;
  if (pid == null) return null;
  // Window-cohort leads.
  const leads = await supabaseRowsAll<{
    client_id: string | null;
    lead_created_at: string | null;
    handled_at: string | null;
    is_handled: boolean | null;
    response_seconds: number | null;
    is_return_lead: boolean | null;
    media_source_clean: string | null;
    objections: string | null;
    client_status: string | null;
    pipeline: string | null;
    channel_key: string | null;
    utm_medium: string | null;
    utm_term: string | null;
    utm_content: string | null;
    utm_campaign: string | null;
  }>(
    `v_bmby_leads_bucketed?project_id=eq.${pid}` +
      `&lead_created_at=gte.${from}&lead_created_at=lt.${toExcl}` +
      `&select=client_id,lead_id,lead_created_at,handled_at,is_handled,response_seconds,is_return_lead,media_source_clean,objections,client_status,pipeline,channel_key,utm_medium,utm_term,utm_content,utm_campaign` +
      // Stable total order on the PK — Range pagination is non-deterministic
      // without an explicit ORDER BY (rows could repeat/drop past 1000).
      `&order=lead_id.asc`,
  );
  if (!leads.length) return null;
  // Project journey meetings (all dates) → per-client meeting state.
  const meetings = await supabaseRowsAll<{
    client_id: string | null;
    appointment_outcome: string | null;
    meeting_date: string | null;
  }>(
    `v_bmby_journey_meetings?project_he=eq.${encodeURIComponent(crmAccount)}` +
      `&select=client_id,appointment_outcome,meeting_date&order=meeting_id.asc`,
  );
  const heldClients = new Set<string>();
  const anyClients = new Set<string>();
  const nonCanceledClients = new Set<string>();
  for (const m of meetings) {
    const c = String(m.client_id ?? "");
    if (!c) continue;
    anyClients.add(c);
    if (m.appointment_outcome === "held") heldClients.add(c);
    if (m.appointment_outcome !== "canceled") nonCanceledClients.add(c);
  }
  // Synthesize rows in the BMBY column layout aggregateBmbyFunnel reads.
  const headers = [
    "פרויקט",
    "תאריך כניסה",
    "מקור הגעה",
    "סטאטוס",
    "התנגדויות",
    "תאריך קשר",
  ];
  // A client can own MULTIPLE in-window lead rows (return leads). Each row
  // is a real lead (counted), but the client's meeting is a single event —
  // so stamp the meeting status on only the FIRST row per client; later
  // return-lead rows get a neutral in-progress status. Otherwise scheduled/
  // held (and meetingRate) over-count by the return-lead multiple. Leads
  // are ordered by lead_id, so "first" is deterministic.
  const meetingStamped = new Set<string>();
  const rows: unknown[][] = leads.map((l) => {
    const c = String(l.client_id ?? "");
    const hasMeeting = !!c && anyClients.has(c);
    let status: string;
    if (hasMeeting && !meetingStamped.has(c)) {
      meetingStamped.add(c);
      status = heldClients.has(c)
        ? "פגישה התקיימה"
        : nonCanceledClients.has(c)
          ? "נקבעה פגישה"
          : "פגישה בוטלה";
    } else if (hasMeeting) {
      // return-lead row for an already-counted client — don't re-count the
      // meeting; show as in-progress so the status funnel still places it.
      status = l.is_handled ? "בטיפול" : "ליד";
    } else {
      status = mapWarehouseStatus(l.client_status, l.pipeline, l.is_handled);
    }
    // Any lead with a meeting is contacted by definition (the is_handled
    // flag occasionally lags), so contacted >= scheduled >= held holds.
    const contactDate =
      l.is_handled || hasMeeting
        ? (l.handled_at || l.lead_created_at || "").slice(0, 10)
        : "";
    return [
      crmAccount,
      (l.lead_created_at || "").slice(0, 10),
      (l.media_source_clean || "").trim(),
      status,
      (l.objections || "").trim(),
      contactDate,
    ];
  });
  const funnel = aggregateBmbyFunnel(headers, rows, crmAccount, window);
  if (funnel) {
    funnel.dataSource = "warehouse";
    // Speed-to-lead + returning/new split + arrival heatmap — all derived
    // from the leads we already fetched (no extra query). Whole-window.
    funnel.speedToLead = computeSpeedToLead(leads);
    funnel.returningSplit = computeReturningSplit(leads);
    // Prior-channel breakdown for returning leads — needs the project's full
    // lead history (the prior inquiry is usually before the window), so a
    // separate paginated read, gated on there being returning leads.
    if (funnel.returningSplit && funnel.returningSplit.returning > 0) {
      const history = await supabaseRowsAll<{
        client_id: string | null;
        lead_created_at: string | null;
        media_source_clean: string | null;
      }>(
        `v_bmby_leads_bucketed?project_id=eq.${pid}` +
          `&select=client_id,lead_created_at,media_source_clean&order=lead_id.asc`,
      );
      funnel.returningSplit.priorBySource = computeReturningPriors(
        leads.filter((l) => l.is_return_lead === true),
        history,
      );
    }
    funnel.arrivalHeatmap = computeArrivalHeatmap(leads);
    funnel.journeyVelocity = computeJourneyVelocity(leads, meetings);
    // Contracts: the synthesized funnel status stamps meeting state over a
    // lead, hiding "חוזה" for any contracted lead that also had a meeting.
    // Recount from the raw client_status, per distinct client (return leads
    // share one status), attributing to the client's first lead source.
    {
      const seen = new Set<string>();
      const bySrc: Record<string, number> = {};
      let n = 0;
      for (const l of leads) {
        if (l.client_status !== "חוזה") continue;
        const c = String(l.client_id ?? "");
        if (c && seen.has(c)) continue;
        if (c) seen.add(c);
        n++;
        const src = normSource(l.media_source_clean);
        if (src) bySrc[src] = (bySrc[src] || 0) + 1;
      }
      funnel.contracts = n;
      funnel.sourceMatrices.contractsBySource = bySrc;
    }
    // FB UTM drill — placement / audience / creative split of the Meta
    // (channel_key='fb' = fb+ig+an) leads. Creative rows also carry
    // scheduled/held (warehouse) + spend & CPL/CPS/CPM (joined from the
    // dashboard's facebook-ads-metrics Sheet by exact campaign + ad name).
    funnel.fbBreakdown = await buildFbBreakdown(leads, anyClients, heldClients, from, toExcl);
  }
  return funnel;
}

type FbLead = {
  client_id: string | null;
  channel_key: string | null;
  utm_medium: string | null;
  utm_term: string | null;
  utm_content: string | null;
  utm_campaign: string | null;
};

/** Placement / audience / creative breakdown of a project's Meta leads
 *  (channel_key='fb' = fb+ig+an) from their UTM tags. Placement/audience are
 *  lead-count splits; the creative rows (= ad name / utm_content) also carry
 *  scheduled/held (from the warehouse meeting sets) and spend + CPL/CPS/CPM
 *  joined from the dashboard's facebook-ads-metrics Sheet (cost ÷ each).
 *  undefined when the project has no Meta leads. */
async function buildFbBreakdown(
  leads: FbLead[],
  anyClients: Set<string>,
  heldClients: Set<string>,
  from: string,
  toExcl: string,
): Promise<CrmFunnel["fbBreakdown"]> {
  const fb = leads.filter((l) => l.channel_key === "fb");
  if (!fb.length) return undefined;
  const TOP = 8;
  const tally = (get: (l: FbLead) => string): { label: string; leads: number }[] => {
    const m = new Map<string, number>();
    for (const l of fb) {
      const v = get(l).replace(/\s+/g, " ").trim();
      if (!v) continue;
      m.set(v, (m.get(v) || 0) + 1);
    }
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const head = sorted.slice(0, TOP).map(([label, n]) => ({ label, leads: n }));
    const restN = sorted.slice(TOP).reduce((s, [, n]) => s + n, 0);
    if (restN > 0) head.push({ label: "אחר", leads: restN });
    return head;
  };
  // utm_term occasionally carries a raw Meta numeric ID — bucket to "אחר".
  const deId = (raw: string): string => {
    const v = raw.replace(/\s+/g, " ").trim();
    return /^\d{8,}$/.test(v) ? "אחר" : v;
  };

  // Per-creative (= normalized ad name) leads / scheduled / held + the set of
  // campaigns the Meta leads came from (used to scope the spend join).
  const creatives = new Map<string, { leads: number; scheduled: number; held: number }>();
  const campaigns = new Set<string>();
  for (const l of fb) {
    const camp = String(l.utm_campaign ?? "").replace(/\s+/g, " ").trim();
    if (camp && !/^\d{8,}$/.test(camp)) campaigns.add(camp);
    const ad = normAdName(l.utm_content);
    if (!ad || /^\d{8,}$/.test(ad)) continue; // skip bare ad-id labels
    const c = String(l.client_id ?? "");
    const rec = creatives.get(ad) || { leads: 0, scheduled: 0, held: 0 };
    rec.leads++;
    if (c && anyClients.has(c)) rec.scheduled++;
    if (c && heldClients.has(c)) rec.held++;
    creatives.set(ad, rec);
  }
  // Join per-ad spend from the dashboard's facebook-ads-metrics Sheet (exact
  // campaign scope → collision-free). Degrades to spend=0 on any failure.
  let spendByAd = new Map<string, { cost: number; impressions: number; websiteLeads: number }>();
  try {
    spendByAd = await fbAdSpendByCreative(driveFolderOwner(), campaigns, from, toExcl);
  } catch {
    /* leave spend at 0 */
  }
  const byCreative = [...creatives.entries()]
    .map(([label, r]) => {
      const spend = spendByAd.get(label)?.cost ?? 0;
      return {
        label,
        leads: r.leads,
        scheduled: r.scheduled,
        held: r.held,
        spend,
        cpl: r.leads ? spend / r.leads : 0,
        cps: r.scheduled ? spend / r.scheduled : 0,
        cpm: r.held ? spend / r.held : 0,
      };
    })
    .sort((a, b) => b.leads - a.leads)
    .slice(0, TOP);

  return {
    totalLeads: fb.length,
    // utm_medium = ad placement (Facebook_Mobile_Feed → "Facebook Mobile Feed").
    byPlacement: tally((l) => String(l.utm_medium ?? "").replace(/_/g, " ")),
    byAudience: tally((l) => deId(String(l.utm_term ?? ""))),
    byCreative,
  };
}

/** Map a warehouse lead with NO meeting event to a BMBY funnel status
 *  (one of BMBY_STATUS_FUNNEL_ORDER) so it slots into the status funnel. */
function mapWarehouseStatus(
  clientStatus: string | null,
  pipeline: string | null,
  isHandled: boolean | null,
): string {
  const cs = String(clientStatus ?? "").trim();
  if (cs === "חוזה") return "חוזה";
  // A client_status of "פגישה N" with NO journey meeting event is NOT
  // treated as scheduled: BMBY's דוח יחסי המרה counts meetings from actual
  // events, and inferring one from the status alone over-counts תואמה פגישה
  // (kenko: +13 phantom → 48 vs BMBY's ~32). Meeting state comes solely from
  // v_bmby_journey_meetings (the caller stamps it before falling back here),
  // so a status-only "meeting" with no event shows as in-progress below.
  if (cs === "טלפון") return "טלפון";
  if (cs === "אינטרנט") return "אינטרנט";
  if (cs === "ליד") return "ליד";
  if (String(pipeline ?? "").trim() === "לא רלוונטי") return "לא רלוונטי";
  return isHandled ? "בטיפול" : "ליד";
}

/* ── Sehel funnel ──────────────────────────────────────────────────── */

async function computeSehelFunnel(
  subjectEmail: string,
  crmAccount: string,
  window: DateWindow | null,
): Promise<CrmFunnel | null> {
  const { headers, rows } = await readSehel(subjectEmail);
  if (!rows.length) return null;
  const iStage = headers.indexOf("שלב טיפול");
  const iMeetingDate = headers.indexOf("תאריך פגישה אחרונה");
  const iProject = headers.indexOf("פרויקט");
  const iObjection = headers.indexOf("התנגדויות");
  const iSource = headers.indexOf("מקור הגעה");
  const iRegDate = headers.indexOf("תאריך רישום");
  const iUpdate = headers.indexOf("עדכון אחרון");
  if (iProject < 0) return null;

  // Sehel rows are formatted "<project name> <salesperson>" — a prefix
  // match on Keys.CRM picks up all the seller-suffixed variants in one
  // pass. Exact-match would only catch the no-suffix rows (32/1000 in
  // the probe). The prefix is the project name, the rest is the seller.
  //
  // A project can also map to several comma-joined accounts (חבר → 3),
  // while other projects carry a comma INSIDE one name (הגדה → "HaGada
  // בני דן, תל אביב"). crmAccountCandidates returns both the full string
  // and each split part; a row matches if it prefixes ANY candidate.
  const targetPrefixes = crmAccountCandidates(crmAccount).map(norm);
  let leads = 0;
  let scheduledMeetings = 0; // תואמה פגישה
  let meetings = 0;          // פגישות (held)
  let contacted = 0;
  const byStatus = new Map<string, number>();
  const byObjection = new Map<string, number>();
  const bySource = new Map<string, number>();
  // Per-KPI source breakdowns — see the BMBY function for the rationale.
  const leadsBySource = new Map<string, number>();
  const contactedBySource = new Map<string, number>();
  const scheduledMeetingsBySource = new Map<string, number>();
  const meetingsBySource = new Map<string, number>();
  const dailySourceMatrix = new Map<
    string,
    Map<string, { leads: number; scheduledMeetings: number; meetings: number }>
  >();
  // Stale-leads tracking — see BMBY function for the rationale. Sehel
  // uses תאריך רישום as the entry date (the field where "first time
  // CRM saw this lead" is logged) and the "| <stage>" status format.
  let staleCount = 0;
  let staleOldestDays = 0;
  const staleByStage = new Map<string, number>();
  const staleThresholdMs = STALE_LEAD_DAYS * 86400_000;
  const nowMs = Date.now();
  const objectionSourceMatrix = new Map<string, Map<string, number>>();
  // Status × source — parallel to BMBY's matrix; powers per-stage source
  // segments in the funnel chart.
  const statusSourceMatrix = new Map<string, Map<string, number>>();
  let minDate = "";
  let maxDate = "";

  for (const row of rows) {
    const arr = row as unknown[];
    const proj = norm(arr[iProject]);
    // Match if the row's project prefixes ANY candidate account, with a
    // word boundary after the prefix (so "אורנבך 11" doesn't match
    // "אורנבך 111"). Each row is counted once however many it could match.
    if (
      !targetPrefixes.some(
        (t) => proj.startsWith(t) && (proj === t || proj[t.length] === " "),
      )
    )
      continue;

    // Stale-leads check — same model as BMBY. Sehel doesn't have a
    // dedicated "תאריך קשר" column; we use עדכון אחרון (last update)
    // as the contact-recency anchor, since any meaningful touch in
    // the salesperson UI bumps that timestamp.
    if (iRegDate >= 0) {
      const stRow = String(arr[iStage] ?? "").trim();
      if (stRow && SEHEL_EARLY_FUNNEL_STAGES.has(stRow)) {
        const dEntry = dateOnly(arr[iRegDate]);
        if (dEntry) {
          const entryMs = Date.parse(dEntry + "T00:00:00");
          if (!Number.isNaN(entryMs) && nowMs - entryMs > staleThresholdMs) {
            let lastTouchMs = entryMs;
            if (iUpdate >= 0) {
              const dUpdate = dateOnly(arr[iUpdate]);
              if (dUpdate) {
                const updateMs = Date.parse(dUpdate + "T00:00:00");
                if (!Number.isNaN(updateMs)) lastTouchMs = updateMs;
              }
            }
            if (nowMs - lastTouchMs > staleThresholdMs) {
              staleCount++;
              staleByStage.set(stRow, (staleByStage.get(stRow) || 0) + 1);
              const days = Math.floor((nowMs - lastTouchMs) / 86400_000);
              if (days > staleOldestDays) staleOldestDays = days;
            }
          }
        }
      }
    }

    // Date-window filter — applied against תאריך רישום, same field we
    // use for the displayed dateRange.
    if (window && iRegDate >= 0) {
      if (!rowInWindow(dateOnly(arr[iRegDate]), window)) continue;
    }
    leads++;
    const st = String(arr[iStage] ?? "").trim();
    // Sehel meeting metrics — best-guess interim pending Maayan's
    // clarification from upstream (2026-05-12). Sehel's stage taxonomy
    // observed in the new "מאגר שכל" tab uses "| <stage>" prefixed
    // values; the meeting-related ones (by frequency on the data
    // probe) are:
    //   1,931  "| פגישה ללא סיכום"  — held, awaiting summary
    //     396  "| אחרי פגישה"        — held, post-meeting
    //      65  "| לתאם פגישה מחדש"   — re-schedule (scheduled-only)
    //      52  "| לקראת פגישה"       — leading up to meeting (scheduled-only)
    //      27  "| פגישות"            — multiple meetings held (held)
    //
    // תואמה פגישה (scheduled) — anyone whose stage mentions a meeting,
    //   in either the singular (פגישה) or plural (פגישות) form, OR
    //   anyone with a meeting date set on the row (defensive — the
    //   salesperson might log the date without updating the stage label).
    //   Hebrew quirk: "פגישות" (plural) doesn't contain "פגישה" as a
    //   substring (the final ה changes to ות), so we test the shared
    //   stem `/פגיש/` instead of either word directly.
    // פגישות (held) — only the three observed post-meeting stages.
    //   Narrower than the previous shipping logic ("any meeting date
    //   set"), which actually captured scheduled + held together.
    const hasMeetingDate =
      iMeetingDate >= 0 && String(arr[iMeetingDate] ?? "").trim() !== "";
    const isScheduledMeeting = /פגיש/.test(st) || hasMeetingDate;
    const isHeldMeeting =
      st.includes("אחרי פגישה") ||
      st.includes("פגישה ללא סיכום") ||
      st.includes("פגישות");
    if (isScheduledMeeting) scheduledMeetings++;
    if (isHeldMeeting) meetings++;
    // "Contacted" proxy for Sehel: any update timestamp ≠ registration
    // timestamp implies someone touched the row.
    const reg = String(arr[iRegDate] ?? "").trim();
    const upd = iUpdate >= 0 ? String(arr[iUpdate] ?? "").trim() : "";
    const isContacted = upd !== "" && upd !== reg;
    if (isContacted) contacted++;
    if (st) byStatus.set(st, (byStatus.get(st) || 0) + 1);
    const obj = String(arr[iObjection] ?? "").trim();
    if (obj) byObjection.set(obj, (byObjection.get(obj) || 0) + 1);
    const src = normSource(arr[iSource]);
    if (src) {
      bySource.set(src, (bySource.get(src) || 0) + 1);
      leadsBySource.set(src, (leadsBySource.get(src) || 0) + 1);
      if (isContacted) contactedBySource.set(src, (contactedBySource.get(src) || 0) + 1);
      if (isScheduledMeeting) scheduledMeetingsBySource.set(src, (scheduledMeetingsBySource.get(src) || 0) + 1);
      if (isHeldMeeting) meetingsBySource.set(src, (meetingsBySource.get(src) || 0) + 1);
    }
    if (obj && src) {
      let m2 = objectionSourceMatrix.get(obj);
      if (!m2) { m2 = new Map<string, number>(); objectionSourceMatrix.set(obj, m2); }
      m2.set(src, (m2.get(src) || 0) + 1);
    }
    if (st && src) {
      let m3 = statusSourceMatrix.get(st);
      if (!m3) { m3 = new Map<string, number>(); statusSourceMatrix.set(st, m3); }
      m3.set(src, (m3.get(src) || 0) + 1);
    }
    const d = dateOnly(arr[iRegDate]);
    // Daily time series — same shape as BMBY. Rows without parseable
    // date or source are skipped (still counted in KPI totals above).
    if (d && src) {
      let perDay = dailySourceMatrix.get(d);
      if (!perDay) {
        perDay = new Map();
        dailySourceMatrix.set(d, perDay);
      }
      let bucket = perDay.get(src);
      if (!bucket) {
        bucket = { leads: 0, scheduledMeetings: 0, meetings: 0 };
        perDay.set(src, bucket);
      }
      bucket.leads++;
      if (isScheduledMeeting) bucket.scheduledMeetings++;
      if (isHeldMeeting) bucket.meetings++;
    }
    if (d) {
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
  }

  // Contracts (עסקה) — derived from the status matrix (no per-row loop
  // edit). Current-status snapshot.
  const contractsBySource = new Map<string, number>();
  let contracts = 0;
  for (const [stKey, cnt] of byStatus) {
    if (!/עסקה/.test(stKey)) continue;
    contracts += cnt;
    const m = statusSourceMatrix.get(stKey);
    if (m) for (const [s, c] of m) contractsBySource.set(s, (contractsBySource.get(s) || 0) + c);
  }

  if (leads === 0) return null;
  return {
    platform: "sehel",
    crmAccount,
    leads,
    contacted,
    scheduledMeetings,
    meetings,
    contracts,
    meetingRatePct: leads > 0 ? (meetings / leads) * 100 : null,
    topSellers: [], // Sehel doesn't carry a salesperson column we trust
    sourceMatrices: buildSourceMatrices({
      allSourcesMap: bySource,
      statusObserved: byStatus,
      funnelOrder: SEHEL_STATUS_FUNNEL_ORDER,
      leadsBySource, contactedBySource,
      scheduledMeetingsBySource, meetingsBySource,
      contractsBySource,
      statusSourceMatrix, objectionSourceMatrix,
    }),
    dailyTimeSeries: buildDailyTimeSeries(dailySourceMatrix),
    dateRange: { from: minDate, to: maxDate },
    staleLeads: {
      count: staleCount,
      oldestDays: staleOldestDays,
      byStage: [...staleByStage.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([stage, count]) => ({ stage, count })),
    },
    monthFilter: window?.kind === "month" ? window.month : "",
    windowLabel: window?.kind === "range" ? window.label : "",
  };
}

/* ── Salesforce funnel ─────────────────────────────────────────────── */

async function computeSalesforceFunnel(
  subjectEmail: string,
  crmAccount: string,
  window: DateWindow | null,
): Promise<CrmFunnel | null> {
  const { headers, rows } = await readSalesforce(subjectEmail);
  if (!rows.length) return null;
  // Project + creation-date headers carry a trailing "↑" sort glyph
  // ("פרויקט ↑" / "תאריך יצירה ↑") — match by prefix, not exact string.
  const iProject = headers.findIndex((h) => h.startsWith("פרויקט"));
  const iEntry = headers.findIndex((h) => h.startsWith("תאריך יצירה"));
  const iStatus = headers.indexOf("מצב ליד");
  const iSource = headers.indexOf("מקור ליד");
  const iObjection = headers.indexOf("התנגדות ראשית");
  if (iProject < 0) return null;

  // Exact match on פרויקט (like BMBY) — verified the two Keys.CRM
  // account names match the Salesforce פרויקט values exactly. Multiple
  // comma-joined accounts (or a comma that's part of one name, like
  // "בית צורי 22,24") are handled by crmAccountCandidates — match ANY.
  const targets = crmAccountCandidates(crmAccount).map(norm);
  let leads = 0;
  let scheduledMeetings = 0; // תואמה פגישה (נקבעה או בוטלה פגישה)
  let meetings = 0;          // פגישות (התבצעה פגישה — held)
  let contacted = 0;
  const byStatus = new Map<string, number>();
  const byObjection = new Map<string, number>();
  const bySource = new Map<string, number>();
  const leadsBySource = new Map<string, number>();
  const contactedBySource = new Map<string, number>();
  const scheduledMeetingsBySource = new Map<string, number>();
  const meetingsBySource = new Map<string, number>();
  // Stale-leads — anchored on תאריך יצירה only (no contact/update column
  // exists for Salesforce). Runs BEFORE the monthFilter bail so it sees
  // every project row, not just the filtered cohort.
  let staleCount = 0;
  let staleOldestDays = 0;
  const staleByStage = new Map<string, number>();
  const staleThresholdMs = STALE_LEAD_DAYS * 86400_000;
  const nowMs = Date.now();
  const dailySourceMatrix = new Map<
    string,
    Map<string, { leads: number; scheduledMeetings: number; meetings: number }>
  >();
  const objectionSourceMatrix = new Map<string, Map<string, number>>();
  const statusSourceMatrix = new Map<string, Map<string, number>>();
  let minDate = "";
  let maxDate = "";

  for (const row of rows) {
    const arr = row as unknown[];
    const proj = norm(arr[iProject]);
    if (!targets.includes(proj)) continue;

    // Stale-leads check — early-stage AND created >14d ago. Creation
    // date is the only available recency anchor (see the comment on
    // SALESFORCE_EARLY_FUNNEL_STAGES).
    if (iEntry >= 0) {
      const stRow = String(arr[iStatus] ?? "").trim();
      if (stRow && SALESFORCE_EARLY_FUNNEL_STAGES.has(stRow)) {
        const dEntry = dateOnly(arr[iEntry]);
        if (dEntry) {
          const entryMs = Date.parse(dEntry + "T00:00:00");
          if (!Number.isNaN(entryMs) && nowMs - entryMs > staleThresholdMs) {
            staleCount++;
            staleByStage.set(stRow, (staleByStage.get(stRow) || 0) + 1);
            const days = Math.floor((nowMs - entryMs) / 86400_000);
            if (days > staleOldestDays) staleOldestDays = days;
          }
        }
      }
    }

    // Date-window filter — applied against תאריך יצירה, same field as
    // dateRange.
    if (window && iEntry >= 0) {
      if (!rowInWindow(dateOnly(arr[iEntry]), window)) continue;
    }
    leads++;
    const st = String(arr[iStatus] ?? "").trim();
    // Funnel buckets per Maayan's status matrix (see the block above
    // SALESFORCE_STATUS_FUNNEL_ORDER). scheduledMeetings ⊇ meetings.
    const isScheduledMeeting = SALESFORCE_SCHEDULED_STATUSES.has(st);
    const isHeldMeeting = SALESFORCE_HELD_STATUSES.has(st);
    // contacted (נוצר קשר): any status past "חדש" (new/untouched).
    const isContacted = st !== "" && st !== "חדש";
    if (isScheduledMeeting) scheduledMeetings++;
    if (isHeldMeeting) meetings++;
    if (isContacted) contacted++;
    if (st) byStatus.set(st, (byStatus.get(st) || 0) + 1);
    const obj = String(arr[iObjection] ?? "").trim();
    if (obj) byObjection.set(obj, (byObjection.get(obj) || 0) + 1);
    const src = normSource(arr[iSource]);
    if (src) {
      bySource.set(src, (bySource.get(src) || 0) + 1);
      leadsBySource.set(src, (leadsBySource.get(src) || 0) + 1);
      if (isContacted) contactedBySource.set(src, (contactedBySource.get(src) || 0) + 1);
      if (isScheduledMeeting) scheduledMeetingsBySource.set(src, (scheduledMeetingsBySource.get(src) || 0) + 1);
      if (isHeldMeeting) meetingsBySource.set(src, (meetingsBySource.get(src) || 0) + 1);
    }
    if (obj && src) {
      let m2 = objectionSourceMatrix.get(obj);
      if (!m2) { m2 = new Map<string, number>(); objectionSourceMatrix.set(obj, m2); }
      m2.set(src, (m2.get(src) || 0) + 1);
    }
    if (st && src) {
      let m3 = statusSourceMatrix.get(st);
      if (!m3) { m3 = new Map<string, number>(); statusSourceMatrix.set(st, m3); }
      m3.set(src, (m3.get(src) || 0) + 1);
    }
    const d = dateOnly(arr[iEntry]);
    if (d && src) {
      let perDay = dailySourceMatrix.get(d);
      if (!perDay) { perDay = new Map(); dailySourceMatrix.set(d, perDay); }
      let bucket = perDay.get(src);
      if (!bucket) { bucket = { leads: 0, scheduledMeetings: 0, meetings: 0 }; perDay.set(src, bucket); }
      bucket.leads++;
      if (isScheduledMeeting) bucket.scheduledMeetings++;
      if (isHeldMeeting) bucket.meetings++;
    }
    if (d) {
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
  }

  // Contracts — for Salesforce the conversion goal is "טופס הרשמה" (lottery
  // registration), counted as the contract/sale terminal. From the status
  // matrix; current-status snapshot.
  const contractsBySource = new Map<string, number>();
  let contracts = byStatus.get("טופס הרשמה") || 0;
  {
    const m = statusSourceMatrix.get("טופס הרשמה");
    if (m) for (const [s, c] of m) contractsBySource.set(s, c);
  }

  if (leads === 0) return null;
  return {
    platform: "salesforce",
    crmAccount,
    leads,
    contacted,
    scheduledMeetings,
    meetings,
    contracts,
    meetingRatePct: leads > 0 ? (meetings / leads) * 100 : null,
    // Salesforce carries a בעלי ליד (owner) column, but we keep the
    // seller breakdown empty to match BMBY/Sehel's current behavior.
    topSellers: [],
    sourceMatrices: buildSourceMatrices({
      allSourcesMap: bySource,
      statusObserved: byStatus,
      funnelOrder: SALESFORCE_STATUS_FUNNEL_ORDER,
      leadsBySource, contactedBySource,
      scheduledMeetingsBySource, meetingsBySource,
      contractsBySource,
      statusSourceMatrix, objectionSourceMatrix,
    }),
    dailyTimeSeries: buildDailyTimeSeries(dailySourceMatrix),
    dateRange: { from: minDate, to: maxDate },
    staleLeads: {
      count: staleCount,
      oldestDays: staleOldestDays,
      byStage: [...staleByStage.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([stage, count]) => ({ stage, count })),
    },
    monthFilter: window?.kind === "month" ? window.month : "",
    windowLabel: window?.kind === "range" ? window.label : "",
  };
}

/**
 * Serialize the per-row aggregation Maps into the JSON-friendly
 * sourceMatrices payload. Everything stays in raw, untruncated form so
 * the client wrapper can re-aggregate every view against any chip
 * selection without losing precision. Sorts allSources desc by lead
 * count so chips render high-volume channels first.
 */
function buildSourceMatrices(args: {
  allSourcesMap: Map<string, number>;
  statusObserved: Map<string, number>;
  funnelOrder: readonly string[];
  leadsBySource: Map<string, number>;
  contactedBySource: Map<string, number>;
  scheduledMeetingsBySource: Map<string, number>;
  meetingsBySource: Map<string, number>;
  contractsBySource: Map<string, number>;
  statusSourceMatrix: Map<string, Map<string, number>>;
  objectionSourceMatrix: Map<string, Map<string, number>>;
}): CrmFunnel["sourceMatrices"] {
  const toRec = (m: Map<string, number>) => Object.fromEntries(m);
  const toRec2 = (m: Map<string, Map<string, number>>) =>
    Object.fromEntries([...m.entries()].map(([k, v]) => [k, Object.fromEntries(v)]));
  const allSources = [...args.allSourcesMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);
  // Intersection of the canonical funnel order with statuses seen in
  // this cohort, then append any observed statuses the canonical order
  // doesn't know about (sorted by count desc) so they still render.
  const observed = new Set([...args.statusObserved.keys()]);
  const ordered = args.funnelOrder.filter((s) => observed.has(s));
  const seen = new Set(ordered);
  const tail = [...args.statusObserved.entries()]
    .filter(([s]) => !seen.has(s))
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);
  return {
    allSources,
    statusFunnelOrder: [...ordered, ...tail],
    leadsBySource: toRec(args.leadsBySource),
    contactedBySource: toRec(args.contactedBySource),
    scheduledMeetingsBySource: toRec(args.scheduledMeetingsBySource),
    meetingsBySource: toRec(args.meetingsBySource),
    contractsBySource: toRec(args.contractsBySource),
    statusBySource: toRec2(args.statusSourceMatrix),
    objectionBySource: toRec2(args.objectionSourceMatrix),
  };
}

/* ── Cost attribution (ported from the anda "Monthly Channel Leads") ─── */

/** Friendly labels for the canonical cost-join channels. */
const COST_CHANNEL_LABELS: Record<string, string> = {
  "google-search": "Google",
  "google-discovery": "Google Discovery",
  facebook: "Facebook",
  tiktok: "TikTok",
  taboola: "Taboola",
  outbrain: "Outbrain",
  yad2: "yad2",
  madlan: "מדלן",
  onmap: "onMap",
  article: "כתבה",
};

/**
 * Cost-join canonicalizer: collapse a CRM `מקור הגעה` token OR an
 * ALL CLIENTS `מזהה BMBY` channel to the SAME paid-media key, so spend
 * (ALL CLIENTS) and leads (CRM source) join. Unlike crmAlerts'
 * canonicalChannel, ALL non-discovery Google (search / pmax / youtube /
 * gs) collapses to ONE "google-search" (GS) bucket — matching the anda
 * sheet's GS = Google cost EXCLUDING discovery. Returns null for
 * non-paid sources (phone / own-site / data / sales-office / personal),
 * which carry no media cost. Exported so CrmFunnelCard can key the
 * ALL CLIENTS spend the same way.
 */
export function canonicalMediaChannel(name: string): string | null {
  const n = String(name || "").toLowerCase().trim();
  if (!n) return null;
  if (/discover|דיסקוב|דיסקאב/.test(n)) return "google-discovery";
  if (/google|גוגל|goolge|\bgs\b|pmax|dv360|youtube|יוטיוב|\byt\b/.test(n))
    return "google-search";
  if (/facebook|פייסבוק|\bfb\b|meta|מטא|instagram|אינסטג|\big\b/.test(n))
    return "facebook";
  if (/tiktok|טיקטוק/.test(n)) return "tiktok";
  if (/taboola|טאבולה/.test(n)) return "taboola";
  if (/outbrain|אאוטבר|teads|טידס/.test(n)) return "outbrain";
  if (/yad\s?2|יד\s?2/.test(n)) return "yad2";
  if (/madlan|מדלן|נדלן/.test(n)) return "madlan";
  if (/onmap|אונמפ/.test(n)) return "onmap";
  if (/כתבה|article|ynet|walla|mako|globes|גלובס|הארץ|jerusalempost/.test(n))
    return "article";
  return null;
}

/**
 * Attribute per-channel media spend onto the funnel's CRM leads — the
 * anda "Monthly Channel Leads" model. For each canonical paid channel
 * with spend, sum the funnel's leads / scheduled / meetings over the
 * `מקור הגעה` sources whose tokens canonicalize to that channel (a
 * composite source like "facebook, google" counts toward BOTH), then
 * CPL = spend÷leads, CP-sched = spend÷scheduled, CP-meeting = spend÷
 * meetings. Also builds a per-raw-source map (atomic single-channel
 * sources only) for the inline chip cost. Mutates `funnel`.
 */
function attachChannelCosts(
  funnel: CrmFunnel,
  spendByChannel: Record<string, number>,
): void {
  const sm = funnel.sourceMatrices;
  const agg: Record<
    string,
    { leads: number; scheduled: number; meetings: number }
  > = {};
  const sourceChannels: Record<string, string[]> = {};
  for (const src of sm.allSources) {
    const chans = new Set<string>();
    for (const tok of src.split(",")) {
      const c = canonicalMediaChannel(tok);
      if (c) chans.add(c);
    }
    sourceChannels[src] = [...chans];
    for (const c of chans) {
      if (!agg[c]) agg[c] = { leads: 0, scheduled: 0, meetings: 0 };
      agg[c].leads += sm.leadsBySource[src] || 0;
      agg[c].scheduled += sm.scheduledMeetingsBySource[src] || 0;
      agg[c].meetings += sm.meetingsBySource[src] || 0;
    }
  }
  const channelCosts: NonNullable<CrmFunnel["channelCosts"]> = [];
  for (const [channel, spend] of Object.entries(spendByChannel)) {
    if (!(spend > 0)) continue;
    const a = agg[channel] || { leads: 0, scheduled: 0, meetings: 0 };
    channelCosts.push({
      channel,
      label: COST_CHANNEL_LABELS[channel] || channel,
      spend,
      leads: a.leads,
      scheduled: a.scheduled,
      meetings: a.meetings,
      cpl: a.leads > 0 ? spend / a.leads : 0,
      cps: a.scheduled > 0 ? spend / a.scheduled : 0,
      cpm: a.meetings > 0 ? spend / a.meetings : 0,
    });
  }
  channelCosts.sort((x, y) => y.spend - x.spend);
  funnel.channelCosts = channelCosts;
  const byChannel = new Map(channelCosts.map((c) => [c.channel, c]));
  const costBySource: NonNullable<CrmFunnel["costBySource"]> = {};
  for (const [src, chans] of Object.entries(sourceChannels)) {
    if (chans.length !== 1) continue; // atomic single-channel sources only
    const c = byChannel.get(chans[0]);
    if (c && c.spend > 0)
      costBySource[src] = { channel: c.channel, cpl: c.cpl, cpm: c.cpm };
  }
  funnel.costBySource = costBySource;
}

/* ── Public entry ──────────────────────────────────────────────────── */

/**
 * Returns the current calendar month in YYYY-MM, anchored to
 * Asia/Jerusalem to match the rest of the codebase (agenda, quietHours,
 * etc. all do the same so cross-references stay consistent). The
 * dashboard iframe's "live" mode defaults to current month too; this
 * function is what makes the CRM card mirror that default automatically.
 */
function currentMonthIL(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  return y && m ? `${y}-${m}` : "";
}

/**
 * Resolve and compute the CRM funnel for one project. Returns `null`
 * when:
 *   - Keys row for (company, project) has no `CRM` value (project
 *     isn't onboarded with a CRM mapping — e.g. כללי, ben-shemen-lod)
 *   - Keys row has no `CRM platform` value (e.g. צור יצחק — flagged
 *     but not active, the user will set it when the project starts)
 *   - the source tab has zero rows matching that CRM account (or the
 *     effective month filter has zero rows)
 *
 * Date-window resolution (highest priority first):
 *   1. explicit `monthFilter` "YYYY-MM" → that calendar month (the
 *      dashboard's month-rewind view; user explicitly picked a month).
 *   2. `projectWindow` {from,to} → the project's flight-date envelope
 *      (התחלה→סיום from ALL CLIENTS). This is the DEFAULT the CRM card
 *      passes, so the funnel matches the report header's date range
 *      instead of the bare calendar month.
 *   3. otherwise → current Asia/Jerusalem calendar month (back-compat
 *      default for callers that pass neither, e.g. the morning feed).
 *   `noFilter` overrides everything → all available rows.
 *
 * Rows are filtered against BMBY's תאריך כניסה / Sehel's תאריך רישום /
 * Salesforce's תאריך יצירה.
 *
 * Caller wraps in <Suspense fallback={null}>; null return collapses
 * the card cleanly.
 */
export async function getCrmFunnelForProject(args: {
  company: string;
  project: string;
  /** "YYYY-MM". When set, pins the cohort to that calendar month
   *  (the dashboard's month-rewind view). Takes priority over
   *  projectWindow. */
  monthFilter?: string;
  /** The project's flight-date envelope (ISO from/to). Used as the
   *  default window when no explicit `monthFilter` is set, so the CRM
   *  funnel matches the report header's date range. */
  projectWindow?: { from: string; to: string };
  /** Explicit escape hatch: set true to disable all date filtering and
   *  return all available rows (~60 days). Use for admin/debug
   *  surfaces; not exposed in the UI. */
  noFilter?: boolean;
  /** Per-channel media spend over the SAME window (canonical-channel
   *  keyed, e.g. from ALL CLIENTS via canonicalMediaChannel). When given,
   *  the funnel gets `channelCosts` + `costBySource` (cost/CPL/CP-meeting
   *  attributed to the CRM lead sources — the anda model). */
  spendByChannel?: Record<string, number>;
}): Promise<CrmFunnel | null> {
  const company = args.company.trim();
  const project = args.project.trim();
  const rawMonthFilter = (args.monthFilter || "").trim();
  // Validate format defensively — caller may pass URL search-param string.
  const explicitMonth = /^\d{4}-\d{2}$/.test(rawMonthFilter) ? rawMonthFilter : "";
  // Resolve the active date window (see the priority list in the doc).
  let window: DateWindow | null = null;
  if (!args.noFilter) {
    if (explicitMonth) {
      window = { kind: "month", month: explicitMonth, label: explicitMonth };
    } else if (args.projectWindow?.from && args.projectWindow?.to) {
      const { from, to } = args.projectWindow;
      window = { kind: "range", from, to, label: `${ddmmyyyy(from)}–${ddmmyyyy(to)}` };
    } else {
      const m = currentMonthIL();
      window = m ? { kind: "month", month: m, label: m } : null;
    }
  }
  if (!company || !project) return null;

  // Read Keys to find this project's CRM mapping. readKeysCached is
  // cross-request-cached + per-request-deduped, so this is ~free on a
  // warm path.
  const { headers, rows } = await readKeysCached(driveFolderOwner());
  const iProj = headers.indexOf("פרוייקט");
  const iCo = headers.indexOf("חברה");
  const iCrm = headers.indexOf("CRM");
  const iPlatform = headers.indexOf("CRM platform");
  if (iProj < 0 || iCrm < 0 || iPlatform < 0) return null;

  // Match (project, company) — the same disambiguation pattern other
  // multi-row-name surfaces use. כללי is the obvious case but any
  // future name collision is handled the same way.
  let crmAccount = "";
  let platform = "";
  for (const r of rows) {
    const rp = String((r as unknown[])[iProj] ?? "").trim();
    const rc = iCo >= 0 ? String((r as unknown[])[iCo] ?? "").trim() : "";
    if (rp !== project) continue;
    if (rc && company && rc !== company) continue;
    crmAccount = String((r as unknown[])[iCrm] ?? "").trim();
    platform = String((r as unknown[])[iPlatform] ?? "").trim().toLowerCase();
    break;
  }
  if (
    !crmAccount ||
    (platform !== "bmby" && platform !== "sehel" && platform !== "salesforce")
  ) {
    return null;
  }

  let funnel: CrmFunnel | null;
  if (platform === "bmby") {
    funnel = await computeBmbyFunnel(driveFolderOwner(), crmAccount, window);
    // Prefer the warehouse journey when it's flag-allowed for this project
    // AND at least as complete as the Sheet on lead count (kenko, נתיבות…
    // win; channel-scoped / dormant / not-onboarded projects fall back to
    // the Sheet, which stays the full-CRM safety net). Per-project,
    // per-window, automatic. Never throws to the caller.
    if (useSupabaseCrmEnrichment() && supabaseCrmProjectAllowed(crmAccount)) {
      try {
        const sheetFunnel = funnel;
        const wh = await computeBmbyFunnelFromWarehouse(crmAccount, window);
        if (wh && wh.leads > 0 && (!sheetFunnel || wh.leads >= sheetFunnel.leads)) {
          if (sheetFunnel) {
            // The warehouse funnel is window-scoped, but the stale-leads
            // alert (morning feed) needs project-wide / all-time coverage —
            // preserve the Sheet's stale tally (it scanned every row).
            wh.staleLeads = sheetFunnel.staleLeads;
            // Objections are barely populated in the warehouse leads view
            // (~4% of rows overall, 0% for many projects incl. kenko/נתיבות),
            // but the Sheet's התנגדויות column is rich — carry the Sheet's
            // objection breakdown over so the objections section keeps
            // working. (Source keys are the same fb/yad2/… family, so the
            // chip-filtered cross-tab still lines up for the common sources.)
            wh.sourceMatrices.objectionBySource =
              sheetFunnel.sourceMatrices.objectionBySource;
          }
          funnel = wh;
        }
      } catch {
        /* keep the Sheet funnel */
      }
    }
  } else if (platform === "salesforce") {
    funnel = await computeSalesforceFunnel(driveFolderOwner(), crmAccount, window);
  } else {
    funnel = await computeSehelFunnel(driveFolderOwner(), crmAccount, window);
  }
  // Attribute media cost onto the lead sources (anda model) when spend
  // was supplied for this window.
  if (funnel && args.spendByChannel && Object.keys(args.spendByChannel).length) {
    attachChannelCosts(funnel, args.spendByChannel);
  }
  // Additive Supabase enrichment (bmby only, flag-gated). Runs AFTER the
  // cost-join, inside try/catch, so a warehouse hiccup never touches the
  // base Sheet funnel. Bounds [from, toExcl) derived from the active
  // window; empty = no date filter. See lib/crmEnrichment.ts / plan §12.5.
  if (
    funnel &&
    platform === "bmby" &&
    funnel.dataSource !== "warehouse" &&
    useSupabaseCrmEnrichment() &&
    supabaseCrmProjectAllowed(crmAccount)
  ) {
    try {
      let from = "";
      let toExcl = "";
      if (window?.kind === "month") {
        from = `${window.month}-01`;
        const [y, mo] = window.month.split("-").map(Number);
        toExcl =
          mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
      } else if (window?.kind === "range") {
        from = window.from;
        const d = new Date(`${window.to}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        toExcl = d.toISOString().slice(0, 10);
      }
      funnel.supabaseEnrichment = await computeCrmEnrichment(crmAccount, from, toExcl);
    } catch {
      /* leave the base Sheet funnel intact */
    }
  }
  // Freshness note — does the data reach the (clamped) end of the selected
  // window? Computed at the single exit point so it covers every path
  // (sheet/warehouse/cost-joined) off the final funnel's own dateRange.
  if (funnel) {
    funnel.dataLagThrough = dataFreshnessLag(window, funnel.dateRange.to);
  }
  return funnel;
}
