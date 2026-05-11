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
  /** Top-N status buckets, sorted by count desc. UI displays as a
   *  horizontal stacked bar. */
  byStatus: { label: string; count: number }[];
  /** Top-5 objections by count. Many rows have no objection text — those
   *  are excluded from this list (they show up in `leads` but not here). */
  topObjections: { label: string; count: number }[];
  /** Top-5 salespeople by lead count. BMBY only — Sehel doesn't carry
   *  a salesperson column. Empty for sehel. */
  topSellers: { label: string; count: number }[];
  /** Top-5 source values (BMBY `מקור הגעה`, Sehel `מקור הגעה`). Useful
   *  for spot-checking which ad / channel string the CRM is logging. */
  topSources: { label: string; count: number }[];
  /** Cross-tab: top-5 objections × top-5 sources within this project.
   *  For each objection, shows how those leads broke down across
   *  acquisition sources — so the user can see e.g. "מחיר was 50% טלפון
   *  and 31% רדיו" rather than just the totals. The `sources` array per
   *  objection is sorted by count desc; an "other" bucket aggregates
   *  remaining sources into a single segment so the percentages always
   *  sum to 100%. Empty when the project has no objection text at all. */
  objectionsBySource: {
    objection: string;
    total: number;
    sources: { source: string; count: number; isOther?: boolean }[];
  }[];
  /** Transpose of the above for the pie-per-source picker section: for
   *  each top-N source (by total leads where an objection was captured),
   *  the breakdown of which objections those leads ran into. `total` is
   *  the total leads from that source that had any objection text;
   *  `topObjections` rolls beyond-top-N counts into an "אחר" bucket so
   *  the pie always closes to 100%. */
  sourceBreakdown: {
    source: string;
    total: number;
    topObjections: { label: string; count: number; isOther?: boolean }[];
  }[];
  /** Per-KPI source-distribution pies, rendered as hover tooltips on
   *  each KPI tile. Same top-N + "אחר" rest-bucket shape as
   *  `sourceBreakdown` entries so the UI can share the conic-gradient
   *  renderer. Each entry's `total` = the KPI's headline number, and
   *  `sources` sums to that total. Empty array when the KPI is 0 or
   *  has no source attribution (e.g. all matching rows had blank
   *  `מקור הגעה`). */
  kpiSourceBreakdowns: {
    leads: { source: string; count: number; isOther?: boolean }[];
    contacted: { source: string; count: number; isOther?: boolean }[];
    scheduledMeetings: { source: string; count: number; isOther?: boolean }[];
    meetings: { source: string; count: number; isOther?: boolean }[];
  };
  /** Earliest and latest dates seen in the matched rows (formatted
   *  YYYY-MM-DD). Surfaces upstream freshness — when the latest date
   *  is more than a few days behind today, the upstream pipeline has
   *  paused. */
  dateRange: { from: string; to: string };
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

function topN<T extends { count: number }>(map: Map<string, number>, n: number): { label: string; count: number }[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, count]) => ({ label, count }));
}

/**
 * Top-N entries plus an `אחר` rest bucket aggregating the tail. Used for
 * the KPI-tile hover pies where percentages must sum to 100% of the
 * source map's total. Empty map → empty array (UI hides the popover).
 */
function topNWithRest(
  map: Map<string, number>,
  n: number,
): { source: string; count: number; isOther?: boolean }[] {
  if (map.size === 0) return [];
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, n);
  const tail = sorted.slice(n).reduce((acc, [, c]) => acc + c, 0);
  const out: { source: string; count: number; isOther?: boolean }[] =
    head.map(([source, count]) => ({ source, count }));
  if (tail > 0) out.push({ source: "אחר", count: tail, isOther: true });
  return out;
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
    return new Date(ms).toISOString().slice(0, 10);
  }
  return raw.slice(0, 10);
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
  // For each objection, a map of source → count. We materialize this only
  // for rows where BOTH an objection AND a source are present (otherwise
  // the cross-tab adds noise without information).
  const objectionSourceMatrix = new Map<string, Map<string, number>>();
  let minDate = "";
  let maxDate = "";

  for (const row of rows) {
    const arr = row as unknown[];
    const proj = norm(arr[iProject]);
    if (proj !== target) continue;
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
    const d = dateOnly(arr[iEntry]);
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
    byStatus: topN(byStatus, 8),
    topObjections: topN(byObjection, 5),
    // איש מכירות column dropped in the 2026-05-12 schema migration —
    // no seller breakdown anymore; UI already handles empty cleanly.
    topSellers: [],
    topSources: topN(bySource, 5),
    objectionsBySource: buildObjectionsBySource(byObjection, objectionSourceMatrix),
    sourceBreakdown: buildSourceBreakdown(objectionSourceMatrix),
    kpiSourceBreakdowns: {
      leads: topNWithRest(leadsBySource, 5),
      contacted: topNWithRest(contactedBySource, 5),
      scheduledMeetings: topNWithRest(scheduledMeetingsBySource, 5),
      meetings: topNWithRest(meetingsBySource, 5),
    },
    dateRange: { from: minDate, to: maxDate },
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
  const objectionSourceMatrix = new Map<string, Map<string, number>>();
  let minDate = "";
  let maxDate = "";

  for (const row of rows) {
    const arr = row as unknown[];
    const proj = norm(arr[iProject]);
    if (!proj.startsWith(targetPrefix)) continue;
    // Defensive: require either exact match OR a word boundary after the
    // prefix (so "אורנבך 11" doesn't accidentally match "אורנבך 111").
    if (proj !== targetPrefix && proj[targetPrefix.length] !== " ") continue;
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
    const d = dateOnly(arr[iRegDate]);
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
    byStatus: topN(byStatus, 8),
    topObjections: topN(byObjection, 5),
    topSellers: [], // Sehel doesn't carry a salesperson column we trust
    topSources: topN(bySource, 5),
    objectionsBySource: buildObjectionsBySource(byObjection, objectionSourceMatrix),
    sourceBreakdown: buildSourceBreakdown(objectionSourceMatrix),
    kpiSourceBreakdowns: {
      leads: topNWithRest(leadsBySource, 5),
      contacted: topNWithRest(contactedBySource, 5),
      scheduledMeetings: topNWithRest(scheduledMeetingsBySource, 5),
      meetings: topNWithRest(meetingsBySource, 5),
    },
    dateRange: { from: minDate, to: maxDate },
    monthFilter,
  };
}

/**
 * Transpose the objection×source matrix into per-source pies. For each
 * source (sorted by total objection-attributed leads), gathers its top-6
 * objections + an "אחר" rest bucket so the pie closes to 100%.
 */
function buildSourceBreakdown(
  matrix: Map<string, Map<string, number>>,
): CrmFunnel["sourceBreakdown"] {
  const TOP_SOURCES = 8;
  const TOP_OBJECTIONS_PER_SOURCE = 6;
  // Flip the nested map: source → (objection → count).
  const flipped = new Map<string, Map<string, number>>();
  for (const [objection, sources] of matrix) {
    for (const [source, count] of sources) {
      let m = flipped.get(source);
      if (!m) { m = new Map<string, number>(); flipped.set(source, m); }
      m.set(objection, (m.get(objection) || 0) + count);
    }
  }
  // Total objection-attributed leads per source.
  const sources = [...flipped.entries()].map(([source, objMap]) => {
    const total = [...objMap.values()].reduce((a, b) => a + b, 0);
    return { source, objMap, total };
  });
  sources.sort((a, b) => b.total - a.total);
  return sources.slice(0, TOP_SOURCES).map(({ source, objMap, total }) => {
    const sorted = [...objMap.entries()].sort((a, b) => b[1] - a[1]);
    const head = sorted.slice(0, TOP_OBJECTIONS_PER_SOURCE);
    const tail = sorted.slice(TOP_OBJECTIONS_PER_SOURCE).reduce((n, [, c]) => n + c, 0);
    const topObjections: { label: string; count: number; isOther?: boolean }[] =
      head.map(([label, count]) => ({ label, count }));
    if (tail > 0) topObjections.push({ label: "אחר", count: tail, isOther: true });
    return { source, total, topObjections };
  });
}

/**
 * Shape the objection × source cross-tab for display: pick top-5 objections,
 * and for each, project its source counts into "top-N + other" so the bar
 * is human-readable and totals reconcile to the objection's overall count.
 */
function buildObjectionsBySource(
  byObjection: Map<string, number>,
  matrix: Map<string, Map<string, number>>,
): CrmFunnel["objectionsBySource"] {
  const TOP_OBJECTIONS = 5;
  const TOP_SOURCES_PER_OBJECTION = 4;
  const top = [...byObjection.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_OBJECTIONS);
  return top
    .map(([objection, total]) => {
      const srcMap = matrix.get(objection) || new Map<string, number>();
      const sorted = [...srcMap.entries()].sort((a, b) => b[1] - a[1]);
      const head = sorted.slice(0, TOP_SOURCES_PER_OBJECTION);
      const tailCount = sorted
        .slice(TOP_SOURCES_PER_OBJECTION)
        .reduce((n, [, c]) => n + c, 0);
      const sources: { source: string; count: number; isOther?: boolean }[] =
        head.map(([source, count]) => ({ source, count }));
      if (tailCount > 0) {
        sources.push({ source: "אחר", count: tailCount, isOther: true });
      }
      return { objection, total, sources };
    })
    .filter((x) => x.sources.length > 0); // skip objections with no source attribution
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
