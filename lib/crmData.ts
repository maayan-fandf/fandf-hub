/**
 * CRM-funnel data for the project overview page.
 *
 * Data source: the external "Consolidated" workbook (env CRM_SHEET_ID,
 * default 1YOL2Rry…), which aggregates per-lead data from the two CRMs
 * F&F's clients use — BMBY and Sehel. Updated by an upstream pipeline
 * (currently daily; the workbook owner controls the cadence). The hub
 * is a read-only consumer.
 *
 * Join model: Keys (the dashboard's canonical project registry) carries
 * two columns — `CRM` (the account name in the external CRM, e.g.
 * "אפרידר גינות רחובות") and `CRM platform` ("bmby" or "sehel"). Each
 * project resolves to AT MOST one (platform, account) pair; CRM rows
 * whose `פרויקט` doesn't match any Keys.CRM are ignored (orphan
 * projects upstream that haven't been onboarded yet — Maayan's call).
 *
 * Caching layers, matching lib/keys.ts:
 *   1. `unstable_cache` cross-request, 5 min TTL — avoids hammering
 *      Sheets quota when many users hit project pages near-simultaneously.
 *      The CRM workbook only updates daily so 5 min stale is fine.
 *   2. React `cache()` per-request dedup — multiple components on the
 *      same page can call into this without paying for the read twice.
 *
 * NB: The 5-min cross-request cache is acceptable here despite the App
 * Hosting tag-propagation issue (feedback_unstable_cache_multi_instance)
 * because CRM data is steady-state — once a project is set up its rows
 * exist continuously, and "stale by 5 min" never means "blank for a
 * day." Contrast with findProjectFolderUrl which we had to drop the
 * cross-request layer on because new projects routinely cache `null`.
 */
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { sheetsClient } from "@/lib/sa";
import { driveFolderOwner } from "@/lib/sa";
import { readKeysCached } from "@/lib/keys";

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
const CACHE_TTL_SECONDS = 5 * 60;

export type CrmPlatform = "bmby" | "sehel";

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
  /** When the caller passed a monthFilter, this is the exact "YYYY-MM"
   *  used to filter rows. Empty string means no filter was applied (all
   *  available data shown). UI uses this to render the filter chip. */
  monthFilter: string;
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
// migration probe and grows; A:AA covers all 27 cols.
const fetchBmbyCrossRequest = unstable_cache(
  (subjectEmail: string) => fetchTabFromSheet(subjectEmail, "מאגר במבי!A:AA"),
  ["crm-bmby"],
  { revalidate: CACHE_TTL_SECONDS, tags: ["crm-data"] },
);
// Sehel: header is row 1 (the old workbook had a merged banner above
// it — the new "מאגר שכל" tab dropped that). Open-ended; ~29K rows at
// migration, A:T covers all 20 named cols.
const fetchSehelCrossRequest = unstable_cache(
  (subjectEmail: string) => fetchTabFromSheet(subjectEmail, "מאגר שכל!A:T"),
  ["crm-sehel"],
  { revalidate: CACHE_TTL_SECONDS, tags: ["crm-data"] },
);

const readBmby = cache((subjectEmail: string) => fetchBmbyCrossRequest(subjectEmail));
const readSehel = cache((subjectEmail: string) => fetchSehelCrossRequest(subjectEmail));

/* ── Utility ────────────────────────────────────────────────────────── */

function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
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
const STALE_LEAD_DAYS = 14;

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
  // dd-mm-yyyy
  const m = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
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
  monthFilter: string,
): Promise<CrmFunnel | null> {
  const { headers, rows } = await readBmby(subjectEmail);
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

  const target = norm(crmAccount);
  let leads = 0;
  let scheduledMeetings = 0; // תואמה פגישה — broad, includes cancelled
  let meetings = 0;          // פגישות — narrow, actually-held only
  let contacted = 0;
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
    if (proj !== target) continue;

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

    // Month filter — apply before everything else so KPIs, status,
    // objections, etc. are all consistent against the same row cohort.
    if (monthFilter && iEntry >= 0) {
      const d = dateOnly(arr[iEntry]);
      if (!d.startsWith(monthFilter)) continue;
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
    if (isScheduledMeeting) scheduledMeetings++;
    if (isHeldMeeting) meetings++;
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
    monthFilter,
  };
}

/* ── Sehel funnel ──────────────────────────────────────────────────── */

async function computeSehelFunnel(
  subjectEmail: string,
  crmAccount: string,
  monthFilter: string,
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
  const targetPrefix = norm(crmAccount);
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
    if (!proj.startsWith(targetPrefix)) continue;
    // Defensive: require either exact match OR a word boundary after the
    // prefix (so "אורנבך 11" doesn't accidentally match "אורנבך 111").
    if (proj !== targetPrefix && proj[targetPrefix.length] !== " ") continue;

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

    // Month filter — applied against תאריך רישום, same field we use for
    // the displayed dateRange.
    if (monthFilter && iRegDate >= 0) {
      const d = dateOnly(arr[iRegDate]);
      if (!d.startsWith(monthFilter)) continue;
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

  if (leads === 0) return null;
  return {
    platform: "sehel",
    crmAccount,
    leads,
    contacted,
    scheduledMeetings,
    meetings,
    meetingRatePct: leads > 0 ? (meetings / leads) * 100 : null,
    topSellers: [], // Sehel doesn't carry a salesperson column we trust
    sourceMatrices: buildSourceMatrices({
      allSourcesMap: bySource,
      statusObserved: byStatus,
      funnelOrder: SEHEL_STATUS_FUNNEL_ORDER,
      leadsBySource, contactedBySource,
      scheduledMeetingsBySource, meetingsBySource,
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
    monthFilter,
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
    statusBySource: toRec2(args.statusSourceMatrix),
    objectionBySource: toRec2(args.objectionSourceMatrix),
  };
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
 * `monthFilter`, when provided as "YYYY-MM", restricts rows to that
 * calendar month against BMBY's תאריך כניסה or Sehel's תאריך רישום.
 * When omitted, defaults to the **current Asia/Jerusalem calendar
 * month** so the CRM numbers match the dashboard's default view
 * (which renders current-month in "live" mode). Pass an explicit ""
 * via the `noFilter` escape hatch if you ever need all-time data.
 *
 * Caller wraps in <Suspense fallback={null}>; null return collapses
 * the card cleanly.
 */
export async function getCrmFunnelForProject(args: {
  company: string;
  project: string;
  /** "YYYY-MM". Empty/undefined → defaults to the current calendar
   *  month in Asia/Jerusalem (matches the dashboard's default view). */
  monthFilter?: string;
  /** Explicit escape hatch: set true to disable the month filter and
   *  return all available rows (~60 days). Use for admin/debug
   *  surfaces; not exposed in the UI. */
  noFilter?: boolean;
}): Promise<CrmFunnel | null> {
  const company = args.company.trim();
  const project = args.project.trim();
  const rawMonthFilter = (args.monthFilter || "").trim();
  // Validate format defensively — caller may pass URL search-param string.
  const explicitMonth = /^\d{4}-\d{2}$/.test(rawMonthFilter) ? rawMonthFilter : "";
  // Default behavior: if no explicit month was passed AND noFilter
  // wasn't requested, fall back to current calendar month.
  const validMonthFilter = args.noFilter
    ? ""
    : (explicitMonth || currentMonthIL());
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
  if (!crmAccount || (platform !== "bmby" && platform !== "sehel")) {
    return null;
  }

  if (platform === "bmby") {
    return computeBmbyFunnel(driveFolderOwner(), crmAccount, validMonthFilter);
  }
  return computeSehelFunnel(driveFolderOwner(), crmAccount, validMonthFilter);
}
