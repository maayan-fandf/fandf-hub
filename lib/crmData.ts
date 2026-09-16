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
import {
  bmbyLeadSourceKey,
  buildBmbyWarehouseMeetings,
  fetchBmbyJourneyEvents,
  fetchBmbyLeadHistory,
  type BmbyHistoryLead,
  type BmbyJourneyEvent,
  type BmbyWarehouseMeetings,
  type MeetingDaily,
} from "./crmEnrichment";
import {
  bmbyEventCanceled,
  bmbyEventHeld,
  datedDay,
  dayInWindow,
  ilDayJerusalem,
  nextDay,
  sehelLeadEntryHeld,
  type DayWindow,
  type MeetingTally,
  type OwnerAssignment,
} from "./meetingBasis";
import {
  useSupabaseCrmEnrichment,
  useSupabaseSehelWarehouse,
  supabaseCrmProjectAllowed,
  supabaseConfigured,
  supabaseRowsAll,
  orPrefixFilter,
} from "./supabase";
import { fbAdSpendByCreative, normAdName } from "./fbCreatives";
import {
  readSalesforceUtmIndex,
  lookupSfUtm,
  type SfUtm,
  type SfUtmIndex,
} from "./salesforceUtm";

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

/**
 * One row of a UTM breakdown — a placement, an audience, a creative or a
 * keyword — with the funnel counts its leads produced.
 *
 * `objections` answers "which ad/adset/placement produced which objection":
 * the leads counted in THIS row, tallied by the objection their CRM record
 * carries, biggest first. Empty when none of the row's leads has one — which
 * is common, so the UI must treat absence as "not recorded" rather than
 * "no objections".
 *
 * Only the row's own LEADS are tallied, never the meetings credited to it:
 * a meeting is credited to the group of its client's first-touch lead, which
 * may sit outside the window, and counting an objection twice through both
 * paths would inflate rows that convert well.
 */
export type UtmRow = {
  label: string;
  leads: number;
  /** LEAD-ENTRY (lib/meetingBasis): BMBY — events whose OWNER lead was
   *  created in the window and carries this row's UTM; Sehel — the
   *  registration cohort by the client's UTM, held = "הלקוח הגיע לפגישה";
   *  Salesforce — lead rows by current stage. */
  scheduled: number;
  held: number;
  /** MEETING-DATE: events dated in the window, credited to the client's
   *  first-touch lead. undefined ⇒ no dated source (Salesforce) → "—". */
  datedScheduled?: number;
  datedHeld?: number;
  objections?: { label: string; n: number }[];
};

/**
 * The three per-source meeting maps, on ONE basis. The unprefixed maps on
 * `CrmFunnel.sourceMatrices` are this shape on the LEAD-ENTRY basis;
 * `sourceMatrices.dated` is the same shape on the MEETING-DATE basis. The
 * card sums them over the chip-selected sources exactly as it sums the lead
 * maps, so a dated tile under "all sources" equals Σ of its map.
 */
export type CrmMeetingSourceMaps = {
  /** source → תואמה (every event, cancelled included). */
  scheduledMeetingsBySource: Record<string, number>;
  /** source → פגישות (confirmed held). ⊆ scheduled. */
  meetingsBySource: Record<string, number>;
  /** source → בוטלו. ⊆ scheduled. Absent where the platform has no clean
   *  cancelled state. */
  canceledMeetingsBySource?: Record<string, number>;
};

/** MEETING-DATE maps, plus what only the dated side has. */
export type CrmDatedMeetingMaps = CrmMeetingSourceMaps & {
  /** BMBY only: dated events the journey view's `held` boolean marks held —
   *  confirmed PLUS status-inferred. Whole-window, not chip-filterable. The
   *  retired held strip's "כולל משוער", now a line in the פגישות tile's
   *  tooltip. Never a tile value. */
  estimatedHeld?: number;
};

/**
 * How a funnel's meeting maps were produced on each basis, so the card can
 * label what it shows. Set by every getCrmFunnelForProject route.
 */
export type CrmMeetingBasisInfo = {
  /** The unprefixed (lead-entry) maps:
   *   "owner-lead"          BMBY — warehouse route, and Sheet-routed BMBY
   *                         projects whose warehouse covers the window
   *                         (owner decision D3). Unit = events.
   *   "registration-cohort" Sehel warehouse route. Unit = events.
   *   "status-snapshot"     Sheet / Salesforce routes, and the D3 fallback.
   *                         Unit = LEADS by current status → the card wears
   *                         FIXED_BADGES.statusSnapshot / warehouseFallback. */
  lead: "owner-lead" | "registration-cohort" | "status-snapshot";
  /** `sourceMatrices.dated`'s source; null ⇒ no dated maps → "—".
   *   "journey-events" BMBY v_bmby_journey_meetings (both BMBY routes).
   *   "sehel-events"   sehel_meetings (both Sehel routes, where it exists). */
  dated: "journey-events" | "sehel-events" | null;
  /** D3 fallback: a windowed BMBY Sheet-routed card whose warehouse does
   *  not cover the window — no project_id, no journey, no warehouse lead in
   *  the window, or a lead feed ≥ 3 days behind the Sheet (crmData
   *  warehouseCoversWindow) — or with the warehouse flag off / unreachable.
   *  `lead` is then "status-snapshot" and `dated` null, and the card shows
   *  FIXED_BADGES.warehouseFallback. */
  warehouseFallback?: boolean;
};

/** One paid channel's cost row on the CRM card (see CrmFunnel.channelCosts). */
export type CrmChannelCost = {
  channel: string; // canonical key (google-search / facebook / yad2 …)
  label: string;
  spend: number;
  leads: number;
  scheduled: number;
  meetings: number;
  cpl: number; // spend ÷ leads
  cps: number; // spend ÷ scheduled (תואמה)
  cpm: number; // spend ÷ meetings (held)
};

/** raw `מקור הגעה` → its channel's CPL / CP-meeting (see CrmFunnel.costBySource). */
export type CrmSourceCost = { channel: string; cpl: number; cpm: number };

/** One day of the trendline on the MEETING-DATE basis: events by the day
 *  they are dated on (appointment_date || meeting_date). No leads — a lead
 *  has no meeting day. */
export type CrmDatedDailyPoint = {
  date: string; // YYYY-MM-DD
  bySource: {
    source: string;
    scheduledMeetings: number;
    meetings: number;
  }[];
};

export type CrmFunnel = {
  platform: CrmPlatform;
  /** Keys.CRM value used as the join key (the canonical account name
   *  on the external CRM side — surfaced for the badge so users can
   *  tell why a particular cohort was selected). */
  crmAccount: string;
  leads: number;
  contacted: number;
  /** "ניסיון תיאום פגישה" — leads a salesperson actively tried to book.
   *  CUMULATIVE: the status itself plus every stage past it, so
   *  `attemptedMeetings >= scheduledMeetings >= meetings` always holds.
   *  Counting the raw status alone would report fewer attempts than
   *  bookings, since a lead now reading "פגישה התקיימה" no longer reads
   *  "ניסיון תיאום פגישה" — the status column is a snapshot, not a log.
   *  Salesforce only (the status belongs to that CRM's vocabulary);
   *  absent elsewhere, and the card renders no tile when it is. */
  attemptedMeetings?: number;
  /** "תואמה פגישה" — leads where a meeting was scheduled at any point
   *  in the lifecycle, including upcoming meetings AND cancellations
   *  ("פגישה בוטלה" still counts as scheduled per Maayan's definition).
   *  Broader than `meetings` — always `scheduledMeetings >= meetings`.
   *  BMBY: status.includes("פגישה"). Sehel: status.includes("פגישה")
   *  OR a meeting date is set — best-guess equivalent pending upstream
   *  clarification. Salesforce: the SALESFORCE status matrix, which since
   *  2026-08-12 also counts "טופס הרשמה" — so there `scheduledMeetings`
   *  overlaps `contracts` by design rather than being disjoint from it.
   *
   *  This, `canceledMeetings` and `meetings` are LEAD-ENTRY totals (see
   *  `meetingBasis` for how each route counts them). There is deliberately
   *  no dated twin at this level: the dated tiles sum
   *  `sourceMatrices.dated`, as the lead tiles sum the lead maps. */
  scheduledMeetings: number;
  /** Of `scheduledMeetings`, the canceled subset ("פגישה בוטלה" / בוטלו).
   *  So תואמה = תואמו (non-canceled = held + upcoming) + בוטלו (this).
   *  Surfaced for the KPI card breakdown. Optional — BMBY populates it
   *  from the status, Salesforce from the "בוטלה" meeting status in
   *  מצב ליד 3. Sehel has no clean canceled state, so it stays absent. */
  canceledMeetings?: number;
  /** "פגישות" — meetings that actually took place (held). Subset of
   *  scheduledMeetings. BMBY: status matches "פגישה 1/2/3" or "פגישה
   *  התקיימה". Sehel: status in {אחרי פגישה, פגישה ללא סיכום} —
   *  the post-meeting stages, best-guess pending upstream answer.
   *  Salesforce: the "התקיימה" meeting status, or any opportunity stage
   *  past it (see the SALESFORCE status matrix). */
  meetings: number;
  /** "חוזים/עסקאות" — leads at the contract/sale terminal. A CURRENT-
   *  snapshot count (not dated), so windowed figures drift; it's
   *  independent of `meetings` (a held lead can also sign). BMBY: "חוזה";
   *  Sehel: "| עסקה"; Salesforce: the הומר conversion flag, surfaced as
   *  "טופסי הרשמה" (the דיור-למשתכן registration = the goal). 0 when none. */
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
    /** The subset of statusFunnelOrder that is NOT a linear funnel stage
     *  — side and terminal states (לא רלוונטי, סגור, מאגר…) plus any
     *  status the canonical order does not recognise. These must be
     *  excluded from the funnel's "at this stage or later" arithmetic:
     *  a lead sitting in לא רלוונטי has left the funnel, and where it
     *  got to before that is not recoverable from its status. */
    offFunnelStatuses: string[];
    /** source → lead count. Every counted row contributed once. */
    leadsBySource: Record<string, number>;
    /** source → contacted count. Subset of leadsBySource. */
    contactedBySource: Record<string, number>;
    /** source → attemptedMeetings (ניסיון תיאום פגישה, cumulative) count.
     *  SUPERSET of scheduledMeetingsBySource. Salesforce only. */
    attemptedMeetingsBySource?: Record<string, number>;
    /** source → scheduledMeetings (תואמה פגישה) count. LEAD-ENTRY, like
     *  the two meeting maps below — see `dated` and `CrmFunnel.meetingBasis`
     *  for the meeting-date side and how each was counted. */
    scheduledMeetingsBySource: Record<string, number>;
    /** source → cancelled-meeting (בוטלו) count. Subset of
     *  scheduledMeetingsBySource; BMBY only (empty/absent elsewhere).
     *  Lets the card split תואמה into תואמו + בוטלו under chip filtering. */
    canceledMeetingsBySource?: Record<string, number>;
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
    /**
     * The meeting maps on the MEETING-DATE basis (lib/meetingBasis). The
     * unprefixed scheduled/meetings/canceled maps above are LEAD-ENTRY.
     * Same event set as the ערוצים dated columns (BMBY: journey events with
     * appointment_date||meeting_date in the window), grouped by
     * normSource(first_lid_source) with the first lead's media_source_clean
     * as fallback, so Σ over all sources = ProjectReportData.datedTotals.
     * undefined ⇒ no dated source (Salesforce, the D3 fallback) → the
     * meeting tiles render "—" under the dated basis.
     */
    dated?: CrmDatedMeetingMaps;
  };
  /** How the meeting maps were produced, per basis — drives the card's
   *  basis labels. Absent on funnels built before the routes set it. */
  meetingBasis?: CrmMeetingBasisInfo;
  /**
   * True when `objectionBySource` was NOT tallied off the same rows that
   * produced `leadsBySource` — currently only the BMBY warehouse path,
   * which grafts the Sheet's objection breakdown onto warehouse leads
   * (see the transplant below). Both are scoped to the same window, and
   * the graft only happens when the warehouse has at least as many leads
   * as the Sheet, so the objection count can never exceed the lead count
   * — but the two are different row sets, so "N of the M leads carry an
   * objection" is not a statement the data supports there.
   *
   * The card uses this to decide whether it may show the objection tally
   * as a share OF the leads or only as a bare count. Absent/false means
   * one loop produced both and the subset relation is structural.
   */
  objectionsGrafted?: boolean;
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
  /** Leads per calendar day WITHOUT the source requirement the series above
   *  applies — every in-window row with a parseable date. A day whose only
   *  leads lack a מקור הגעה has no bar in the series, but it is not a day
   *  without leads; the budget desk's zero-day test (lib/crmDailyForBudgets)
   *  reads this so it does not paint such a day red. The project page does
   *  not read it. */
  dailyLeadTotals?: Record<string, number>;
  /** The trendline's תיאומים / פגישות on the MEETING-DATE basis: events by
   *  the day they are dated on, per source, same sources as
   *  `sourceMatrices.dated`. `dailyTimeSeries` above stays LEAD-ENTRY (by
   *  lead day) and keeps feeding the leads line under both bases. Sorted
   *  ascending. undefined ⇒ no dated source (Sheet-only / Salesforce) → the
   *  meeting lines render "—" under dated. */
  dailyDated?: CrmDatedDailyPoint[];
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
  /** The resolved window as plain ISO dates, whichever branch set it —
   *  month, explicit range, or the current-month default. Exposed because
   *  callers that read a SECOND source for the same card (מקור מול טריגר)
   *  must window it identically; re-deriving the priority order at the call
   *  site is how two blocks in one card end up describing two months. */
  windowFrom: string;
  windowTo: string;
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
  channelCosts?: CrmChannelCost[];
  /** raw `מקור הגעה` → its channel's CPL/CP-meeting, ONLY for sources
   *  that map 1:1 to a single paid channel — drives the inline cost on
   *  the source chips. Composite / non-paid sources are omitted. */
  costBySource?: Record<string, CrmSourceCost>;
  /** `channelCosts` / `costBySource` with scheduled / meetings / cps / cpm
   *  taken from `sourceMatrices.dated` instead of the lead-entry maps. The
   *  plain pair above is LEAD-ENTRY. spend, leads and cpl are identical in
   *  both (basis-free). undefined ⇒ no dated maps → "—" in the meeting
   *  columns under dated. */
  channelCostsDated?: CrmChannelCost[];
  costBySourceDated?: Record<string, CrmSourceCost>;
  /** Which backend produced this funnel's LEADS: "sheet" (the ארכיון Google
   *  Sheet — the default / fallback) or "warehouse" (the Supabase BMBY
   *  journey, used for flag-allowed bmby projects when it's at least as
   *  complete as the Sheet on lead count). Drives the small source badge;
   *  absent ⇒ "sheet". A "sheet" BMBY card can still count its MEETINGS from
   *  the warehouse (owner decision D3) — `meetingBasis` says which. (The
   *  `supabaseEnrichment` held strip that used to sit beside a Sheet card
   *  went away 2026-09-16; its numbers are the dated tiles.) */
  dataSource?: "sheet" | "warehouse";
  /** Facebook/Meta UTM drill (warehouse-sourced funnels only) — how the
   *  Meta leads (channel_key='fb' = fb+ig+an) split by ad placement
   *  (utm_medium), audience (utm_term) and creative (utm_content). Counts
   *  lead rows; top-8 per dimension + "אחר". Absent when the project has no
   *  Meta leads or the funnel is Sheet-sourced (UTM lives only in the
   *  warehouse) — except a Sheet-routed BMBY card that took the warehouse's
   *  meeting maps (D3), which takes this drill with them, leads column
   *  included (the warehouse's fb leads). Per-segment CPL is a later slice
   *  (needs the meta_* join). */
  fbBreakdown?: {
    totalLeads: number;
    /** Rows carry both bases (UtmRow.scheduled/held = lead-entry,
     *  datedScheduled/datedHeld = meeting-date). The top-8 cut ranks by
     *  leads + max(lead scheduled, dated scheduled), so a row never moves
     *  when the switch flips. */
    byPlacement: UtmRow[];
    byAudience: UtmRow[];
    /** Per creative (= ad name / utm_content). leads/scheduled/held from the
     *  warehouse; spend + cpl/cps/cpm joined from the dashboard's
     *  facebook-ads-metrics Sheet (cost ÷ leads / scheduled / held). spend=0
     *  when no matching ad-spend row (cost metrics then 0). */
    byCreative: (UtmRow & {
      spend: number;
      cpl: number;
      /** spend ÷ scheduled / held — LEAD-ENTRY. */
      cps: number;
      cpm: number;
      /** spend ÷ datedScheduled / datedHeld. undefined with them. */
      datedCps?: number;
      datedCpm?: number;
    })[];
    /** Per Google keyword (utm_term on google-source leads) — leads/scheduled/
     *  held only (no spend join). Set by the Sehel warehouse funnel; absent on
     *  BMBY (whose keyword drill lives only in the classic report). */
    byKeyword?: UtmRow[];
    /** Meta meetings no placement / audience / creative row could take: the
     *  fb lead they are credited to (OWNER lead on lead-entry, FIRST lead on
     *  meeting-date) carried no usable UTM. Σ audiences + untagged = the
     *  ערוצים facebook row on each basis. A side is undefined when that
     *  basis has no source. INTERNAL ONLY (.rpt-basis-untagged). */
    untagged?: {
      lead?: { scheduled: number; held: number };
      dated?: { scheduled: number; held: number };
    };
  };
  /** Speed-to-lead (warehouse BMBY funnels only): response time from lead
   *  arrival to the first desk touch, per media channel, measured as
   *  `handled_at − lead_created_at`.
   *
   *  NOT `v_bmby_leads_bucketed.response_seconds`, which this used to read
   *  and which cannot express the answer: it is time-of-day arithmetic
   *  upstream, so it wraps every 24h. The highest value in the entire
   *  44k-row view is 86,396 seconds — four seconds short of a day — while
   *  36% of real waits are longer than one. Every lead answered the next
   *  morning came back as a fast reply. Measured across the twelve busiest
   *  projects on 2026-09-06: the median it reported ran 2.5–4x below the
   *  real one (דרימס ארנונה 3.2h vs 18.3h, נתיבות 7.1h vs 21.9h), and 1,245
   *  of 9,750 rows differed from the true wait by an exact multiple of 24h,
   *  which is the wrap itself and not a second opinion about the event.
   *
   *  Rows with no `handled_at` are skipped rather than counted as zero — a
   *  lead nobody has answered has no wait yet. That is the second reason
   *  the old column had to go and not merely a consequence of dropping it:
   *  `response_seconds` was populated on 100% of rows, including the 1,575
   *  leads that carry no `handled_at` at all, and for those it reports a
   *  median of ONE SECOND with 39% at exactly zero. Every lead the desk
   *  never answered was counted as answered instantly. Both faults push the
   *  same way, which is why the figure on screen was so flattering.
   *
   *  The switch therefore measures 43,502 leads where the old one claimed
   *  45,077 — 3.5% fewer, all of them leads with nothing to measure. The
   *  median is kept
   *  (not the mean) because the tail is genuinely long now that it is
   *  allowed to be, and a handful of rows with broken upstream timestamps
   *  would otherwise move it. Whole-window (NOT chip-filtered, like the
   *  held strip). Absent on Sheet/Sehel/Salesforce funnels — they carry no
   *  per-lead response timing. `bySource` keys are normSource'd, so they
   *  share the section's source→color palette. */
  speedToLead?: {
    overall: SpeedStat;
    bySource: Record<string, SpeedStat>;
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
   *  count). The meeting is dated by appointment_date (when it happened),
   *  falling back to meeting_date (when it was booked). Whole-window. */
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
  // sheetsClient's read methods (.values.get/.batchGet) transient-retry
  // internally now (lib/sa.ts), so this huge-tab read survives a Sheets
  // 429 / 5xx / dropped socket instead of blanking the whole CRM card.
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
// שיכון ובינוי projects use it — a mirror of the client's own SHBNCRM
// tab, rolling ~3 months). Header is row 1. NOTE: the project and
// creation-date headers carry a literal "↑" sort glyph ("פרויקט ↑" /
// "תאריך יצירה ↑"), so those columns are matched by prefix, not exact
// string, in computeSalesforceFunnel.
//
// Range widened P→T on 2026-08-11: the upstream tab grew three columns
// past P — `מצב ליד2` (Q), `הזדמנות ID` (R) and `מצב ליד 3` (S) — and
// A:P silently truncated all of them, so the funnel kept reading the
// COARSEST status column while the resolved ones sat just out of range.
// See the SALESFORCE_STATUS_COLUMNS block for what each one means.
const readSalesforce = cache((subjectEmail: string) =>
  fetchTabFromSheet(subjectEmail, "Salesforce!A:T"),
);

/**
 * The newest lead DAY one CRM feed holds, whatever project it belongs to —
 * the point up to which a day with no leads is provably a zero day
 * (lib/crmDailyShared lastReportedDay). `source` is "sheet" or "warehouse",
 * as a funnel's `dataSource` names it; Salesforce is sheet-only.
 *
 * "sheet" is read off the tabs above — cache()d, so free inside a render
 * that already computed a funnel, and read as driveFolderOwner() exactly as
 * getCrmFunnelForProject does so the cache actually hits. "warehouse" is one
 * newest-row query. The whole function is cache()d too, so a project page's
 * several CRM cards ask once.
 *
 * Why the FEED and not the projects: taking it from the budget desk's own
 * projects made a feed with a single routed project (the BMBY sheet →
 * נרקיסים, 2026-09-10) exactly as fresh as that project's last lead, so its
 * trailing empty days drew grey instead of red — found in review.
 *
 * Never throws; "" when the feed cannot be read, and callers fall back to
 * their own evidence. Days after today (IL) are ignored, so a typo'd future
 * date cannot push the horizon forward.
 */
export const getCrmFeedNewestDay = cache(
  async (platform: string, source: string): Promise<string> => {
    const today = todayIsoIL();
    const owner = driveFolderOwner();
    const valid = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today ? d : "");
    const newestIn = (tab: RawTab, match: (h: string) => boolean): string => {
      const i = tab.headers.findIndex(match);
      if (i < 0) return "";
      let best = "";
      for (const r of tab.rows) {
        const d = valid(dateOnly((r as unknown[])[i]));
        if (d > best) best = d;
      }
      return best;
    };
    try {
      switch (`${platform}:${source || "sheet"}`) {
        case "bmby:sheet":
          return newestIn(await readBmby(owner), (h) => h === "תאריך כניסה");
        case "sehel:sheet":
          return newestIn(await readSehel(owner), (h) => h === "תאריך רישום");
        case "salesforce:sheet":
          return newestIn(await readSalesforce(owner), (h) => h.startsWith("תאריך יצירה"));
        case "bmby:warehouse": {
          if (!supabaseConfigured()) return "";
          // Same +03:00 / ilDay convention as the BMBY funnel query.
          const r = await supabaseRowsAll<{ lead_created_at: string | null }>(
            `v_bmby_leads_bucketed?select=lead_created_at` +
              `&lead_created_at=lte.${today}T23:59:59%2B03:00` +
              `&order=lead_created_at.desc&limit=1`,
          );
          return valid(ilDay(r[0]?.lead_created_at));
        }
        case "sehel:warehouse": {
          if (!supabaseConfigured()) return "";
          // Sehel wall-clock is tagged +00:00; the day is the date part.
          const r = await supabaseRowsAll<{ registered_at: string | null }>(
            `sehel_leads_daily?select=registered_at` +
              `&registered_at=lte.${today}T23:59:59%2B00:00` +
              `&order=registered_at.desc&limit=1`,
          );
          return valid(String(r[0]?.registered_at ?? "").slice(0, 10));
        }
        default:
          return "";
      }
    } catch {
      return "";
    }
  },
);

const CRM_FEEDS = [
  ["bmby", "sheet"],
  ["sehel", "sheet"],
  ["salesforce", "sheet"],
  ["bmby", "warehouse"],
  ["sehel", "warehouse"],
] as const;

/** Every feed's newest day, keyed `${platform}:${source}` (lib/crmDailyShared
 *  horizonKey) — for the budget desk, which spans all of them. A feed that
 *  cannot be read is simply absent. */
export async function getCrmFeedNewestDays(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    CRM_FEEDS.map(async ([platform, source]) => {
      const d = await getCrmFeedNewestDay(platform, source);
      if (d) out[`${platform}:${source}`] = d;
    }),
  );
  return out;
}

/* ── Utility ────────────────────────────────────────────────────────── */

function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Sheet boolean. UNFORMATTED_VALUE hands back a real boolean for a checkbox
 *  cell but the literal text "TRUE" for a plain string one, and the Salesforce
 *  export writes the latter — accept both (plus 1 / כן) rather than guessing. */
function isTruthyFlag(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "כן";
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
export function crmAccountCandidates(raw: string): string[] {
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

/** One channel's response-time summary. Shares/counts rather than a mean:
 *  the tail is long and a few broken upstream timestamps sit in it. */
type SpeedStat = {
  medianSec: number;
  n: number;
  under60: number;
  under300: number;
  under3600: number;
};

/** Per-channel speed-to-lead: seconds from the lead arriving to the first
 *  desk touch, measured off the two timestamps rather than the wrapped
 *  `response_seconds` column (see the CrmFunnel field doc for the
 *  measurements that retired it). Keyed by normSource so it lines up with
 *  the funnel's source palette. A lead with no `handled_at` is skipped —
 *  it has not been answered, which is not the same as a zero wait — as is
 *  a negative gap, which can only be a bad upstream timestamp. Zeros are
 *  kept: an instant or manual entry legitimately has none. Returns
 *  undefined when nothing usable, and the caller then leaves `speedToLead`
 *  unset so the panel hides rather than showing an empty table. */
function computeSpeedToLead(
  leads: {
    media_source_clean: string | null;
    lead_created_at: string | null;
    handled_at: string | null;
  }[],
): CrmFunnel["speedToLead"] {
  const bySrc = new Map<string, number[]>();
  const all: number[] = [];
  for (const l of leads) {
    if (!l.lead_created_at || !l.handled_at) continue;
    const created = Date.parse(l.lead_created_at);
    const handled = Date.parse(l.handled_at);
    if (!Number.isFinite(created) || !Number.isFinite(handled)) continue;
    const rs = (handled - created) / 1000;
    if (!Number.isFinite(rs) || rs < 0) continue;
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
    // The hour bucket exists because the minute buckets stopped being
    // informative once the number was allowed past 24h: on לוריא they read
    // 0.3% and 2.8%, which tells a reader nothing about whether the desk is
    // answering at all. 13% within the hour does.
    under3600: a.filter((x) => x < 3600).length,
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
  meetings: readonly {
    client_id: string | number | null;
    appointment_outcome: string | null;
    meeting_date: string | null;
    appointment_date: string | null;
  }[],
): CrmFunnel["journeyVelocity"] {
  const DAY = 86400000;
  const heldByClient = new Map<string, number[]>();
  for (const m of meetings) {
    // When the meeting happened; meeting_date is when it was BOOKED and is
    // only the fallback (the meetingInWindow rule). On the booking date this
    // measured lead → booking: August 2026 medians of 0 days instead of 4 on
    // באר יעקב מערב, 2 instead of 5 on נתיבות.
    const when = m.appointment_date || m.meeting_date;
    if (m.appointment_outcome !== "held" || !when) continue;
    const c = String(m.client_id ?? "");
    if (!c) continue;
    const ms = Date.parse(when);
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
/**
 * The off-funnel states are split into their own array rather than just
 * trailing the linear ones behind a comment, because the funnel chart
 * has to be able to TELL THEM APART at runtime, not just order them.
 *
 * It builds each stage's "at this stage or later" figure by summing the
 * counts below it, which is only valid down a linear funnel. With the
 * side states merged into one array they were summed too, so every
 * disqualified lead was credited with having reached every stage above
 * it: Essence showed 46 leads at "ניסיון תיאום פגישה or beyond" when 32
 * of those were "לא רלוונטי" and only 2 ever scheduled a meeting.
 */
const BMBY_LINEAR_STATUSES = [
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
];

/** Side and terminal states — a lead here has left the linear funnel,
 *  and its position in it is no longer knowable from its status. */
export const BMBY_OFF_FUNNEL_STATUSES = [
  "פגישה בוטלה",
  "מאגר",
  "תעסוקה",
  "מסחר קטן",
  "הרשמה",
  "לא רלוונטי",
];

export const BMBY_STATUS_FUNNEL_ORDER = [
  ...BMBY_LINEAR_STATUSES,
  ...BMBY_OFF_FUNNEL_STATUSES,
];

const SEHEL_LINEAR_STATUSES = [
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
];

export const SEHEL_OFF_FUNNEL_STATUSES = ["| הרשמה"];

export const SEHEL_STATUS_FUNNEL_ORDER = [
  ...SEHEL_LINEAR_STATUSES,
  ...SEHEL_OFF_FUNNEL_STATUSES,
];

/**
 * Salesforce — F&F's third CRM. Unlike BMBY/Sehel (where the meeting metrics
 * are inferred from free-text status taxonomies), Salesforce's funnel is
 * defined explicitly by the owner's status→bucket matrix.
 *
 * ⚠️ MATRIX REWRITTEN 2026-08-11 for שיכון ובינוי's three-stage taxonomy
 * (supersedes the 2026-07-13 one). Salesforce splits a lead's life across a
 * LEAD stage, an OPPORTUNITY stage and — inside the opportunity — a MEETING
 * status, and the tab now carries three progressively-resolved views of the
 * same lead side by side:
 *
 *   מצב ליד    (I) — raw LEAD stage. Every CONVERTED lead collapses to the
 *                    single value "טופס הרשמה" (the lead-side label for
 *                    הומר), so opportunities and meetings are invisible here.
 *   מצב ליד2   (Q) — converted leads resolve to their OPPORTUNITY stage
 *                    (תיאום פגישה / פגישה התקיימה / נסגר בהפסד / …).
 *   מצב ליד 3  (S) — as Q, but an opportunity that has a MEETING row shows
 *                    that meeting's own status instead.
 *
 * We read the most-resolved column present and fall back leftwards, because
 * the archive mirror gains each new column a sync behind the client's tab.
 *
 *   ┌─ שלב הליד ─────────────────┐   ליד  תיאום  בוצע  בוטלה
 *   │ חדש                        │    ✓
 *   │ ניסיון יצירת קשר            │    ✓
 *   │ ניסיון תיאום פגישה          │    ✓                       ← attempt only
 *   │ לא רלוונטי                  │    ✓
 *   │ הומר ⇢ "טופס הרשמה"         │    ✓     ✓                 ← a booking, per
 *   └────────────────────────────┘                              the 2026-08-12
 *                                                               amendment below
 *   ┌─ שלב ההזדמנות ─────────────┐
 *   │ תיאום פגישה                 │    ✓     ✓
 *   │ פגישה התקיימה               │    ✓     ✓     ✓
 *   │ ממתין לחתימת לקוח            │    ✓     ✓     ✓
 *   │ תהליך אישור מכירות           │    ✓     ✓     ✓
 *   │ בקשת רכישה                  │    ✓     ✓     ✓
 *   │ חוזה בחתימה                 │    ✓     ✓     ✓
 *   │ סגור / נסגר בהפסד            │    ✓     ✓           ← see note below
 *   └────────────────────────────┘
 *   ┌─ סטטוס פגישה (מצב ליד 3) ───┐
 *   │ טרם התקיימה                 │    ✓     ✓
 *   │ התקיימה                     │    ✓     ✓     ✓
 *   │ בוטלה                       │    ✓     ✓            ✓
 *   └────────────────────────────┘
 *
 * ⚠️ AMENDED 2026-08-12 (Maayan, relaying the client): `טופס הרשמה` counts
 * toward תיאום after all. For דיור-למשתכן the registration IS the booking the
 * campaign is buying, and the client reports it inside תואמה — so the hub
 * matches. It stays OUT of בוצע (nothing was held) and still drives
 * `contracts` independently, which means the תואמה and טופסי הרשמה tiles now
 * deliberately overlap. This knowingly reverses the first bullet below; it is
 * not a regression, don't "fix" it back. On the 2026-08-12 snapshot: Essence
 * 10 → 55, חולון 33 → 121, דרך השלום 16 → 83, אור יהודה 111 → 358.
 *
 * Three corrections over the old matrix, all of which skewed the funnel:
 *   • `טופס הרשמה` counted as תיאום → lottery registrations were reported as
 *     booked meetings. On the 2026-08-11 snapshot that alone inflated
 *     scheduled ~4-5× across the SHBN projects (חולון 121 → 33, Essence
 *     55 → 10, דרך השלום 82 → 16).  ⟵ REVERSED by the amendment above.
 *   • `נסגר בהפסד` counted as בוצע → a closed-lost opportunity was reported
 *     as a HELD meeting. Under מצב ליד 3, 132 of its 135 rows resolve to
 *     בוטלה (the meeting was CANCELLED) and just 1 to התקיימה.
 *   • Meetings were invisible altogether, because column I never shows them.
 *
 * `סגור`/`נסגר בהפסד` stays in תיאום but leaves בוצע. An opportunity can
 * close at any stage, but 133 of the 135 on the snapshot did have a meeting
 * row — and under מצב ליד 3 those already resolve to בוטלה/התקיימה, leaving
 * 2 rows where the choice is immaterial. That is what makes the מצב ליד2
 * fallback near-lossless: scheduled 255 under either column, held 54 vs 55.
 *
 * held ⊆ scheduled and cancelled ⊆ scheduled, so the funnel stays monotonic.
 * `contacted` (נוצר קשר) isn't a matrix bucket; it's derived as "any status
 * past חדש" — a salesperson has worked the lead — mirroring BMBY's notion.
 * `contracts` is no longer read off the status at all: it comes from the
 * הומר flag, the one field that survives the column resolution (see
 * computeSalesforceFunnel).
 */

/** Status columns, most-resolved first. `fetchTabFromSheet` collapses runs of
 *  whitespace in headers, so "מצב ליד 3" keeps its single space; the un-spaced
 *  spelling is accepted too since the client writes the header both ways. */
const SALESFORCE_STATUS_COLUMNS = [
  "מצב ליד 3",
  "מצב ליד3",
  "מצב ליד2",
  "מצב ליד",
];

/** Index of the most-resolved status column present, or -1 for none. */
function salesforceStatusIndex(headers: string[]): number {
  for (const name of SALESFORCE_STATUS_COLUMNS) {
    const i = headers.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
}

/** Opportunity stages at or past "meeting held" — reaching one of them means
 *  the meeting took place, even when no meeting row resolved into מצב ליד 3. */
const SALESFORCE_POST_MEETING_STAGES = [
  "פגישה התקיימה",
  "ממתין לחתימת לקוח",
  "תהליך אישור מכירות",
  "בקשת רכישה",
  "חוזה בחתימה",
];

const SALESFORCE_HELD_STATUSES = new Set<string>([
  "התקיימה",
  ...SALESFORCE_POST_MEETING_STAGES,
]);
/** Cancelled subset of scheduled — surfaces as "בוטלו" on the תואמה tile. */
const SALESFORCE_CANCELED_STATUSES = new Set<string>(["בוטלה"]);
const SALESFORCE_SCHEDULED_STATUSES = new Set<string>([
  // The דיור-למשתכן registration — the client's own definition of a booking
  // (2026-08-12 amendment). Under מצב ליד 3 only converted leads that never
  // reached an opportunity still read this; the ones that did are already
  // scheduled via their opportunity status, so each conversion is counted
  // exactly once. Verified on the 2026-08-12 snapshot: every הומר row outside
  // the scheduled set carries precisely this status, none carries another.
  "טופס הרשמה",
  "טרם התקיימה",
  "תיאום פגישה",
  "סגור",
  "נסגר בהפסד",
  ...SALESFORCE_CANCELED_STATUSES,
  ...SALESFORCE_HELD_STATUSES,
]);

/**
 * "ניסיון תיאום פגישה" and everything downstream of it — the stage where
 * a salesperson has started chasing a booking, whether or not one landed.
 *
 * Built as a SUPERSET of SCHEDULED rather than as the bare status, because
 * מצב ליד is a snapshot: a lead that got as far as "פגישה התקיימה" no
 * longer reads "ניסיון תיאום פגישה" anywhere. Counting the raw status
 * would then report fewer attempts than bookings and invert the funnel.
 * Deriving it from SCHEDULED (rather than by index into
 * SALESFORCE_LINEAR_STATUSES) also keeps the off-funnel-but-scheduled
 * statuses — סגור / נסגר בהפסד, which only occur post-opportunity — on the
 * right side of the inequality.
 *
 * Essence 08/2026: 19 sitting at the status + 2 further along = 21.
 */
const SALESFORCE_ATTEMPTED_STATUSES = new Set<string>([
  "ניסיון תיאום פגישה",
  ...SALESFORCE_SCHEDULED_STATUSES,
]);

const SALESFORCE_LINEAR_STATUSES = [
  // שלב הליד
  "חדש",
  "ניסיון יצירת קשר",
  "אין מענה",
  "שיחה",
  "ניסיון תיאום פגישה",
  "טופס הרשמה", // = הומר — the conversion out of the lead stage
  // שלב ההזדמנות, then the meeting status that supersedes it in מצב ליד 3
  "תיאום פגישה",
  "טרם התקיימה",
  "התקיימה",
  "בוטלה",
  "פגישה התקיימה",
  "ממתין לחתימת לקוח",
  "תהליך אישור מכירות",
  "בקשת רכישה",
  "חוזה בחתימה",
];

/** See BMBY_OFF_FUNNEL_STATUSES — these must stay OUT of the funnel's
 *  cumulative. "לא רלוונטי" alone was 32 of Essence's 65 leads. */
export const SALESFORCE_OFF_FUNNEL_STATUSES = [
  "סגור",
  "נסגר בהפסד",
  "ליד חוזר",
  "לא רלוונטי",
];

export const SALESFORCE_STATUS_FUNNEL_ORDER = [
  ...SALESFORCE_LINEAR_STATUSES,
  ...SALESFORCE_OFF_FUNNEL_STATUSES,
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
/** The active window as plain ISO dates. One helper for all three funnel
 *  builders so bmby / sehel / salesforce cannot disagree about what "this
 *  window" means, and so a second reader on the same card (מקור מול טריגר)
 *  can be handed the same two dates instead of re-deriving the priority
 *  order at the call site. */
function windowIso(window: DateWindow | null): { from: string; to: string } {
  if (!window) return { from: "", to: "" };
  return window.kind === "month"
    ? { from: `${window.month}-01`, to: lastDayOfMonthIso(window.month) }
    : { from: window.from, to: window.to };
}

/** The active window as a half-open [from, toExcl) day window — the shape
 *  every lib/meetingBasis rule takes. */
function dayWindowOf(window: DateWindow): DayWindow {
  const { from, to } = windowIso(window);
  return { from, toExcl: nextDay(to) };
}

/**
 * Midnight of `day` in Asia/Jerusalem as a PostgREST timestamptz literal
 * ("2026-12-01T00:00:00%2B02:00"), for bounding lead_created_at.
 *
 * The warehouse lead window used a fixed +03:00, right only in summer: in
 * winter it cut each month an hour early, so a lead created 23:00–24:00
 * Israel time on the last day fell out of its month. The meeting maps now
 * bucket a lead by lib/meetingBasis ilDayJerusalem, and the leads the card
 * counts have to be cut on the same calendar or an owner lead's meetings
 * could land in a month whose lead count leaves that lead out. The offset
 * is read at 21:30 UTC the evening before — local midnight or the half
 * hour after it, never across an Israeli clock change (those happen at
 * 02:00). Summer windows get +03:00, i.e. exactly the old query.
 */
const IL_OFFSET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Jerusalem",
  timeZoneName: "longOffset",
});
function ilMidnightParam(day: string): string {
  const probe = Date.parse(`${day}T00:00:00Z`) - 2.5 * 3600 * 1000;
  const name =
    IL_OFFSET_FMT.formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
  const offset = m ? `${m[1]}:${m[2] ?? "00"}` : "+03:00";
  return `${day}T00:00:00${offset.replace("+", "%2B")}`;
}

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

/**
 * The trendline's LEAD-ENTRY meeting lines, re-drawn from meeting EVENTS.
 *
 * The rows a funnel is aggregated from count a meeting as a lead STATUS
 * (the Sheet) or as one stamped status per lead (the warehouse routes), so
 * their daily תיאומים / פגישות never summed to the event-count tiles above
 * the chart — The 57 read 20 in the tile against a legend of distinct
 * leads. This keeps every point's `leads` and replaces its two meeting
 * counts with `daily` (events by the day their lead arrived, per source),
 * adding a zero-lead point where a (day, source) had meetings but no row.
 */
function overlayDailyMeetings(
  series: CrmFunnel["dailyTimeSeries"],
  daily: MeetingDaily,
): CrmFunnel["dailyTimeSeries"] {
  const byDay = new Map<string, Map<string, CrmFunnel["dailyTimeSeries"][number]["bySource"][number]>>();
  for (const d of series) {
    const m = new Map<string, CrmFunnel["dailyTimeSeries"][number]["bySource"][number]>();
    for (const s of d.bySource) m.set(s.source, { ...s, scheduledMeetings: 0, meetings: 0 });
    byDay.set(d.date, m);
  }
  for (const [day, perSource] of Object.entries(daily)) {
    let m = byDay.get(day);
    if (!m) byDay.set(day, (m = new Map()));
    for (const [source, c] of Object.entries(perSource)) {
      const cur = m.get(source) ?? { source, leads: 0, scheduledMeetings: 0, meetings: 0 };
      cur.scheduledMeetings += c.scheduled;
      cur.meetings += c.held;
      m.set(source, cur);
    }
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, m]) => ({ date, bySource: [...m.values()] }));
}

/** MEETING-DATE trendline points (CrmFunnel.dailyDated), sorted ascending. */
function datedDailyPoints(daily: MeetingDaily): NonNullable<CrmFunnel["dailyDated"]> {
  return Object.keys(daily)
    .sort()
    .map((date) => ({
      date,
      bySource: Object.entries(daily[date]).map(([source, c]) => ({
        source,
        scheduledMeetings: c.scheduled,
        meetings: c.held,
      })),
    }));
}

/**
 * Make `allSources` name every key the meeting maps use.
 *
 * The card sums a map over the SELECTED chips, and the selection is seeded
 * from allSources — so a key missing from it is silently left out of the
 * tile even with every chip on. The lead-count sources can no longer be
 * assumed to cover the maps: a dated meeting is filed under its client's
 * first-touch source, which may have brought no lead this window, and a
 * Sheet-routed BMBY card (D3) takes warehouse maps whose source spellings
 * the Sheet may not share. The missing ones are appended after the lead
 * sources (which stay in lead-count order, so no existing chip changes
 * colour), biggest meeting count first, as zero-lead chips.
 */
function extendAllSources(
  sm: CrmFunnel["sourceMatrices"],
  maps: ReadonlyArray<Record<string, number> | undefined>,
): void {
  const have = new Set(sm.allSources);
  const extra = new Map<string, number>();
  for (const m of maps) {
    if (!m) continue;
    for (const [k, n] of Object.entries(m)) {
      if (!k || have.has(k)) continue;
      extra.set(k, (extra.get(k) || 0) + n);
    }
  }
  if (!extra.size) return;
  sm.allSources = [
    ...sm.allSources,
    ...[...extra.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([k]) => k),
  ];
}

/**
 * Install BMBY warehouse meeting maps (lib/crmEnrichment) on a funnel — the
 * warehouse route's own, or a Sheet-routed card's (owner decision D3).
 * Leads, contacts, contracts, statuses and objections are left as the
 * funnel's route counted them; only the meeting side moves:
 *   • scheduledMeetings / canceledMeetings / meetings, the three lead-entry
 *     maps and meetingRatePct ← the OWNER-LEAD counts;
 *   • sourceMatrices.dated and dailyDated ← events dated in the window;
 *   • the trendline's meeting lines ← owner-lead events by lead day.
 */
function applyBmbyWarehouseMeetings(funnel: CrmFunnel, m: BmbyWarehouseMeetings): void {
  const sm = funnel.sourceMatrices;
  funnel.scheduledMeetings = m.lead.totals.scheduled;
  funnel.canceledMeetings = m.lead.totals.canceled;
  funnel.meetings = m.lead.totals.held;
  funnel.meetingRatePct = funnel.leads > 0 ? (m.lead.totals.held / funnel.leads) * 100 : null;
  sm.scheduledMeetingsBySource = { ...m.lead.scheduledMeetingsBySource };
  sm.meetingsBySource = { ...m.lead.meetingsBySource };
  sm.canceledMeetingsBySource = { ...m.lead.canceledMeetingsBySource };
  sm.dated = {
    scheduledMeetingsBySource: { ...m.dated.scheduledMeetingsBySource },
    meetingsBySource: { ...m.dated.meetingsBySource },
    canceledMeetingsBySource: { ...m.dated.canceledMeetingsBySource },
    estimatedHeld: m.dated.estimatedHeld,
  };
  extendAllSources(sm, [sm.scheduledMeetingsBySource, sm.dated.scheduledMeetingsBySource]);
  funnel.dailyTimeSeries = overlayDailyMeetings(funnel.dailyTimeSeries, m.lead.daily);
  funnel.dailyDated = datedDailyPoints(m.dated.daily);
  funnel.meetingBasis = { lead: "owner-lead", dated: "journey-events" };
}

/**
 * May a Sheet-routed BMBY card take the warehouse's meeting maps (D3)?
 * Only when the warehouse carries the window, or its counts are zeros that
 * look measured. Three tests, all off data already read:
 *   • a journey at all (journeyEvents);
 *   • leads in the window — every lead-entry owner is one, so with none
 *     the lead tiles are 0 by construction (הרימון, September 2026: the
 *     feed's last lead 08-31, the Sheet 150 leads and 3 meetings);
 *   • the newest warehouse lead within FRESHNESS_LAG_DAYS of the Sheet's
 *     newest window lead — a feed that stopped mid-window has no owners
 *     for the latest meetings and no journey events after it stopped.
 * The Sheet out-counting the warehouse on leads is NOT a reason by itself:
 * that is why the card is Sheet-routed at all, and is common on a live
 * feed (The 57, August 2026: 172 Sheet vs 159 warehouse leads, newest
 * warehouse lead 09-15; נרקיסים, September: 40 vs 30, 09-15 vs 09-15).
 */
function warehouseCoversWindow(m: BmbyWarehouseMeetings, sheet: CrmFunnel): boolean {
  if (m.journeyEvents === 0 || m.windowLeads === 0) return false;
  const sheetTo = sheet.dateRange.to;
  if (!sheetTo) return true;
  const lagDays =
    (Date.parse(`${sheetTo}T00:00:00Z`) - Date.parse(`${m.newestLeadDay}T00:00:00Z`)) /
    86_400_000;
  return lagDays < FRESHNESS_LAG_DAYS;
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
  const dailyLeadTotals = new Map<string, number>();
  let leads = 0;
  let scheduledMeetings = 0; // תואמה פגישה — broad, includes cancelled
  let canceledMeetings = 0;  // בוטלו — the cancelled subset of scheduled
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
  const canceledMeetingsBySource = new Map<string, number>();
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
    // Every dated in-window lead, source or not (CrmFunnel.dailyLeadTotals).
    {
      const day = dateOnly(arr[iEntry]);
      if (day) dailyLeadTotals.set(day, (dailyLeadTotals.get(day) || 0) + 1);
    }
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
    // Cancelled subset of scheduled ("פגישה בוטלה"). Counted so the card
    // can split תואמה into תואמו (non-cancelled) + בוטלו.
    const isCanceledMeeting = isScheduledMeeting && st.includes("בוטל");
    const isContract = st === "חוזה";
    if (isScheduledMeeting) scheduledMeetings++;
    if (isCanceledMeeting) canceledMeetings++;
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
      if (isCanceledMeeting) canceledMeetingsBySource.set(src, (canceledMeetingsBySource.get(src) || 0) + 1);
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
    canceledMeetings,
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
      offFunnel: BMBY_OFF_FUNNEL_STATUSES,
      leadsBySource, contactedBySource,
      scheduledMeetingsBySource, canceledMeetingsBySource, meetingsBySource,
      contractsBySource,
      statusSourceMatrix, objectionSourceMatrix,
    }),
    dailyTimeSeries: buildDailyTimeSeries(dailySourceMatrix),
    dailyLeadTotals: Object.fromEntries(dailyLeadTotals),
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
    windowFrom: windowIso(window).from,
    windowTo: windowIso(window).to,
  };
}

/* ── BMBY funnel from the Supabase warehouse (journey events) ──────────
 * Produces the SAME CrmFunnel as the Sheet path by synthesizing one row
 * per warehouse lead (cohort = leads created in the window) carrying the
 * columns aggregateBmbyFunnel reads, then running the identical
 * aggregation. Source token = media_source_clean (same token family the
 * Sheet uses, so the cost-join canonicalizer and the source chips work
 * unchanged).
 *
 * The MEETING side is then laid over it from v_bmby_journey_meetings, on
 * both bases (lib/crmEnrichment buildBmbyWarehouseMeetings):
 *   • the unprefixed tiles / maps are LEAD-ENTRY — the owner-lead rule, the
 *     one ALL CLIENTS counts (The 57, September 2026: 20 תואמה · 6 פגישות,
 *     every channel row exact);
 *   • sourceMatrices.dated / dailyDated are events DATED in the window.
 * Until 2026-09-16 the tiles were a third thing: events dated in the window
 * but only for clients with a lead in it (cohort ∩ dated, the 2026-06-22
 * rule, which "verified exact on רמת אפעל 19/8/6" for one month). It agreed
 * with neither basis — The 57's keyword client, lead 08-25 with three
 * September meetings, read 0 in this card and 3 in the keyword table.
 *
 * A lead row's status stamp follows the same ownership: a lead that owns
 * meeting events reads "פגישה התקיימה" / "נקבעה פגישה" / "פגישה בוטלה" off
 * its own events, any date; one that owns none keeps its client_status
 * stage. The status funnel is a lead-status view by nature (the card badges
 * it "לפי כניסת ליד"), so it does not follow the basis switch.
 *
 * Returns null — so the caller keeps the Sheet funnel — on: no key, no
 * window (unbounded fetch), unknown project, or zero in-window leads.
 * Otherwise the funnel plus the maps, which the router grafts onto the
 * Sheet funnel when the Sheet wins on leads and the warehouse still covers
 * the window (owner decision D3, warehouseCoversWindow).
 *
 * NOTE: held counts reflect the warehouse's CONFIRMED outcomes, which are
 * logged retrospectively, so current-month held is naturally low and grows
 * through the month. Stale-leads detection here is window-scoped (the Sheet
 * path sees all-time rows) — acceptable for v1. */
/** Israel-local calendar day of a warehouse timestamptz, by a fixed +3h
 *  shift. Summer-correct only; the funnel windows moved to lib/meetingBasis
 *  ilDayJerusalem. Left for getCrmFeedNewestDay's horizon, whose query
 *  bound is the same fixed +03:00. */
function ilDay(ts: string | null | undefined): string {
  const raw = String(ts ?? "");
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return raw.slice(0, 10);
  return new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

type BmbyWarehouseFunnel = {
  funnel: CrmFunnel;
  /** Both bases' meeting maps, for the D3 graft onto a Sheet funnel. */
  meetings: BmbyWarehouseMeetings;
};

async function computeBmbyFunnelFromWarehouse(
  crmAccount: string,
  window: DateWindow | null,
): Promise<BmbyWarehouseFunnel | null> {
  if (!supabaseConfigured() || !window) return null;
  const w = dayWindowOf(window);
  const { from, toExcl } = w;
  // Resolve numeric project_id (the leads view keys on it).
  const proj = await supabaseRowsAll<{ project_id: number }>(
    `v_report_v2_bmby_projects?select=project_id&project_name=eq.${encodeURIComponent(crmAccount)}`,
  );
  const pid = proj[0]?.project_id;
  if (pid == null) return null;
  // Window-cohort leads.
  const leads = await supabaseRowsAll<{
    client_id: string | null;
    lead_id: string | number | null;
    lead_created_at: string | null;
    handled_at: string | null;
    is_handled: boolean | null;
    // response_seconds is deliberately NOT selected: it wraps at 24h and
    // is unusable (see the speedToLead field doc). Leaving it in the row
    // would put a plausible-looking answer within reach of the next person
    // to need a response time.
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
    // Window bounds are Israel midnights with an explicit offset:
    // lead_created_at is a timestamptz, so a bare date compares at UTC
    // midnight and misfiles each month's first/last IL hours (found
    // 2026-07-09 by diffing a BMBY leads-grid export — 4 of מיה's July-1
    // 00:00-03:00 leads landed in June). The offset is DST-aware
    // (ilMidnightParam); it was a fixed +03:00 until 2026-09-16.
    `v_bmby_leads_bucketed?project_id=eq.${pid}` +
      `&lead_created_at=gte.${ilMidnightParam(from)}&lead_created_at=lt.${ilMidnightParam(toExcl)}` +
      `&select=client_id,lead_id,lead_created_at,handled_at,is_handled,is_return_lead,media_source_clean,objections,client_status,pipeline,channel_key,utm_medium,utm_term,utm_content,utm_campaign` +
      // Stable total order on the PK — Range pagination is non-deterministic
      // without an explicit ORDER BY (rows could repeat/drop past 1000).
      `&order=lead_id.asc`,
  );
  if (!leads.length) return null;
  // The project's full journey (every date) and full lead history. Both
  // bases need all of it: an August lead owns the meetings it books in
  // September, and a dated September meeting is filed under a first lead
  // from any year. The history also serves the returning-lead priors and
  // the פילוח פייסבוק first-touch map, which used to fetch it twice, each
  // behind its own gate.
  const [meetings, history] = await Promise.all([
    fetchBmbyJourneyEvents(crmAccount),
    fetchBmbyLeadHistory(pid),
  ]);
  const built = buildBmbyWarehouseMeetings(history, meetings, w);
  // lead_id → the outcomes of the events that lead OWNS (any date).
  const owned = new Map<string, { held: boolean; live: boolean }>();
  for (const a of built.assignments) {
    if (!a.owner || a.owner.lead_id == null) continue;
    const id = String(a.owner.lead_id);
    const rec = owned.get(id) ?? { held: false, live: false };
    if (bmbyEventHeld(a.event)) rec.held = true;
    if (!bmbyEventCanceled(a.event)) rec.live = true;
    owned.set(id, rec);
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
  const rows: unknown[][] = leads.map((l) => {
    const own = l.lead_id != null ? owned.get(String(l.lead_id)) : undefined;
    const status = own
      ? own.held
        ? "פגישה התקיימה"
        : own.live
          ? "נקבעה פגישה"
          : "פגישה בוטלה"
      : mapWarehouseStatus(l.client_status, l.pipeline, l.is_handled);
    // Any lead with a meeting is contacted by definition (the is_handled
    // flag occasionally lags), so contacted >= scheduled >= held holds.
    const contactDate =
      l.is_handled || own
        ? ilDayJerusalem(l.handled_at || l.lead_created_at)
        : "";
    return [
      crmAccount,
      ilDayJerusalem(l.lead_created_at),
      // channel_key when the source is blank ("other"), as ALL CLIENTS
      // files it — the key the owner-lead meeting maps use too, so a
      // range-mode "Other" row gets its leads with its meetings instead of
      // reading 0 leads next to 5 תואמה (bmbyLeadSourceKey).
      bmbyLeadSourceKey(l),
      status,
      (l.objections || "").trim(),
      contactDate,
    ];
  });
  const funnel = aggregateBmbyFunnel(headers, rows, crmAccount, window);
  if (!funnel) return null;
  funnel.dataSource = "warehouse";
  applyBmbyWarehouseMeetings(funnel, built.meetings);
  // Speed-to-lead + returning/new split + arrival heatmap — all derived
  // from the leads we already fetched (no extra query). Whole-window.
  funnel.speedToLead = computeSpeedToLead(leads);
  funnel.returningSplit = computeReturningSplit(leads);
  // Prior-channel breakdown for returning leads — off the project's full
  // lead history (the prior inquiry is usually before the window).
  if (funnel.returningSplit && funnel.returningSplit.returning > 0) {
    funnel.returningSplit.priorBySource = computeReturningPriors(
      leads.filter((l) => l.is_return_lead === true),
      history.map((h) => ({
        client_id: h.client_id == null ? null : String(h.client_id),
        lead_created_at: h.lead_created_at,
        media_source_clean: h.media_source_clean,
      })),
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
      const src = bmbyLeadSourceKey(l);
      if (src) bySrc[src] = (bySrc[src] || 0) + 1;
    }
    funnel.contracts = n;
    funnel.sourceMatrices.contractsBySource = bySrc;
  }
  // FB UTM drill — placement / audience / creative split of the Meta
  // (channel_key='fb' = fb+ig+an) leads, meetings on both bases. Creative
  // rows also carry spend & CPL/CPS/CPM (joined from the dashboard's
  // facebook-ads-metrics Sheet by exact campaign + ad name).
  funnel.fbBreakdown = await buildFbBreakdown(
    leads,
    built.assignments,
    meetings,
    (clientId) => built.index.first.get(clientId)?.lead,
    w,
  );
  return { funnel, meetings: built.meetings };
}

/** How many objections a UTM row lists. Three names the pattern without
 *  turning a table cell into a paragraph; the rest stay in the tooltip. */
const TOP_OBJECTIONS = 3;

/**
 * Add one lead's objection to a row's tally.
 *
 * The column is free text written by the sales desk, one value per lead
 * ("מחיר", "אין מענה", "תקציב נמוך"). Blank on most leads — roughly 39% of
 * BMBY rows carry one — so the caller must read an empty tally as "not
 * recorded", never as "nobody objected". Separators are tolerated because
 * some desks type two reasons into the one field.
 */
function tallyObjection(into: Map<string, number>, raw: unknown): void {
  const v = String(raw ?? "").trim();
  if (!v || v === "[]" || v === "{}") return;
  for (const part of v.split(/\s*[,;|]\s*/)) {
    const t = trimQuoting(decodeEntities(part)).replace(/\s+/g, " ").trim();
    if (t) into.set(t, (into.get(t) ?? 0) + 1);
  }
}

/**
 * Strip the brackets and quotes a JSON-ish value arrives wrapped in, without
 * eating punctuation that belongs to the text.
 *
 * A trailing apostrophe is only quoting when there is a matching one at the
 * front: in Hebrew it is the abbreviation mark, and a blanket trim turned
 * "מספר טל'" (phone number) into "מספר טל".
 */
function trimQuoting(s: string): string {
  let v = s.replace(/^[[\s]+|[\]\s]+$/g, "");
  for (const q of ['"', "'"]) {
    if (v.length > 1 && v.startsWith(q) && v.endsWith(q)) {
      v = v.slice(1, -1);
    }
  }
  // A leading quote with no partner is stray delimiter; a trailing one is not.
  return v.replace(/^["']+/, "").trim();
}

/**
 * Undo the HTML escaping BMBY applies to its objection text.
 *
 * The column arrives pre-escaped — "מספר טל&#039;" rather than "מספר טל'" —
 * and React escapes on output, so the entity would render literally on the
 * card. Decoded here rather than in the component so the two tallies of the
 * same objection ("מספר טל'" typed by one desk, "מספר טל&#039;" by another)
 * merge into one row instead of splitting the count.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#0?39;?|&apos;?/g, "'")
    .replace(/&quot;?/g, '"')
    .replace(/&#0?34;?/g, '"')
    .replace(/&lt;?/g, "<")
    .replace(/&gt;?/g, ">")
    .replace(/&nbsp;?/g, " ")
    // &amp; last — decoding it first would turn "&amp;#039;" into an
    // apostrophe on a second pass rather than the literal "&#039;".
    .replace(/&amp;?/g, "&");
}

/** The row's objections, biggest first, capped. Undefined (not []) when the
 *  row recorded none, so the UI can distinguish "none recorded" from a row
 *  the builder never looked at. */
function topObjections(
  m: Map<string, number>,
): { label: string; n: number }[] | undefined {
  if (!m.size) return undefined;
  return [...m.entries()]
    .map(([label, n]) => ({ label, n }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, TOP_OBJECTIONS);
}

/** The UTM tags a breakdown groups by. */
type FbUtm = {
  channel_key?: string | null;
  utm_medium: string | null;
  utm_term: string | null;
  utm_content: string | null;
  utm_campaign: string | null;
};

type FbLead = FbUtm & {
  client_id: string | null;
  /** Already in the warehouse lead select — see the bmby_leads_daily query. */
  objections?: string | null;
};

/** One UTM group (placement / audience / creative / keyword) while a
 *  breakdown is being built: its window leads, and its meetings on both
 *  bases. */
type UtmAcc = {
  leads: number;
  /** LEAD-ENTRY תואמו / פגישות. */
  sched: number;
  held: number;
  /** MEETING-DATE תואמו / פגישות. */
  dSched: number;
  dHeld: number;
  obj: Map<string, number>;
};

function ensureUtmAcc(m: Map<string, UtmAcc>, k: string): UtmAcc {
  let r = m.get(k);
  if (!r) {
    r = { leads: 0, sched: 0, held: 0, dSched: 0, dHeld: 0, obj: new Map() };
    m.set(k, r);
  }
  return r;
}

/** The order a breakdown's rows are ranked and cut in: leads plus the
 *  LARGER of the two bases' תואמו. A row must not move — or fall behind the
 *  top-8 cut into "אחר" — when the basis switch flips, and ranking on either
 *  basis alone would do exactly that. A creative that produced meetings but
 *  no new leads this window (an older ad) still surfaces. */
const utmRank = (r: { leads: number; scheduled: number; datedScheduled?: number }) =>
  r.leads + Math.max(r.scheduled, r.datedScheduled ?? 0);

/** Top-N rows on both bases plus an "אחר" remainder. The "אחר" bucket
 *  deliberately carries NO objection list: it merges unrelated placements /
 *  creatives, so an objection on it names nothing. */
function utmRowsBothBases(m: Map<string, UtmAcc>, top: number): UtmRow[] {
  const sorted: UtmRow[] = [...m.entries()]
    .map(([label, r]) => ({
      label,
      leads: r.leads,
      scheduled: r.sched,
      held: r.held,
      datedScheduled: r.dSched,
      datedHeld: r.dHeld,
      objections: topObjections(r.obj),
    }))
    .sort((a, b) => utmRank(b) - utmRank(a));
  const head = sorted.slice(0, top);
  const rest = sorted.slice(top).reduce(
    (s, r) => ({
      leads: s.leads + r.leads,
      scheduled: s.scheduled + r.scheduled,
      held: s.held + r.held,
      datedScheduled: s.datedScheduled + (r.datedScheduled ?? 0),
      datedHeld: s.datedHeld + (r.datedHeld ?? 0),
    }),
    { leads: 0, scheduled: 0, held: 0, datedScheduled: 0, datedHeld: 0 },
  );
  if (rest.leads > 0 || rest.scheduled > 0 || rest.datedScheduled > 0) {
    head.push({ label: "אחר", ...rest });
  }
  return head;
}

/** Creative rows on both bases with the spend join: CPS / CPM per basis.
 *  `withObjections` is off for Sehel, whose creative rows never carried
 *  them. */
function creativeRowsBothBases(
  m: Map<string, UtmAcc>,
  spendByAd: Map<string, { cost: number }>,
  top: number,
  withObjections: boolean,
): NonNullable<CrmFunnel["fbBreakdown"]>["byCreative"] {
  return [...m.entries()]
    .map(([label, r]) => {
      const spend = spendByAd.get(label)?.cost ?? 0;
      return {
        label,
        leads: r.leads,
        scheduled: r.sched,
        held: r.held,
        datedScheduled: r.dSched,
        datedHeld: r.dHeld,
        spend,
        ...(withObjections ? { objections: topObjections(r.obj) } : {}),
        cpl: r.leads ? spend / r.leads : 0,
        cps: r.sched ? spend / r.sched : 0,
        cpm: r.held ? spend / r.held : 0,
        datedCps: r.dSched ? spend / r.dSched : 0,
        datedCpm: r.dHeld ? spend / r.dHeld : 0,
      };
    })
    .sort((a, b) => utmRank(b) - utmRank(a))
    .slice(0, top);
}

/** Placement / audience / creative breakdown of a project's Meta leads
 *  (channel_key='fb' = fb+ig+an) from their UTM tags.
 *   • leads = window fb lead rows, grouped by their own UTM tag.
 *   • תואמו / פגישות, LEAD-ENTRY (scheduled / held): meeting EVENTS whose
 *     OWNER lead (lib/meetingBasis assignOwnerLeads) is an fb lead created
 *     in the window, credited to that lead's own tags — any meeting date.
 *     The rule ALL CLIENTS counts, so Σ audiences + untagged.lead = the
 *     ערוצים facebook row: The 57, September 2026, 5/3 + 2/1 = 7/4 (the
 *     dated join read 21/7 against that 7/4).
 *   • תואמו / פגישות, MEETING-DATE (datedScheduled / datedHeld): events
 *     dated IN the window (appointment_date, booking date as fallback),
 *     credited to the client's FIRST lead by lead_id when that lead is fb
 *     — so a June ad gets its clients' July meetings in the July view. The
 *     same set as the dated tiles (2026-07-09 3-tenant sweep of BMBY period
 *     reports: נתיבות June 129≈133, kenko June ~70≈57+30, מיה July 53≈55).
 *   • held on both = BMBY-confirmed only. Counting past-due-unmarked
 *     in_process as performed presented estimates as fact (בוצעו 18 on a
 *     card whose BMBY row said 10) — owner decision 2026-07-09. The cost:
 *     current-month held lags BMBY until outcomes are marked.
 *  Meetings of an fb lead with no audience tag land in `untagged`, per
 *  basis. The creative rows also carry spend + CPL/CPS/CPM joined from the
 *  dashboard's facebook-ads-metrics Sheet. undefined when the project has
 *  no in-window Meta leads. */
async function buildFbBreakdown(
  windowLeads: FbLead[],
  assignments: readonly OwnerAssignment<BmbyHistoryLead, BmbyJourneyEvent>[],
  events: readonly BmbyJourneyEvent[],
  firstLeadOf: (clientId: string) => BmbyHistoryLead | undefined,
  w: DayWindow,
): Promise<CrmFunnel["fbBreakdown"]> {
  const fb = windowLeads.filter((l) => l.channel_key === "fb");
  if (!fb.length) return undefined;
  const TOP = 8;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  // utm_term occasionally carries a raw Meta numeric ID — bucket to "אחר".
  const deId = (raw: string): string => {
    const v = norm(raw);
    return /^\d{8,}$/.test(v) ? "אחר" : v;
  };

  // One entry per meeting event, with the tags of the lead it is credited
  // to on that basis.
  const leadEvents: { utm: FbUtm; held: boolean }[] = [];
  for (const a of assignments) {
    if (!a.owner || a.owner.channel_key !== "fb" || !dayInWindow(a.ownerDay, w)) continue;
    leadEvents.push({ utm: a.owner, held: bmbyEventHeld(a.event) });
  }
  const datedEvents: { utm: FbUtm; held: boolean }[] = [];
  for (const e of events) {
    if (!dayInWindow(datedDay(e), w)) continue;
    const first = firstLeadOf(String(e.client_id ?? "").trim());
    if (first?.channel_key !== "fb") continue;
    datedEvents.push({ utm: first, held: bmbyEventHeld(e) });
  }

  const accumulate = (getLabel: (u: FbUtm) => string): Map<string, UtmAcc> => {
    const m = new Map<string, UtmAcc>();
    for (const l of fb) {
      const v = getLabel(l);
      if (!v) continue;
      const r = ensureUtmAcc(m, v);
      r.leads++;
      // Objections come off the LEAD only — never the meeting credit below,
      // whose credited lead can sit outside the window.
      tallyObjection(r.obj, l.objections);
    }
    for (const ev of leadEvents) {
      const v = getLabel(ev.utm);
      if (!v) continue;
      const r = ensureUtmAcc(m, v);
      r.sched++;
      if (ev.held) r.held++;
    }
    for (const ev of datedEvents) {
      const v = getLabel(ev.utm);
      if (!v) continue;
      const r = ensureUtmAcc(m, v);
      r.dSched++;
      if (ev.held) r.dHeld++;
    }
    return m;
  };

  const audienceOf = (u: FbUtm) => deId(String(u.utm_term ?? ""));
  const placement = accumulate((u) => norm(String(u.utm_medium ?? "").replace(/_/g, " ")));
  const audience = accumulate(audienceOf);
  const creativeAcc = accumulate((u) => {
    const ad = normAdName(u.utm_content);
    return ad && !/^\d{8,}$/.test(ad) ? ad : "";
  });
  const untaggedOf = (list: { utm: FbUtm; held: boolean }[]) => {
    const t = { scheduled: 0, held: 0 };
    for (const ev of list) {
      if (audienceOf(ev.utm)) continue;
      t.scheduled++;
      if (ev.held) t.held++;
    }
    return t;
  };

  // Campaign scope for the spend join — union of window fb leads' campaigns AND
  // the campaigns behind meeting-credited (older) creatives on either basis, so
  // a creative that produced meetings but no new window leads still gets its
  // spend scoped.
  const campaigns = new Set<string>();
  const addCamp = (u: FbUtm) => {
    const camp = norm(String(u.utm_campaign ?? ""));
    if (camp && !/^\d{8,}$/.test(camp)) campaigns.add(camp);
  };
  for (const l of fb) addCamp(l);
  for (const ev of leadEvents) addCamp(ev.utm);
  for (const ev of datedEvents) addCamp(ev.utm);

  // Join per-ad spend from the dashboard's facebook-ads-metrics Sheet (exact
  // campaign scope → collision-free). Degrades to spend=0 on any failure.
  let spendByAd = new Map<string, { cost: number; impressions: number; websiteLeads: number }>();
  try {
    spendByAd = await fbAdSpendByCreative(driveFolderOwner(), campaigns, w.from, w.toExcl);
  } catch {
    /* leave spend at 0 */
  }

  return {
    totalLeads: fb.length,
    // utm_medium = ad placement (Facebook_Mobile_Feed → "Facebook Mobile Feed").
    byPlacement: utmRowsBothBases(placement, TOP),
    byAudience: utmRowsBothBases(audience, TOP),
    byCreative: creativeRowsBothBases(creativeAcc, spendByAd, TOP, true),
    untagged: { lead: untaggedOf(leadEvents), dated: untaggedOf(datedEvents) },
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
  return aggregateSehelFunnel(headers, rows as unknown[][], crmAccount, window);
}

/** Pure Sehel funnel aggregation — shared by the Sheet path (above) and the
 *  warehouse path (computeSehelFunnelFromWarehouse, below). Row source is
 *  irrelevant; only the column NAMES matter (headers.indexOf), so the
 *  warehouse path synthesizes rows with the same header names. Mirrors
 *  aggregateBmbyFunnel. */
function aggregateSehelFunnel(
  headers: string[],
  rows: unknown[][],
  crmAccount: string,
  window: DateWindow | null,
): CrmFunnel | null {
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
  const dailyLeadTotals = new Map<string, number>();
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
    // Every dated in-window lead, source or not (CrmFunnel.dailyLeadTotals).
    {
      const day = dateOnly(arr[iRegDate]);
      if (day) dailyLeadTotals.set(day, (dailyLeadTotals.get(day) || 0) + 1);
    }
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
      offFunnel: SEHEL_OFF_FUNNEL_STATUSES,
      leadsBySource, contactedBySource,
      scheduledMeetingsBySource, meetingsBySource,
      contractsBySource,
      statusSourceMatrix, objectionSourceMatrix,
    }),
    dailyTimeSeries: buildDailyTimeSeries(dailySourceMatrix),
    dailyLeadTotals: Object.fromEntries(dailyLeadTotals),
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
    windowFrom: windowIso(window).from,
    windowTo: windowIso(window).to,
  };
}

/* ── Sehel warehouse funnel (Supabase sehel_* tables) ──────────────── */

type SehelUtm = {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  /** Selected by the lead query alongside the UTMs; optional here because
   *  the meeting-credit map is keyed on the narrower shape. */
  objections?: string | null;
};
type SehelWhLead = SehelUtm & {
  client_uuid: string | null;
  project_name: string | null;
  stage: string | null;
  media_source_raw: string | null;
  objections: string | null;
  registered_at: string | null;
  updated_at_sehel: string | null;
};

/** Sehel channel detection off utm_source (no channel_key like BMBY). fb =
 *  Meta family (fb/ig/an/facebook/instagram/meta); google = search/discovery. */
const isSehelFbSource = (s: string | null): boolean => {
  const v = String(s ?? "").toLowerCase().trim();
  return (
    v === "fb" ||
    v === "an" ||
    v === "meta" ||
    v.startsWith("facebook") ||
    v === "ig" ||
    v.startsWith("instagram")
  );
};
const isSehelGoogleSource = (s: string | null): boolean => {
  const v = String(s ?? "").toLowerCase().trim();
  return v.startsWith("goo") || v.startsWith("google");
};
type SehelWhMeeting = {
  client_uuid: string | null;
  project_name: string | null;
  status_id: number | null;
  status_label: string | null;
  starts_at: string | null;
};

/** The UTC calendar day of a Sehel timestamptz — the calendar the Sehel
 *  lead window (`+00:00` bounds, dateOnly) already runs on, so a meeting and
 *  the lead window it is compared with agree. See the open question in
 *  computeSehelFunnelFromWarehouse's doc about whether that calendar is
 *  right. */
function sehelUtcDay(ts: string | null | undefined): string {
  const ms = Date.parse(String(ts ?? ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
}

/** One basis' Sehel meeting tallies while they are being counted. */
type SehelMeetingAcc = {
  scheduledMeetingsBySource: Record<string, number>;
  meetingsBySource: Record<string, number>;
  totals: MeetingTally;
  daily: MeetingDaily;
};

const emptySehelAcc = (): SehelMeetingAcc => ({
  scheduledMeetingsBySource: {},
  meetingsBySource: {},
  totals: { scheduled: 0, held: 0, canceled: 0 },
  daily: {},
});

/** Count one Sehel meeting event: totals always, a source map only when the
 *  client has a source, a trendline day only when it has one too. */
function tallySehelMeeting(into: SehelMeetingAcc, src: string, day: string, held: boolean): void {
  into.totals.scheduled++;
  if (held) into.totals.held++;
  if (!src) return;
  into.scheduledMeetingsBySource[src] = (into.scheduledMeetingsBySource[src] || 0) + 1;
  if (held) into.meetingsBySource[src] = (into.meetingsBySource[src] || 0) + 1;
  if (!day) return;
  const cell = ((into.daily[day] ??= {})[src] ??= { scheduled: 0, held: 0 });
  cell.scheduled++;
  if (held) cell.held++;
}

type SehelWarehouseFunnel = {
  funnel: CrmFunnel;
  /** Meeting events DATED in the window, every source. The router's
   *  sync-gap test reads this — the same count it read before the tiles
   *  moved to the registration cohort, so which projects route to the
   *  warehouse did not change with them. */
  datedWindow: MeetingTally;
  /** The dated maps and trendline, for a Sheet-routed card to borrow.
   *  undefined when the project has no sehel_meetings at all. */
  dated?: { maps: CrmDatedMeetingMaps; daily: CrmDatedDailyPoint[] };
};

/** Warehouse-backed Sehel funnel. Leads are windowed on `registered_at` from
 *  sehel_leads_daily and fed through the shared `aggregateSehelFunnel` (which
 *  gives leads / sources / objections / status / stale / daily). The meeting
 *  counts are then OVERRIDDEN with authoritative sehel_meetings events, so
 *  they stop relying on the Sheet's stage heuristic, on both bases:
 *
 *   • LEAD-ENTRY (the unprefixed tiles and maps) — the REGISTRATION COHORT:
 *     every meeting event, at any date and any status, of a client who
 *     registered in the window, under that registration's source. ביצועים =
 *     status exactly "הלקוח הגיע לפגישה" (owner decision D2). Ginot
 *     2026-09-01..16: 8 תואמה (פייסבוק 4, גוגל 2, פניה טלפונית 2) · 4
 *     פגישות — ALL CLIENTS' 8/4, every row. It used to be dated events
 *     (15/11) under a "לפי כניסת ליד" window.
 *   • MEETING-DATE (sourceMatrices.dated, dailyDated) — events whose starts_at
 *     is in the window, held = status_id 10 (the same meetings as the label;
 *     paired 1:1 in all 1,272 since 2026-01), credited to the client's lead
 *     source whenever that lead registered. What the tiles used to show.
 *
 *  Both come off ONE read of the project's meetings, all dates (a cohort
 *  client's meeting can be months after the window). Sehel meeting volume
 *  is small — 659 all-time on CAZAR, 234 on Ginot, 83 on HaGada — so this
 *  replaces the windowed read rather than adding a second.
 *
 *  Sehel timestamps are compared in +00:00 (unlike BMBY's Israel days), so
 *  the window and `dateOnly` keep the calendar this route has always used.
 *  OPEN: they measure as true UTC, not wall-clock (meeting starts peak at
 *  07:00 UTC = 10:00 Israel), so strictly an Israel-day window would move
 *  the few registrations made 21:00–24:00 UTC to the next day. On Ginot,
 *  CAZAR and HaGada's windows the cohort came out identical either way
 *  (2026-09-16), and moving it here would move lead counts too — left for
 *  one decision across the Sehel readers.
 *
 *  Returns null so the caller keeps the Sheet funnel; window-scoped, so the
 *  caller preserves the Sheet's project-wide stale tally. */
async function computeSehelFunnelFromWarehouse(
  crmAccount: string,
  window: DateWindow | null,
): Promise<SehelWarehouseFunnel | null> {
  if (!supabaseConfigured() || !window) return null;
  const w = dayWindowOf(window);
  const { from, toExcl } = w;
  // Sehel project_name carries a "<project> <salesperson>" suffix, and a Keys
  // account can be comma-joined — match server-side with a prefix `like` per
  // candidate (double-quoted so a comma inside a name doesn't break the `or`),
  // then refine on a word boundary in memory (same rule as the Sheet path).
  const cands = crmAccountCandidates(crmAccount);
  if (!cands.length) return null;
  const orLike = orPrefixFilter("project_name", cands, "like");
  const targets = cands.map(norm);
  const matchesProject = (p: string | null): boolean => {
    const n = norm(p);
    return targets.some((t) => n.startsWith(t) && (n === t || n[t.length] === " "));
  };
  // +00:00 window bounds (Sehel wall-clock is tagged UTC, not +03:00).
  const gte = `${from}T00:00:00%2B00:00`;
  const lt = `${toExcl}T00:00:00%2B00:00`;
  const leadsRaw = await supabaseRowsAll<SehelWhLead>(
    `sehel_leads_daily?or=(${orLike})` +
      `&registered_at=gte.${gte}&registered_at=lt.${lt}` +
      `&select=client_uuid,project_name,stage,media_source_raw,objections,registered_at,updated_at_sehel,utm_source,utm_medium,utm_campaign,utm_content,utm_term` +
      `&order=client_uuid.asc`,
  );
  const leads = leadsRaw.filter((l) => matchesProject(l.project_name));
  if (!leads.length) return null;

  // Run the leads through the shared aggregator via synthesized rows in the
  // Sheet column layout (only the column NAMES matter). The meeting columns
  // are left empty — the authoritative counts are overridden below.
  const synthHeaders = [
    "פרויקט",
    "שלב טיפול",
    "תאריך פגישה אחרונה",
    "התנגדויות",
    "מקור הגעה",
    "תאריך רישום",
    "עדכון אחרון",
  ];
  const synthRows: unknown[][] = leads.map((l) => [
    l.project_name ?? "",
    l.stage ?? "",
    "",
    l.objections ?? "",
    l.media_source_raw ?? "",
    dateOnly(l.registered_at),
    dateOnly(l.updated_at_sehel),
  ]);
  const base = aggregateSehelFunnel(synthHeaders, synthRows, crmAccount, window);
  if (!base) return null;

  // The project's meetings, every date (see the doc above).
  const meetingsAll = (
    await supabaseRowsAll<SehelWhMeeting>(
      `sehel_meetings?or=(${orLike})` +
        `&select=client_uuid,project_name,status_id,status_label,starts_at&order=event_uid.asc`,
    )
  ).filter((m) => matchesProject(m.project_name));
  const hasMeetings = meetingsAll.length > 0;
  const winMeetings = meetingsAll.filter((m) => dayInWindow(sehelUtcDay(m.starts_at), w));

  // The cohort: client → its earliest registration in the window. That
  // lead's source and UTM are what its meetings are credited to.
  const cohort = new Map<string, SehelWhLead>();
  for (const l of leads) {
    if (!l.client_uuid) continue;
    const cur = cohort.get(l.client_uuid);
    if (!cur || String(l.registered_at ?? "") < String(cur.registered_at ?? "")) {
      cohort.set(l.client_uuid, l);
    }
  }
  const srcByClient = new Map<string, string>();
  const utmByClient = new Map<string, SehelUtm>();
  for (const [c, l] of cohort) {
    srcByClient.set(c, l.media_source_raw ?? "");
    utmByClient.set(c, l);
  }
  // Meeting-clients whose lead registered OUTSIDE the window aren't in the
  // cohort above — fetch their source + first-touch UTM in one batch.
  const missing = [
    ...new Set(
      winMeetings
        .map((m) => m.client_uuid)
        .filter((c): c is string => !!c && !srcByClient.has(c)),
    ),
  ];
  if (missing.length) {
    const extra = await supabaseRowsAll<
      { client_uuid: string; media_source_raw: string | null } & SehelUtm
    >(
      `sehel_leads_daily?client_uuid=in.(${missing.map((u) => `"${u}"`).join(",")})` +
        `&select=client_uuid,media_source_raw,utm_source,utm_medium,utm_campaign,utm_content,utm_term`,
    );
    for (const r of extra)
      if (r.client_uuid) {
        srcByClient.set(r.client_uuid, r.media_source_raw ?? "");
        utmByClient.set(r.client_uuid, r);
      }
  }

  const lead = emptySehelAcc();
  const cohortEvents = meetingsAll.filter((m) => !!m.client_uuid && cohort.has(m.client_uuid));
  for (const m of cohortEvents) {
    const l = cohort.get(m.client_uuid as string) as SehelWhLead;
    tallySehelMeeting(
      lead,
      normSource(l.media_source_raw),
      dateOnly(l.registered_at),
      sehelLeadEntryHeld(m.status_label),
    );
  }
  const dated = emptySehelAcc();
  for (const m of winMeetings) {
    tallySehelMeeting(
      dated,
      normSource(srcByClient.get(m.client_uuid ?? "") ?? ""),
      sehelUtcDay(m.starts_at),
      Number(m.status_id) === 10,
    );
  }

  const sm = base.sourceMatrices;
  base.scheduledMeetings = lead.totals.scheduled;
  base.meetings = lead.totals.held;
  base.meetingRatePct = base.leads > 0 ? (lead.totals.held / base.leads) * 100 : null;
  sm.scheduledMeetingsBySource = lead.scheduledMeetingsBySource;
  sm.meetingsBySource = lead.meetingsBySource;
  base.dailyTimeSeries = overlayDailyMeetings(base.dailyTimeSeries, lead.daily);
  // "Mapped, reachable, nothing in the window" is a measured 0; only a
  // project with no sehel_meetings at all (the sync gap the router below
  // describes) has no dated source.
  const datedOut = hasMeetings
    ? {
        maps: {
          scheduledMeetingsBySource: dated.scheduledMeetingsBySource,
          meetingsBySource: dated.meetingsBySource,
        },
        daily: datedDailyPoints(dated.daily),
      }
    : undefined;
  sm.dated = datedOut?.maps;
  base.dailyDated = datedOut?.daily;
  extendAllSources(sm, [sm.scheduledMeetingsBySource, datedOut?.maps.scheduledMeetingsBySource]);
  base.meetingBasis = {
    lead: "registration-cohort",
    dated: hasMeetings ? "sehel-events" : null,
  };
  base.dataSource = "warehouse";
  // Meta placement/audience/creative + Google keyword UTM drill.
  try {
    base.fbBreakdown = await buildSehelBreakdown(
      leads,
      cohortEvents,
      winMeetings,
      utmByClient,
      w,
    );
  } catch {
    /* leave fbBreakdown unset */
  }
  return { funnel: base, datedWindow: dated.totals, dated: datedOut };
}

/** Sehel UTM drill — mirrors buildFbBreakdown for Meta (placement=utm_medium,
 *  audience=utm_term, creative=utm_content + spend) and ADDS a Google keyword
 *  dimension (utm_term on google-source leads). Channel split is on utm_source
 *  (Sehel has no channel_key). The lead's utm is already first-touch (per the
 *  exporter), so meetings attribute directly by client_uuid, on both bases:
 *   • lead-entry (scheduled / held): the registration cohort's meetings, any
 *     date, held = "הלקוח הגיע לפגישה" (D2) — Ginot Sept: audiences 4/2 =
 *     the פייסבוק row, keywords 2/1 = the גוגל row;
 *   • meeting-date (datedScheduled / datedHeld): meetings dated in the
 *     window, held = status_id 10.
 *  A cohort client is credited through its own registration's UTM (the
 *  earliest in the window); `utmByClient` holds those plus the clients of
 *  dated meetings who registered earlier. Returns undefined when there are
 *  no window UTM leads at all. */
async function buildSehelBreakdown(
  windowLeads: SehelUtm[],
  cohortEvents: Array<{ client_uuid: string | null; status_label: string | null }>,
  winMeetings: Array<{ client_uuid: string | null; status_id: number | null }>,
  utmByClient: Map<string, SehelUtm>,
  w: DayWindow,
): Promise<CrmFunnel["fbBreakdown"]> {
  const fbLeads = windowLeads.filter((l) => isSehelFbSource(l.utm_source));
  const gLeads = windowLeads.filter((l) => isSehelGoogleSource(l.utm_source));
  if (!fbLeads.length && !gLeads.length) return undefined;
  const TOP = 8;
  const cl = (s: string) => s.replace(/\s+/g, " ").trim();
  const deId = (raw: string): string => {
    const v = cl(raw);
    return /^\d{8,}$/.test(v) ? "אחר" : v;
  };
  // Meeting events per client, per basis.
  type Ev = { total: number; done: number };
  const perClient = <M,>(list: M[], clientOf: (m: M) => string | null, held: (m: M) => boolean) => {
    const out = new Map<string, Ev>();
    for (const m of list) {
      const c = String(clientOf(m) ?? "");
      if (!c) continue;
      const rec = out.get(c) || { total: 0, done: 0 };
      rec.total++;
      if (held(m)) rec.done++;
      out.set(c, rec);
    }
    return out;
  };
  const leadEvByClient = perClient(cohortEvents, (m) => m.client_uuid, (m) => sehelLeadEntryHeld(m.status_label));
  const evByClient = perClient(winMeetings, (m) => m.client_uuid, (m) => Number(m.status_id) === 10);
  // Group a channel's leads by a UTM label, then credit each meeting-client's
  // events to the group of their first-touch lead (same channel only).
  const build = (
    leadSet: SehelUtm[],
    getLabel: (u: SehelUtm) => string,
    channelMatch: (s: string | null) => boolean,
  ): Map<string, UtmAcc> => {
    const m = new Map<string, UtmAcc>();
    for (const l of leadSet) {
      const v = getLabel(l);
      if (!v) continue;
      const r = ensureUtmAcc(m, v);
      r.leads++;
      // Lead-side only, same as BMBY — see UtmRow.objections.
      tallyObjection(r.obj, l.objections);
    }
    for (const [c, ev] of leadEvByClient) {
      const u = utmByClient.get(c);
      if (!u || !channelMatch(u.utm_source)) continue;
      const v = getLabel(u);
      if (!v) continue;
      const r = ensureUtmAcc(m, v);
      r.sched += ev.total;
      r.held += ev.done;
    }
    for (const [c, ev] of evByClient) {
      const u = utmByClient.get(c);
      if (!u || !channelMatch(u.utm_source)) continue;
      const v = getLabel(u);
      if (!v) continue;
      const r = ensureUtmAcc(m, v);
      r.dSched += ev.total;
      r.dHeld += ev.done;
    }
    return m;
  };
  // Sehel's utm_medium is inconsistent — ~half the fb rows carry a truncated
  // 2-char code ("Fa"/"In"/"an"/"di"/"Ot") instead of a full placement
  // ("Facebook_Mobile_Feed"). Normalize the known truncations so the column
  // reads honestly; fall back to underscore→space for the clean values.
  const normPlacement = (raw: string): string => {
    const v = cl(raw);
    if (!v) return "";
    const map: Record<string, string> = {
      Fa: "Facebook", In: "Instagram", an: "Audience Network",
      di: "Display", d: "Display", Ot: "אחר", Others: "אחר", cpc: "Search",
    };
    if (map[v]) return map[v];
    return v.replace(/_/g, " ");
  };
  const audienceOf = (u: SehelUtm) => deId(String(u.utm_term ?? ""));
  const placement = build(fbLeads, (u) => normPlacement(String(u.utm_medium ?? "")), isSehelFbSource);
  const audience = build(fbLeads, audienceOf, isSehelFbSource);
  const creativeAcc = build(fbLeads, (u) => {
    const ad = normAdName(u.utm_content);
    return ad && !/^\d{8,}$/.test(ad) ? ad : "";
  }, isSehelFbSource);
  const keyword = build(gLeads, (u) => deId(String(u.utm_term ?? "")), isSehelGoogleSource);
  // Meta meetings no audience row can take (the client's UTM has no term).
  const untaggedOf = (byClient: Map<string, Ev>) => {
    const t = { scheduled: 0, held: 0 };
    for (const [c, ev] of byClient) {
      const u = utmByClient.get(c);
      if (!u || !isSehelFbSource(u.utm_source) || audienceOf(u)) continue;
      t.scheduled += ev.total;
      t.held += ev.done;
    }
    return t;
  };

  // Spend join for fb creatives (same facebook-ads-metrics Sheet as BMBY).
  const campaigns = new Set<string>();
  const addCamp = (u: SehelUtm) => {
    const camp = cl(String(u.utm_campaign ?? ""));
    if (camp && !/^\d{8,}$/.test(camp)) campaigns.add(camp);
  };
  for (const l of fbLeads) addCamp(l);
  for (const c of new Set([...leadEvByClient.keys(), ...evByClient.keys()])) {
    const u = utmByClient.get(c);
    if (u && isSehelFbSource(u.utm_source)) addCamp(u);
  }
  let spendByAd = new Map<string, { cost: number; impressions: number; websiteLeads: number }>();
  try {
    spendByAd = await fbAdSpendByCreative(driveFolderOwner(), campaigns, w.from, w.toExcl);
  } catch {
    /* leave spend at 0 */
  }

  return {
    totalLeads: fbLeads.length,
    byPlacement: utmRowsBothBases(placement, TOP),
    byAudience: utmRowsBothBases(audience, TOP),
    byCreative: creativeRowsBothBases(creativeAcc, spendByAd, TOP, false),
    byKeyword: gLeads.length ? utmRowsBothBases(keyword, TOP) : undefined,
    untagged: { lead: untaggedOf(leadEvByClient), dated: untaggedOf(evByClient) },
  };
}

/* ── Salesforce funnel ─────────────────────────────────────────────── */

/* ── Salesforce UTM drill ───────────────────────────────────────────────
 * Salesforce exposes no meeting EVENTS table — its funnel is a current-status
 * snapshot — so a lead's scheduled/held is decided by its own resolved status
 * (מצב ליד 3, which already folds the meeting's status back onto the lead),
 * NOT by joining an events table (the BMBY/Sehel model). That makes the
 * breakdown a straight group-by over the project's in-window leads that
 * matched a UTM row by phone.
 * Same keys + output shape as BMBY/Sehel, so the existing פילוח פייסבוק panel
 * and the Google-keyword block render unchanged. */
type SfUtmLead = { utm: SfUtm; scheduled: boolean; held: boolean; objection: string };

const isSfFbSource = (s: unknown): boolean => {
  const v = String(s ?? "").toLowerCase().trim();
  return (
    v === "fb" || v === "ig" || v === "an" || v === "meta" ||
    v.startsWith("facebook") || v.startsWith("instagram")
  );
};
const isSfGoogleSource = (s: unknown): boolean => {
  const v = String(s ?? "").toLowerCase().trim();
  return v.startsWith("goo") || v.startsWith("google") || v === "discovery";
};

async function buildSalesforceBreakdown(
  utmLeads: SfUtmLead[],
  from: string,
  toExcl: string,
): Promise<CrmFunnel["fbBreakdown"]> {
  const fb = utmLeads.filter((l) => isSfFbSource(l.utm.source));
  const gs = utmLeads.filter((l) => isSfGoogleSource(l.utm.source));
  if (!fb.length && !gs.length) return undefined;
  const TOP = 8;
  const cl = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

  type Rec = { leads: number; scheduled: number; held: number; obj: Map<string, number> };
  const group = (set: SfUtmLead[], label: (l: SfUtmLead) => string): Map<string, Rec> => {
    const m = new Map<string, Rec>();
    for (const l of set) {
      const k = label(l);
      if (!k) continue;
      let r = m.get(k);
      if (!r) { r = { leads: 0, scheduled: 0, held: 0, obj: new Map() }; m.set(k, r); }
      r.leads++;
      if (l.scheduled) r.scheduled++;
      if (l.held) r.held++;
      // Salesforce reads its objection off the same row as the UTM join,
      // so unlike BMBY/Sehel there is no second lookup.
      tallyObjection(r.obj, l.objection);
    }
    return m;
  };
  const toRows = (m: Map<string, Rec>) => {
    const sorted = [...m.entries()]
      .map(([label, r]) => ({ label, leads: r.leads, scheduled: r.scheduled, held: r.held }))
      .sort((a, b) => b.leads + b.scheduled - (a.leads + a.scheduled));
    const head = sorted.slice(0, TOP);
    const rest = sorted.slice(TOP).reduce(
      (s, r) => ({ leads: s.leads + r.leads, scheduled: s.scheduled + r.scheduled, held: s.held + r.held }),
      { leads: 0, scheduled: 0, held: 0 },
    );
    if (rest.leads > 0 || rest.scheduled > 0) head.push({ label: "אחר", ...rest });
    return head;
  };

  // Dimensions are already shape-classified in lib/salesforceUtm (the sheet's
  // medium/term/content columns are swapped on some tabs, so we can't trust
  // them positionally). Numeric Meta ids were dropped there.
  const placement = group(fb, (l) => l.utm.placement);
  const audience = group(fb, (l) => l.utm.audience);
  const keyword = group(gs, (l) => l.utm.audience); // google: free-text = keyword
  const creativeAcc = group(fb, (l) => normAdName(l.utm.creative));

  // Spend join — utm_campaign is a READABLE name ("Shbn_…_FB"), so it keys the
  // fb-ads Sheet exactly like BMBY. Numeric campaign IDs are skipped (they
  // can't join). Degrades to spend=0 on any failure.
  const campaigns = new Set<string>();
  for (const l of fb) {
    const c = cl(l.utm.campaign);
    if (c && !/^\d{8,}$/.test(c)) campaigns.add(c);
  }
  let spendByAd = new Map<string, { cost: number; impressions: number; websiteLeads: number }>();
  if (campaigns.size && from && toExcl) {
    try {
      spendByAd = await fbAdSpendByCreative(driveFolderOwner(), campaigns, from, toExcl);
    } catch {
      /* leave spend at 0 */
    }
  }
  const byCreative = [...creativeAcc.entries()]
    .map(([label, r]) => {
      const spend = spendByAd.get(label)?.cost ?? 0;
      return {
        label, leads: r.leads, scheduled: r.scheduled, held: r.held, spend,
        cpl: r.leads ? spend / r.leads : 0,
        cps: r.scheduled ? spend / r.scheduled : 0,
        cpm: r.held ? spend / r.held : 0,
      };
    })
    .sort((a, b) => b.leads + b.scheduled - (a.leads + a.scheduled))
    .slice(0, TOP);

  return {
    totalLeads: fb.length,
    byPlacement: toRows(placement),
    byAudience: toRows(audience),
    byCreative,
    byKeyword: gs.length ? toRows(keyword) : undefined,
  };
}

/**
 * Per-(campaign|ad) / audience / keyword CRM attribution for a SALESFORCE
 * project, in the exact shape the REPORT's FB creative cards join on
 * (lib/reportCreatives → buildMeetLookups, keyed `${month}|${campaign}|${ad}`).
 *
 * Lives here (not in fbCreativeMeetingsExport) because everything it needs —
 * the Salesforce tab reader, crmAccountCandidates, the status matrix, the UTM
 * index — is already local. Salesforce exposes no meeting EVENTS table: a
 * lead's own resolved status (מצב ליד 3) IS its scheduled/held, so this is a
 * group-by over the project's leads by creation month, joined to the capture
 * sheet on phone→email.
 *
 * Returns per-month empties on any failure — the cards just render without a
 * CRM row, exactly as they do today.
 */
export async function getSalesforceCreativeMeetings(
  crmAccount: string,
  windows: { key: string; from: string; toExcl: string }[],
): Promise<
  Array<{
    key: string;
    creative: { campaign: string; ad: string; leads: number; scheduled: number; held: number }[];
    audience: { audience: string; leads: number; scheduled: number; held: number }[];
    keyword: { keyword: string; leads: number; scheduled: number; held: number }[];
  }>
> {
  const empty = () =>
    windows.map((w) => ({ key: w.key, creative: [], audience: [], keyword: [] }));
  try {
    const subjectEmail = driveFolderOwner();
    const { headers, rows } = await readSalesforce(subjectEmail);
    if (!rows.length) return empty();
    const iProject = headers.findIndex((h) => h.startsWith("פרויקט"));
    const iEntry = headers.findIndex((h) => h.startsWith("תאריך יצירה"));
    const iStatus = salesforceStatusIndex(headers);
    const iPhone = headers.indexOf("טלפון נייד");
    const iEmail = headers.indexOf("דואר אלקטרוני");
    if (iProject < 0 || iEntry < 0) return empty();
    const idx = await readSalesforceUtmIndex(subjectEmail);
    if (!idx.byPhone.size && !idx.byEmail.size) return empty();

    const targets = crmAccountCandidates(crmAccount).map(norm);
    type Rec = { leads: number; scheduled: number; held: number };
    type Bucket = {
      cre: Map<string, Rec & { camp: string; ad: string }>;
      aud: Map<string, Rec>;
      kw: Map<string, Rec>;
    };
    const perWin = new Map<string, Bucket>();
    for (const w of windows)
      perWin.set(w.key, { cre: new Map(), aud: new Map(), kw: new Map() });

    for (const row of rows) {
      const arr = row as unknown[];
      if (!targets.includes(norm(arr[iProject]))) continue;
      // Salesforce is a STATUS SNAPSHOT, not a dated event source, so the
      // window predicate is the lead's own creation DAY (it was its creation
      // MONTH — narrowing to the day is the same clipping the BMBY/Sehel paths
      // do, just at the granularity the caller now asks for). dateOnly returns
      // "" for unparseable cells; those match no window and are skipped,
      // exactly as a ""-keyed month lookup missed every bucket before.
      const d = dateOnly(arr[iEntry]);
      // Windows are ≤24 and non-overlapping, so a linear find beats building an
      // index and stays correct for bounds that aren't month-aligned.
      const win = d ? windows.find((x) => d >= x.from && d < x.toExcl) : undefined;
      const bucket = win ? perWin.get(win.key) : undefined;
      if (!bucket) continue; // lead created outside every requested window
      const u = lookupSfUtm(
        idx,
        iPhone >= 0 ? arr[iPhone] : "",
        iEmail >= 0 ? arr[iEmail] : "",
      );
      if (!u) continue;
      const st = String(arr[iStatus] ?? "").trim();
      const sched = SALESFORCE_SCHEDULED_STATUSES.has(st);
      const held = SALESFORCE_HELD_STATUSES.has(st);
      const bump = (r: Rec) => {
        r.leads++;
        if (sched) r.scheduled++;
        if (held) r.held++;
      };
      if (isSfFbSource(u.source)) {
        const camp = String(u.campaign ?? "").replace(/\s+/g, " ").trim();
        const ad = normAdName(u.creative);
        // Numeric Meta ids can't join the name-keyed ad rows — skip.
        if (camp && ad && !/^\d{8,}$/.test(camp) && !/^\d{8,}$/.test(ad)) {
          const k = `${camp}|${ad}`;
          let r = bucket.cre.get(k);
          if (!r) { r = { camp, ad, leads: 0, scheduled: 0, held: 0 }; bucket.cre.set(k, r); }
          bump(r);
        }
        if (u.audience) {
          let r = bucket.aud.get(u.audience);
          if (!r) { r = { leads: 0, scheduled: 0, held: 0 }; bucket.aud.set(u.audience, r); }
          bump(r);
        }
      } else if (isSfGoogleSource(u.source) && u.audience) {
        let r = bucket.kw.get(u.audience);
        if (!r) { r = { leads: 0, scheduled: 0, held: 0 }; bucket.kw.set(u.audience, r); }
        bump(r);
      }
    }

    return windows.map((w) => {
      const b = perWin.get(w.key)!;
      return {
        key: w.key,
        creative: [...b.cre.values()].map((r) => ({
          campaign: r.camp, ad: r.ad, leads: r.leads, scheduled: r.scheduled, held: r.held,
        })),
        audience: [...b.aud.entries()].map(([audience, r]) => ({
          audience, leads: r.leads, scheduled: r.scheduled, held: r.held,
        })),
        keyword: [...b.kw.entries()].map(([keyword, r]) => ({
          keyword, leads: r.leads, scheduled: r.scheduled, held: r.held,
        })),
      };
    });
  } catch {
    return empty();
  }
}

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
  const iStatus = salesforceStatusIndex(headers);
  // Only מצב ליד 3 folds the meeting's own status onto the lead, so it's the
  // only column that can tell a CANCELLED meeting from one that never got
  // booked. On the older columns the cancelled count isn't 0, it's UNKNOWN —
  // so leave the field absent there rather than reporting a confident "בוטלו 0".
  const hasMeetingStatuses = iStatus >= 0 && /^מצב ליד ?3$/.test(headers[iStatus]);
  const iSource = headers.indexOf("מקור ליד");
  const iObjection = headers.indexOf("התנגדות ראשית");
  // Conversion flag (הומר). Drives `contracts` instead of the status, because
  // the status column no longer reports it consistently: once מצב ליד 3
  // resolves a converted lead into its opportunity/meeting status, only the
  // converted leads that never got that far still read "טופס הרשמה".
  const iHomer = headers.indexOf("הומר");
  if (iProject < 0) return null;
  // UTM drill: Salesforce carries no usable utm_* itself, so join the
  // landing-page capture sheet on PHONE, falling back to EMAIL (either key can
  // be missing/malformed on either side — matching on only one silently drops
  // those leads). Empty indexes (sheet moved / no access) simply mean no panel;
  // the funnel is unaffected.
  const iPhone = headers.indexOf("טלפון נייד");
  const iEmail = headers.indexOf("דואר אלקטרוני");
  const emptyIdx: SfUtmIndex = {
    byPhone: new Map<string, SfUtm>(),
    byEmail: new Map<string, SfUtm>(),
  };
  const utmIdx =
    iPhone >= 0 || iEmail >= 0
      ? await readSalesforceUtmIndex(subjectEmail)
      : emptyIdx;
  const hasUtm = utmIdx.byPhone.size > 0 || utmIdx.byEmail.size > 0;
  const utmLeads: SfUtmLead[] = [];

  // Exact match on פרויקט (like BMBY) — verified the two Keys.CRM
  // account names match the Salesforce פרויקט values exactly. Multiple
  // comma-joined accounts (or a comma that's part of one name, like
  // "בית צורי 22,24") are handled by crmAccountCandidates — match ANY.
  const targets = crmAccountCandidates(crmAccount).map(norm);
  let leads = 0;
  let attemptedMeetings = 0; // ניסיון תיאום פגישה — cumulative, ⊇ scheduled
  let scheduledMeetings = 0; // תואמה פגישה (נקבעה או בוטלה פגישה)
  let canceledMeetings = 0;  // בוטלו — the cancelled subset of scheduled
  let meetings = 0;          // פגישות (התבצעה פגישה — held)
  let contacted = 0;
  let contracts = 0;         // טופסי הרשמה — the הומר conversion terminal
  const byStatus = new Map<string, number>();
  const byObjection = new Map<string, number>();
  const bySource = new Map<string, number>();
  const leadsBySource = new Map<string, number>();
  const contactedBySource = new Map<string, number>();
  const attemptedMeetingsBySource = new Map<string, number>();
  const scheduledMeetingsBySource = new Map<string, number>();
  const canceledMeetingsBySource = new Map<string, number>();
  const meetingsBySource = new Map<string, number>();
  const contractsBySource = new Map<string, number>();
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
  const dailyLeadTotals = new Map<string, number>();

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
    // Every dated in-window lead, source or not (CrmFunnel.dailyLeadTotals).
    {
      const day = dateOnly(arr[iEntry]);
      if (day) dailyLeadTotals.set(day, (dailyLeadTotals.get(day) || 0) + 1);
    }
    const st = String(arr[iStatus] ?? "").trim();
    // Funnel buckets per Maayan's status matrix (see the block above
    // SALESFORCE_STATUS_FUNNEL_ORDER). scheduledMeetings ⊇ meetings.
    const isAttemptedMeeting = SALESFORCE_ATTEMPTED_STATUSES.has(st);
    const isScheduledMeeting = SALESFORCE_SCHEDULED_STATUSES.has(st);
    const isCanceledMeeting = SALESFORCE_CANCELED_STATUSES.has(st);
    const isHeldMeeting = SALESFORCE_HELD_STATUSES.has(st);
    // contacted (נוצר קשר): any status past "חדש" (new/untouched).
    const isContacted = st !== "" && st !== "חדש";
    // contracts (טופסי הרשמה): the הומר flag. Falls back to the lead-side
    // label when the column is missing — identical counts, since every
    // converted lead reads "טופס הרשמה" in the unresolved מצב ליד column.
    const isConverted =
      iHomer >= 0 ? isTruthyFlag(arr[iHomer]) : st === "טופס הרשמה";
    if (isAttemptedMeeting) attemptedMeetings++;
    if (isScheduledMeeting) scheduledMeetings++;
    if (isCanceledMeeting) canceledMeetings++;
    if (isHeldMeeting) meetings++;
    if (isContacted) contacted++;
    if (isConverted) contracts++;
    // UTM drill: this lead's own resolved status IS its scheduled/held (status
    // snapshot — no meeting-events table), so credit it straight to its creative.
    if (hasUtm) {
      const u = lookupSfUtm(
        utmIdx,
        iPhone >= 0 ? arr[iPhone] : "",
        iEmail >= 0 ? arr[iEmail] : "",
      );
      if (u) {
        utmLeads.push({
          utm: u,
          scheduled: isScheduledMeeting,
          held: isHeldMeeting,
          objection: String(arr[iObjection] ?? "").trim(),
        });
      }
    }
    if (st) byStatus.set(st, (byStatus.get(st) || 0) + 1);
    const obj = String(arr[iObjection] ?? "").trim();
    if (obj) byObjection.set(obj, (byObjection.get(obj) || 0) + 1);
    const src = normSource(arr[iSource]);
    if (src) {
      bySource.set(src, (bySource.get(src) || 0) + 1);
      leadsBySource.set(src, (leadsBySource.get(src) || 0) + 1);
      if (isContacted) contactedBySource.set(src, (contactedBySource.get(src) || 0) + 1);
      if (isAttemptedMeeting) attemptedMeetingsBySource.set(src, (attemptedMeetingsBySource.get(src) || 0) + 1);
      if (isScheduledMeeting) scheduledMeetingsBySource.set(src, (scheduledMeetingsBySource.get(src) || 0) + 1);
      if (isCanceledMeeting) canceledMeetingsBySource.set(src, (canceledMeetingsBySource.get(src) || 0) + 1);
      if (isHeldMeeting) meetingsBySource.set(src, (meetingsBySource.get(src) || 0) + 1);
      if (isConverted) contractsBySource.set(src, (contractsBySource.get(src) || 0) + 1);
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

  if (leads === 0) return null;

  // UTM breakdown — populates the SAME `fbBreakdown` panel (+ keyword block)
  // BMBY/Sehel render. Window bounds scope the fb-ads spend join; with no
  // window we fall back to the observed lead-date span. Never fatal.
  let fbBreakdown: CrmFunnel["fbBreakdown"];
  if (utmLeads.length) {
    let from = minDate;
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
    } else if (maxDate) {
      const d = new Date(`${maxDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      toExcl = d.toISOString().slice(0, 10);
    }
    try {
      fbBreakdown = await buildSalesforceBreakdown(utmLeads, from, toExcl);
    } catch {
      /* spend/panel failure must never break the funnel */
    }
  }

  return {
    platform: "salesforce",
    crmAccount,
    fbBreakdown,
    // No meeting-events source: the maps are lead rows by current stage, and
    // there is nothing to date them by (the gathering-workbook meeting tab
    // carries no lead identity to join on) — "—" under the dated basis.
    meetingBasis: { lead: "status-snapshot", dated: null },
    leads,
    contacted,
    attemptedMeetings,
    scheduledMeetings,
    canceledMeetings: hasMeetingStatuses ? canceledMeetings : undefined,
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
      offFunnel: SALESFORCE_OFF_FUNNEL_STATUSES,
      leadsBySource, contactedBySource,
      attemptedMeetingsBySource,
      scheduledMeetingsBySource,
      canceledMeetingsBySource: hasMeetingStatuses ? canceledMeetingsBySource : undefined,
      meetingsBySource,
      contractsBySource,
      statusSourceMatrix, objectionSourceMatrix,
    }),
    dailyTimeSeries: buildDailyTimeSeries(dailySourceMatrix),
    dailyLeadTotals: Object.fromEntries(dailyLeadTotals),
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
    windowFrom: windowIso(window).from,
    windowTo: windowIso(window).to,
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
  offFunnel: readonly string[];
  leadsBySource: Map<string, number>;
  contactedBySource: Map<string, number>;
  /** Optional — Salesforce only; the cumulative "tried to book" superset. */
  attemptedMeetingsBySource?: Map<string, number>;
  scheduledMeetingsBySource: Map<string, number>;
  /** Optional — BMBY only; the cancelled subset of scheduled. */
  canceledMeetingsBySource?: Map<string, number>;
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
  // A status the canonical order does not know about goes in the
  // off-funnel set too: an unrecognised label has no knowable position in
  // the funnel, and assuming one would put its leads into the "reached
  // this stage or later" figure of every stage above it.
  const off = new Set([...args.offFunnel, ...tail]);
  return {
    allSources,
    statusFunnelOrder: [...ordered, ...tail],
    offFunnelStatuses: [...ordered, ...tail].filter((s) => off.has(s)),
    leadsBySource: toRec(args.leadsBySource),
    contactedBySource: toRec(args.contactedBySource),
    attemptedMeetingsBySource: args.attemptedMeetingsBySource
      ? toRec(args.attemptedMeetingsBySource)
      : undefined,
    scheduledMeetingsBySource: toRec(args.scheduledMeetingsBySource),
    canceledMeetingsBySource: args.canceledMeetingsBySource
      ? toRec(args.canceledMeetingsBySource)
      : undefined,
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
 * Collapse a funnel's per-`מקור הגעה` breakdown to per-canonical-channel
 * leads/scheduled/meetings, using the SAME canonicalMediaChannel grouping
 * the cost-join uses (a composite source like "facebook, google" counts
 * toward BOTH channels). Returns the aggregate map plus, per source, the
 * channel(s) it canonicalized to. The single source of truth for "how many
 * scheduled/held did each paid channel actually produce in this window" —
 * consumed by attachChannelCosts (CPL/CPS/CPM) and by /api/crm-funnel (so
 * the report can attribute real per-channel funnel stages instead of
 * splitting the totals by spend). Non-paid sources (phone/own-site/…)
 * canonicalize to null and contribute to no channel.
 *
 * scheduled / meetings come from the LEAD-ENTRY maps unless `maps` names
 * another set — attachChannelCosts passes `sm.dated` for the meeting-date
 * cost table. Leads are basis-free.
 */
export function funnelByCanonicalChannel(
  sm: CrmFunnel["sourceMatrices"],
  maps: CrmMeetingSourceMaps = sm,
): {
  byChannel: Record<string, { leads: number; scheduled: number; meetings: number }>;
  sourceChannels: Record<string, string[]>;
} {
  const byChannel: Record<
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
      if (!byChannel[c]) byChannel[c] = { leads: 0, scheduled: 0, meetings: 0 };
      byChannel[c].leads += sm.leadsBySource[src] || 0;
      byChannel[c].scheduled += maps.scheduledMeetingsBySource[src] || 0;
      byChannel[c].meetings += maps.meetingsBySource[src] || 0;
    }
  }
  return { byChannel, sourceChannels };
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
 *
 * Twice when the funnel has dated maps: channelCosts / costBySource off the
 * lead-entry maps, channelCostsDated / costBySourceDated off
 * `sourceMatrices.dated`. Spend, leads and CPL are the same in both.
 */
function attachChannelCosts(
  funnel: CrmFunnel,
  spendByChannel: Record<string, number>,
): void {
  const lead = channelCostsFor(funnel.sourceMatrices, funnel.sourceMatrices, spendByChannel);
  funnel.channelCosts = lead.channelCosts;
  funnel.costBySource = lead.costBySource;
  const datedMaps = funnel.sourceMatrices.dated;
  if (datedMaps) {
    const dated = channelCostsFor(funnel.sourceMatrices, datedMaps, spendByChannel);
    funnel.channelCostsDated = dated.channelCosts;
    funnel.costBySourceDated = dated.costBySource;
  }
}

function channelCostsFor(
  sm: CrmFunnel["sourceMatrices"],
  maps: CrmMeetingSourceMaps,
  spendByChannel: Record<string, number>,
): { channelCosts: CrmChannelCost[]; costBySource: Record<string, CrmSourceCost> } {
  const { byChannel: agg, sourceChannels } = funnelByCanonicalChannel(sm, maps);
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
  const byChannel = new Map(channelCosts.map((c) => [c.channel, c]));
  const costBySource: NonNullable<CrmFunnel["costBySource"]> = {};
  for (const [src, chans] of Object.entries(sourceChannels)) {
    if (chans.length !== 1) continue; // atomic single-channel sources only
    const c = byChannel.get(chans[0]);
    if (c && c.spend > 0)
      costBySource[src] = { channel: c.channel, cpl: c.cpl, cpm: c.cpm };
  }
  return { channelCosts, costBySource };
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
      // The warehouse funnel whether or not it wins — a Sheet win still takes
      // its meeting maps (D3, below).
      let whBuilt: BmbyWarehouseFunnel | null = null;
      try {
        const sheetFunnel = funnel;
        whBuilt = await computeBmbyFunnelFromWarehouse(crmAccount, window);
        const wh = whBuilt?.funnel;
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
            // Flagged because the objection tally now describes SHEET rows
            // while every other number on the card describes WAREHOUSE
            // rows. The counts stay comparable (the graft only runs when
            // wh.leads >= sheetFunnel.leads) but they are not the same
            // rows, so the card must not render this as "N of the M
            // leads".
            wh.objectionsGrafted = true;
          }
          funnel = wh;
        }
      } catch {
        /* keep the Sheet funnel */
        whBuilt = null;
      }
      // D3 (owner decision 2026-09-16): a card the Sheet won on leads still
      // counts its MEETINGS from the warehouse, on both bases — the Sheet
      // knows a lead's current status, not its meeting events, and a status
      // snapshot in the tiles is a third definition beside the ערוצים table
      // and the קמפיינים joins. Leads, contacts, statuses and objections stay
      // the Sheet's; the maps are the warehouse funnel's just built. Only
      // when the warehouse covers the window (warehouseCoversWindow) — a
      // project it has no project_id, journey or current leads for keeps
      // the snapshot, labelled as the fallback below. No window (noFilter —
      // alerts' objection read, the assistant's all-time tool) has no
      // period to count meetings for: the snapshot, unlabelled.
      if (
        funnel &&
        funnel.dataSource !== "warehouse" &&
        whBuilt &&
        warehouseCoversWindow(whBuilt.meetings, funnel)
      ) {
        applyBmbyWarehouseMeetings(funnel, whBuilt.meetings);
        // The פילוח פייסבוק drill needs warehouse UTM tags, which only the
        // warehouse funnel read; its leads column is therefore the
        // warehouse's fb leads, not the Sheet's.
        if (whBuilt.funnel.fbBreakdown) funnel.fbBreakdown = whBuilt.funnel.fbBreakdown;
      }
    }
    if (funnel && !funnel.meetingBasis) {
      // The Sheet's status snapshot is what the card shows. With a window,
      // that is D3's fallback (warehouse off, unreachable, no project_id, or
      // not covering the window); without one it is simply an unwindowed
      // read.
      funnel.meetingBasis = window
        ? { lead: "status-snapshot", dated: null, warehouseFallback: true }
        : { lead: "status-snapshot", dated: null };
    }
  } else if (platform === "salesforce") {
    funnel = await computeSalesforceFunnel(driveFolderOwner(), crmAccount, window);
  } else {
    funnel = await computeSehelFunnel(driveFolderOwner(), crmAccount, window);
    // Symmetric to the BMBY block above: prefer the Sehel warehouse funnel
    // when its (separate) flag is on and it's at least as complete as the
    // Sheet on lead count. Window-scoped, so keep the Sheet's project-wide
    // stale tally; the warehouse carries its own (window-scoped) objections.
    // Never throws — a warehouse hiccup leaves the Sheet funnel intact.
    if (useSupabaseSehelWarehouse() && supabaseCrmProjectAllowed(crmAccount)) {
      try {
        const sheetFunnel = funnel;
        const whBuilt = await computeSehelFunnelFromWarehouse(crmAccount, window);
        const wh = whBuilt?.funnel;
        // sehel_meetings sync gap (2026-07): some projects have warehouse LEADS
        // but NO warehouse meetings yet (כוכב הצפון אשדוד / תדהר / רייסדור /
        // קיימא — see SEHEL_MEETINGS_SYNC_GAP.md). Superseding those would
        // zero-out real meetings the Sheet still has. So take the warehouse only
        // when it actually carries meetings — OR the Sheet also has none (no
        // regression either way). Complete projects (CAZAR / אפרידר / HaGada /
        // ברוריה) still win; the rest stay on the Sheet until Nadav backfills.
        // "Carries meetings" is read off the DATED window count, which is what
        // the tiles showed when this test was written; the tiles moved to the
        // registration cohort (2026-09-16) but the routing did not.
        const whMeetings = whBuilt
          ? whBuilt.datedWindow.scheduled + whBuilt.datedWindow.held
          : 0;
        const sheetMeetings =
          (sheetFunnel?.scheduledMeetings ?? 0) + (sheetFunnel?.meetings ?? 0);
        if (
          wh &&
          wh.leads > 0 &&
          (!sheetFunnel || wh.leads >= sheetFunnel.leads) &&
          (whMeetings > 0 || sheetMeetings === 0)
        ) {
          if (sheetFunnel) wh.staleLeads = sheetFunnel.staleLeads;
          funnel = wh;
        } else if (funnel && whBuilt?.dated) {
          // The Sheet kept the card. Its lead-entry tiles stay the Sheet's
          // stage snapshot (D3 is BMBY's), but the warehouse's dated
          // meetings exist for the window, so the dated basis has a source.
          const sm = funnel.sourceMatrices;
          sm.dated = whBuilt.dated.maps;
          funnel.dailyDated = whBuilt.dated.daily;
          extendAllSources(sm, [sm.dated.scheduledMeetingsBySource]);
          funnel.meetingBasis = { lead: "status-snapshot", dated: "sehel-events" };
        }
      } catch {
        /* keep the Sheet funnel */
      }
    }
    if (funnel && !funnel.meetingBasis) {
      funnel.meetingBasis = { lead: "status-snapshot", dated: null };
    }
  }
  // Attribute media cost onto the lead sources (anda model) when spend
  // was supplied for this window. After every meeting map is final (the
  // D3 graft above), so the cost table and the tiles count the same events.
  if (funnel && args.spendByChannel && Object.keys(args.spendByChannel).length) {
    attachChannelCosts(funnel, args.spendByChannel);
  }
  // Freshness note — does the data reach the (clamped) end of the selected
  // window? Computed at the single exit point so it covers every path
  // (sheet/warehouse/cost-joined) off the final funnel's own dateRange.
  if (funnel) {
    funnel.dataLagThrough = dataFreshnessLag(window, funnel.dateRange.to);
  }
  return funnel;
}
