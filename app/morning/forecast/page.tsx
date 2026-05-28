import { redirect } from "next/navigation";
import Link from "next/link";
import {
  currentUserEmail,
  getMorningFeed,
  getMyProjects,
} from "@/lib/appsScript";
import {
  getCurrentMonthlyRows,
  getMonthlyRowsForYearMonth,
  previousYearMonth,
  type AllClientsRow,
} from "@/lib/allClients";
import { readKeysCached } from "@/lib/keys";
import { driveFolderOwner } from "@/lib/sa";
import {
  readAllManagementFees,
  getFeePercentForRow,
} from "@/lib/managementFees";
import CampaignsTabs from "@/components/CampaignsTabs";
import ManagementFeeCell from "@/components/ManagementFeeCell";
import SearchableMultiSelectFilter from "@/components/SearchableMultiSelectFilter";
import ForecastMonthPicker from "@/components/ForecastMonthPicker";

export const dynamic = "force-dynamic";

/**
 * /morning/forecast — admin-only month-end spend snapshot.
 *
 * Iteration 2 (2026-05-27): owner wanted a simpler view —
 * just budget vs spend, no extrapolated forecast / variance chrome.
 * Grouped by `מנהל קמפיינים` (Keys' campaign-manager column), with
 * filters for company / project / channel. Project name pulled from
 * Keys' `פרוייקט` column (joined via slug since ALL CLIENTS' project
 * column is often blank post-XLOOKUP migration).
 *
 * Data source: ALL CLIENTS rows with rowType="חודשי" whose window
 * contains today.
 */

/** Aggregated metrics across a slice of EnrichedRows. Mirrored on
 *  every rollup level (project / company / manager / grand total) so
 *  the rendering surface only ever pulls from this consistent shape. */
type GroupTotals = {
  totalSpend: number;
  totalBudget: number;
  totalFeeActual: number;
  totalFeeBudget: number;
  totalLeads: number;
  totalScheduled: number;
  totalMeetings: number;
};

type EnrichedRow = {
  slug: string;
  projectName: string;
  company: string;
  campaignManager: string;
  channel: string;
  spend: number;
  budget: number;
  /** Lead-count from ALL CLIENTS' `לידים CRM` column. Used by the
   *  "חודש קודם" view's optional metrics toggle, otherwise 0 / unused. */
  leads: number;
  /** תיאומים — meeting tie-ups + cancellations (`תיאום וביטול`). */
  scheduled: number;
  /** ביצועים — meetings actually held (`ביצוע פגישות`). */
  meetings: number;
  /** Spend ÷ budget × 100. Returns null when budget is 0 — we
   *  render "—" in that case rather than a misleading 0% or ∞. */
  utilizationPct: number | null;
  /** Management-fee percent for this (slug, channel). Server-
   *  resolved with the 15% default when no Firestore override exists. */
  feePercent: number;
  /** Computed fee in ILS based on ACTUAL spend = spend × feePercent / 100.
   *  Server-side so the per-manager + grand totals can include it
   *  without re-deriving on the client. */
  feeIlsActual: number;
  /** Computed fee in ILS based on the APPROVED BUDGET = budget × fee%.
   *  Pairs with feeIlsActual so the forecast view can show
   *  "expected fee at month-end" alongside "fee earned so far." */
  feeIlsBudget: number;
};

function fmtIls(n: number): string {
  const v = Math.round(n);
  return `₪${v.toLocaleString("he-IL")}`;
}
function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${Math.round(n)}%`;
}
/** Plain integer formatter (Hebrew thousands separators), no ₪ prefix.
 *  Used for the metrics columns (leads / scheduled / meetings counts). */
function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("he-IL");
}
/** ₪-formatted value or "—" when the underlying ratio was 0-divided.
 *  Used by the cost-per-result columns in the prev-month metrics view. */
function fmtIlsNullable(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return fmtIls(n);
}

/** Split a comma-separated multi-select param into a Set of trimmed,
 *  non-empty values. Empty string / missing param → empty Set (which
 *  semantically means "no filter — accept everything"). */
function parseMultiSelect(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

type SpShape = {
  company?: string;
  project?: string;
  channel?: string;
  sort?: string;
  dir?: string;
  grouping?: string;
  q?: string;
  /** "current" (default — month windows containing today, full forecast
   *  columns) or "previous" (historical monthly rows, spend-only
   *  columns + optional metrics). */
  view?: string;
  /** "1" → render the leads/scheduled/meetings columns (with
   *  ₪/result cost columns next to each) in previous-month view.
   *  No-op in current-month view. */
  metrics?: string;
  /** YYYY-MM. When `view=previous`, this is the month to load. Falls
   *  back to the immediately-prior calendar month when missing or
   *  malformed. No-op in current-month view (which always reads "today"). */
  month?: string;
};

/** Build an URLSearchParams string that preserves the current sp +
 *  applies overrides (empty string overrides DROP the param). Used
 *  by the grouping toggle + (indirectly) by SortHeader. */
function buildHref(sp: SpShape, overrides: Partial<SpShape>): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (v) merged[k] = String(v);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === "" || v == null) delete merged[k];
    else merged[k] = String(v);
  }
  return new URLSearchParams(merged).toString();
}

const UNASSIGNED = "(ללא מנהל)";
const UNKNOWN_COMPANY = "(לא מזוהה)";

export default async function ForecastPage({
  searchParams,
}: {
  searchParams: Promise<{
    company?: string;
    project?: string;
    channel?: string;
    sort?: string;
    dir?: string;
    grouping?: string;
    q?: string;
    view?: string;
    metrics?: string;
    month?: string;
  }>;
}) {
  const me = await currentUserEmail().catch(() => "");
  if (!me) redirect("/signin?next=/morning/forecast");

  const projectsData = await getMyProjects().catch(() => null);
  if (!projectsData?.isAdmin) redirect("/morning");

  const sp = await searchParams;
  // Multi-select filters (2026-05-27 iter 4) — URL carries
  // comma-separated values, e.g. `?company=A,B&channel=facebook,google`.
  // Empty Set = "no filter".
  const fCompany = parseMultiSelect(sp.company);
  const fProject = parseMultiSelect(sp.project);
  const fChannel = parseMultiSelect(sp.channel);
  // Free-text search (iter 7). Matches case-insensitively against
  // project / company / channel / manager names — substring match,
  // no fuzzy fancy stuff. Empty string = no search filter.
  const fQuery = (sp.q || "").trim().toLowerCase();
  // Grouping mode (iter 5). `flat` collapses the manager → company →
  // project nesting into a single sortable table so the user can,
  // e.g. "show me every channel sorted by spend regardless of who
  // runs it." Default (any other value) keeps the nested view.
  const groupingMode = sp.grouping === "flat" ? "flat" : "default";

  // View toggle (2026-05-28). "current" = month-in-progress windows
  // (existing forecast view, full column set). "previous" = the
  // immediately-prior calendar month's monthly rows, spend-only by
  // default. The metrics toggle below adds לידים / תיאומים / ביצועים
  // + ₪/result cost columns for the retrospective view; it's a no-op
  // in current-month mode (those metrics aren't part of the forecast
  // story).
  const viewMode: "current" | "previous" =
    sp.view === "previous" ? "previous" : "current";
  const showMetrics = sp.metrics === "1";

  // Sort state. The alpha columns (project / company / manager) only
  // show in flat mode — in grouped mode they're grouping keys, not
  // columns — but the type union covers both modes so the URL state
  // is shareable across the toggle. Falls back to "spend / desc".
  type SortCol =
    | "channel"
    | "spend"
    | "budget"
    | "utilizationPct"
    | "feePct"
    | "feeIlsBudget"
    | "feeIlsActual"
    | "leads"
    | "scheduled"
    | "meetings"
    | "costPerLead"
    | "costPerScheduled"
    | "costPerMeeting"
    | "project"
    | "company"
    | "manager";
  type SortDir = "asc" | "desc";
  const ALLOWED_SORTS: ReadonlySet<SortCol> = new Set<SortCol>([
    "channel",
    "spend",
    "budget",
    "utilizationPct",
    "feePct",
    "feeIlsBudget",
    "feeIlsActual",
    "leads",
    "scheduled",
    "meetings",
    "costPerLead",
    "costPerScheduled",
    "costPerMeeting",
    "project",
    "company",
    "manager",
  ]);
  const rawSort = String(sp.sort || "").trim();
  const sortCol: SortCol = (ALLOWED_SORTS.has(rawSort as SortCol)
    ? rawSort
    : "spend") as SortCol;
  const sortDir: SortDir = sp.dir === "asc" ? "asc" : "desc";

  const subjectEmail = driveFolderOwner();
  const todayIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
  }).format(new Date());
  // YYYY-MM for the prev-calendar-month — the natural default + the
  // picker's upper bound (no point showing "current month or future"
  // in the prev-month view).
  const prevYm = previousYearMonth(todayIso);
  // User-selected target month for `view=previous`. Accepts any well-
  // formed YYYY-MM; rejects today / future months by clamping to
  // prevYm (otherwise prev-month view would double up with the
  // current-month view). Malformed → default to prevYm.
  const MONTH_RX = /^\d{4}-(0[1-9]|1[0-2])$/;
  const rawMonth = (sp.month || "").trim();
  const selectedMonth =
    viewMode === "previous"
      ? rawMonth && MONTH_RX.test(rawMonth) && rawMonth <= prevYm
        ? rawMonth
        : prevYm
      : prevYm;

  const [monthlyRows, keys, feeMap, morning] = await Promise.all([
    viewMode === "previous"
      ? getMonthlyRowsForYearMonth(subjectEmail, selectedMonth).catch(
          () => [] as AllClientsRow[],
        )
      : getCurrentMonthlyRows(subjectEmail, todayIso).catch(
          () => [] as AllClientsRow[],
        ),
    readKeysCached(subjectEmail).catch(
      () => ({ headers: [] as string[], rows: [] as unknown[][] }),
    ),
    readAllManagementFees().catch(() => new Map<string, number>()),
    // Pull morning feed once to get per-project sheetTabUrl (the
    // hyperlink on Keys' `campaign ID` column → the project's tab
    // in the master sheet). Cheap on warm cache; soft-fail to empty
    // so the page still renders if the feed is unreachable.
    getMorningFeed({ scope: "all" }).catch(() => null),
  ]);
  // slug → tab URL. Empty when the feed is unreachable; the
  // sheet icon then simply doesn't render for that row.
  const sheetUrlBySlug = new Map<string, string>();
  if (morning?.projects) {
    for (const p of morning.projects) {
      const key = (p.slug || "").toLowerCase().trim();
      if (key && p.sheetTabUrl) sheetUrlBySlug.set(key, p.sheetTabUrl);
    }
  }

  // slug → { projectName, company, campaignManager } from Keys.
  // The slug ("campaign ID" column) is the canonical join because
  // ALL CLIENTS' Hebrew name column is often blank post-XLOOKUP
  // migration (2026-05-01). Keys carries the authoritative name in
  // `פרוייקט`, the company in `חברה`, and the manager in
  // `מנהל קמפיינים`.
  type KeyMeta = { projectName: string; company: string; campaignManager: string };
  const metaBySlug = new Map<string, KeyMeta>();
  const metaByProjectName = new Map<string, KeyMeta>();
  {
    const headers = keys.headers || [];
    const iProj = headers.indexOf("פרוייקט");
    const iCo = headers.indexOf("חברה");
    const iSlug = headers.indexOf("campaign ID");
    const iMgr = headers.indexOf("מנהל קמפיינים");
    for (const row of keys.rows || []) {
      const proj = String(row[iProj] ?? "").trim();
      const co = String(row[iCo] ?? "").trim();
      const slug = iSlug >= 0 ? String(row[iSlug] ?? "").trim() : "";
      const mgr = iMgr >= 0 ? String(row[iMgr] ?? "").trim() : "";
      if (!proj && !slug) continue;
      const meta: KeyMeta = {
        projectName: proj || slug,
        company: co,
        campaignManager: mgr,
      };
      if (slug) metaBySlug.set(slug.toLowerCase(), meta);
      if (proj) metaByProjectName.set(proj.toLowerCase(), meta);
    }
  }

  // Enrich every monthly row with Keys-derived metadata. Rows whose
  // slug doesn't resolve in Keys fall back to whatever ALL CLIENTS
  // gave us (slug as the displayed name, unknown company / unassigned
  // manager). Better than silently dropping.
  const enriched: EnrichedRow[] = monthlyRows.map((r) => {
    const slugKey = (r.projectSlug || "").toLowerCase();
    const projKey = (r.project || "").toLowerCase();
    const meta =
      metaBySlug.get(slugKey) ||
      metaByProjectName.get(projKey) ||
      ({
        projectName: r.project || r.projectSlug || "(ללא שם)",
        company: UNKNOWN_COMPANY,
        campaignManager: UNASSIGNED,
      } satisfies KeyMeta);
    const channel = r.channel || "(ללא ערוץ)";
    const feePercent = getFeePercentForRow(feeMap, r.projectSlug, channel);
    const feeIlsActual = (r.spend * feePercent) / 100;
    const feeIlsBudget = (r.budget * feePercent) / 100;
    const utilizationPct = r.budget > 0 ? (r.spend / r.budget) * 100 : null;
    return {
      slug: r.projectSlug,
      projectName: meta.projectName,
      company: meta.company || UNKNOWN_COMPANY,
      campaignManager: meta.campaignManager || UNASSIGNED,
      channel,
      spend: r.spend,
      budget: r.budget,
      leads: r.leads,
      scheduled: r.scheduled,
      meetings: r.meetings,
      utilizationPct,
      feePercent,
      feeIlsActual,
      feeIlsBudget,
    };
  });

  // Distinct filter options derived from the enriched rows — so the
  // dropdowns only ever list values that actually exist in the
  // current-month data set. (Avoids dead options that always return
  // 0 results.)
  const collator = new Intl.Collator("he");
  const distinctCompanies = Array.from(
    new Set(enriched.map((r) => r.company).filter(Boolean)),
  ).sort(collator.compare);
  const distinctProjects = Array.from(
    new Set(enriched.map((r) => r.projectName).filter(Boolean)),
  ).sort(collator.compare);
  const distinctChannels = Array.from(
    new Set(enriched.map((r) => r.channel).filter(Boolean)),
  ).sort(collator.compare);

  const filtered = enriched.filter((r) => {
    if (fCompany.size > 0 && !fCompany.has(r.company)) return false;
    if (fProject.size > 0 && !fProject.has(r.projectName)) return false;
    if (fChannel.size > 0 && !fChannel.has(r.channel)) return false;
    if (fQuery) {
      const hay = [
        r.projectName,
        r.company,
        r.channel,
        r.campaignManager,
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(fQuery)) return false;
    }
    return true;
  });

  // Three-level grouping: campaign manager → company → project → rows.
  // Within each project, channel rows sort by the URL-selected column.
  // Companies within a manager and projects within a company always
  // sort by their accumulated totalSpend desc (most-active group first
  // — same convention used elsewhere in the app, e.g. /team grid).
  // `GroupTotals` lives at module scope (next to EnrichedRow) so the
  // GroupTotalsStrip renderer can pull from it without a re-declaration.
  type ProjectGroup = GroupTotals & {
    project: string;
    slug: string;
    sheetTabUrl: string;
    rows: EnrichedRow[];
  };
  type CompanyGroup = GroupTotals & {
    company: string;
    projects: ProjectGroup[];
  };
  type ManagerGroup = GroupTotals & {
    name: string;
    companies: CompanyGroup[];
  };

  // Build the nested structure first; sort + roll up totals second.
  const managerMap = new Map<string, Map<string, Map<string, EnrichedRow[]>>>();
  for (const r of filtered) {
    let coMap = managerMap.get(r.campaignManager);
    if (!coMap) {
      coMap = new Map();
      managerMap.set(r.campaignManager, coMap);
    }
    let projMap = coMap.get(r.company);
    if (!projMap) {
      projMap = new Map();
      coMap.set(r.company, projMap);
    }
    // Group by projectName as well as slug to keep "(ללא שם)"-style
    // dupes separated when slug is empty. Joined with "__" so projects
    // whose names contain spaces still round-trip cleanly through
    // split("__") below.
    const projKey = `${r.projectName}__${r.slug}`;
    let rows = projMap.get(projKey);
    if (!rows) {
      rows = [];
      projMap.set(projKey, rows);
    }
    rows.push(r);
  }

  // Per-row cost-per-result helpers (used by both sort comparator +
  // the previous-month metrics table cells). Return null when the
  // denominator is 0/missing — rendered as "—" instead of ∞ / NaN.
  const costPerLead = (r: EnrichedRow): number | null =>
    r.leads > 0 ? r.spend / r.leads : null;
  const costPerScheduled = (r: EnrichedRow): number | null =>
    r.scheduled > 0 ? r.spend / r.scheduled : null;
  const costPerMeeting = (r: EnrichedRow): number | null =>
    r.meetings > 0 ? r.spend / r.meetings : null;

  // Channel-row comparator based on URL sort. Falls back to alpha
  // channel sort when the chosen column ties (so the order is stable
  // across re-renders even when many rows share, say, 0 spend).
  const sortMul = sortDir === "asc" ? 1 : -1;
  const compareRows = (a: EnrichedRow, b: EnrichedRow): number => {
    let primary = 0;
    if (sortCol === "channel") {
      primary = collator.compare(a.channel, b.channel) * sortMul;
    } else if (sortCol === "project") {
      primary = collator.compare(a.projectName, b.projectName) * sortMul;
    } else if (sortCol === "company") {
      primary = collator.compare(a.company, b.company) * sortMul;
    } else if (sortCol === "manager") {
      primary = collator.compare(a.campaignManager, b.campaignManager) * sortMul;
    } else if (sortCol === "spend") {
      primary = (a.spend - b.spend) * sortMul;
    } else if (sortCol === "budget") {
      primary = (a.budget - b.budget) * sortMul;
    } else if (sortCol === "utilizationPct") {
      // null (no budget) is treated as -Infinity asc / +Infinity desc
      // so "no budget" rows sink to the bottom regardless of direction.
      const av = a.utilizationPct ?? (sortDir === "asc" ? -Infinity : Infinity);
      const bv = b.utilizationPct ?? (sortDir === "asc" ? -Infinity : Infinity);
      primary = (av - bv) * sortMul;
    } else if (sortCol === "feePct") {
      primary = (a.feePercent - b.feePercent) * sortMul;
    } else if (sortCol === "feeIlsActual") {
      primary = (a.feeIlsActual - b.feeIlsActual) * sortMul;
    } else if (sortCol === "feeIlsBudget") {
      primary = (a.feeIlsBudget - b.feeIlsBudget) * sortMul;
    } else if (sortCol === "leads") {
      primary = (a.leads - b.leads) * sortMul;
    } else if (sortCol === "scheduled") {
      primary = (a.scheduled - b.scheduled) * sortMul;
    } else if (sortCol === "meetings") {
      primary = (a.meetings - b.meetings) * sortMul;
    } else if (
      sortCol === "costPerLead" ||
      sortCol === "costPerScheduled" ||
      sortCol === "costPerMeeting"
    ) {
      // Null cost-per-result rows sink to the bottom regardless of
      // direction — same convention as utilizationPct above.
      const getter =
        sortCol === "costPerLead"
          ? costPerLead
          : sortCol === "costPerScheduled"
            ? costPerScheduled
            : costPerMeeting;
      const av = getter(a) ?? (sortDir === "asc" ? -Infinity : Infinity);
      const bv = getter(b) ?? (sortDir === "asc" ? -Infinity : Infinity);
      primary = (av - bv) * sortMul;
    }
    if (primary !== 0) return primary;
    return collator.compare(a.channel, b.channel);
  };

  // Sum every numeric axis for a slice of rows in a single pass. Used
  // at every level of the rollup so totals stay consistent (manager
  // total === Σ company totals === Σ project totals === Σ row values).
  const sumRows = (rows: EnrichedRow[]): GroupTotals =>
    rows.reduce<GroupTotals>(
      (acc, r) => ({
        totalSpend: acc.totalSpend + r.spend,
        totalBudget: acc.totalBudget + r.budget,
        totalFeeActual: acc.totalFeeActual + r.feeIlsActual,
        totalFeeBudget: acc.totalFeeBudget + r.feeIlsBudget,
        totalLeads: acc.totalLeads + r.leads,
        totalScheduled: acc.totalScheduled + r.scheduled,
        totalMeetings: acc.totalMeetings + r.meetings,
      }),
      {
        totalSpend: 0,
        totalBudget: 0,
        totalFeeActual: 0,
        totalFeeBudget: 0,
        totalLeads: 0,
        totalScheduled: 0,
        totalMeetings: 0,
      },
    );

  const managers: ManagerGroup[] = Array.from(managerMap.entries())
    .map(([mgrName, coMap]) => {
      const companies: CompanyGroup[] = Array.from(coMap.entries())
        .map(([coName, projMap]) => {
          const projects: ProjectGroup[] = Array.from(projMap.entries())
            .map(([projKey, rows]) => {
              const [project] = projKey.split("__");
              const slug = rows[0]?.slug ?? "";
              const sheetTabUrl =
                sheetUrlBySlug.get(slug.toLowerCase().trim()) || "";
              rows.sort(compareRows);
              return {
                project,
                slug,
                sheetTabUrl,
                rows,
                ...sumRows(rows),
              };
            })
            .sort((a, b) => b.totalSpend - a.totalSpend);
          return {
            company: coName,
            projects,
            ...sumRows(projects.flatMap((p) => p.rows)),
          };
        })
        .sort((a, b) => b.totalSpend - a.totalSpend);
      return {
        name: mgrName,
        companies,
        ...sumRows(companies.flatMap((c) => c.projects.flatMap((p) => p.rows))),
      };
    })
    .sort((a, b) => b.totalSpend - a.totalSpend);

  // Grand totals across visible rows.
  const grand = sumRows(filtered);

  const hasFilter =
    fCompany.size > 0 || fProject.size > 0 || fChannel.size > 0 || !!fQuery;

  return (
    <main className="container forecast-page">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>🔮</span>
            תחזית הוצאה — {viewMode === "previous" ? `חודש ${selectedMonth}` : "חודש נוכחי"}
          </h1>
          <div className="subtitle">
            {viewMode === "previous"
              ? `שורות חודשי ב־ALL CLIENTS שמתחילות ב־${selectedMonth}, מקובצות לפי מנהל/ת קמפיינים.`
              : `שורות חודשי ב־ALL CLIENTS שחלון התאריכים שלהן כולל את היום (${todayIso}), מקובצות לפי מנהל/ת קמפיינים.`}
          </div>
        </div>
      </header>

      <CampaignsTabs active="forecast" showForecast />

      {/* Filter bar (iter 5). Each filter is a click-to-open dropdown
          (<details>/<summary>) with a checkbox list inside. Server-
          rendered: checkbox-state is the initial selection from the
          URL; on form submit a tiny inline script collects the
          checked values into a comma-separated string per filter so
          the URL stays readable (?company=A,B). Native dropdown
          open/close — no React state. */}
      <form className="forecast-filterbar" action="/morning/forecast" method="get">
        <label className="forecast-search">
          <span className="forecast-search-icon" aria-hidden>🔍</span>
          <input
            type="search"
            name="q"
            placeholder="חפש פרויקט, חברה, ערוץ, מנהל…"
            defaultValue={sp.q || ""}
            dir="auto"
            autoComplete="off"
          />
        </label>
        <SearchableMultiSelectFilter
          label="חברה"
          name="company"
          options={distinctCompanies.map((v) => ({ value: v }))}
          defaultSelected={Array.from(fCompany)}
          placeholder="חפש חברה…"
        />
        <SearchableMultiSelectFilter
          label="פרויקט"
          name="project"
          options={distinctProjects.map((v) => ({ value: v }))}
          defaultSelected={Array.from(fProject)}
          placeholder="חפש פרויקט…"
        />
        <SearchableMultiSelectFilter
          label="ערוץ"
          name="channel"
          options={distinctChannels.map((v) => ({ value: v }))}
          defaultSelected={Array.from(fChannel)}
          placeholder="חפש ערוץ…"
        />
        {/* Grouping toggle. Keep the current sort param when
            switching so the user doesn't lose their column choice. */}
        <div className="forecast-grouping-toggle" role="tablist" aria-label="קיבוץ">
          <Link
            href={(() => {
              const params = buildHref(sp, { grouping: "" });
              return `/morning/forecast?${params}`;
            })()}
            className={`forecast-grouping-btn${groupingMode === "default" ? " is-active" : ""}`}
            prefetch={false}
          >
            🗂️ מקובץ
          </Link>
          <Link
            href={(() => {
              const params = buildHref(sp, { grouping: "flat" });
              return `/morning/forecast?${params}`;
            })()}
            className={`forecast-grouping-btn${groupingMode === "flat" ? " is-active" : ""}`}
            prefetch={false}
          >
            📋 שורות
          </Link>
        </div>
        {/* View toggle (current vs previous month). Switching to the
            previous-month view defaults to the immediately-prior
            calendar month; the picker right next to it lets the user
            scrub to any historical month. Switching back to "current"
            drops the ?month param so the next prev-month flip resumes
            the default. Sort/filter params survive across both. */}
        <div className="forecast-grouping-toggle" role="tablist" aria-label="תקופה">
          <Link
            href={`/morning/forecast?${buildHref(sp, { view: "", month: "" })}`}
            className={`forecast-grouping-btn${viewMode === "current" ? " is-active" : ""}`}
            prefetch={false}
          >
            📅 חודש נוכחי
          </Link>
          <Link
            href={`/morning/forecast?${buildHref(sp, { view: "previous" })}`}
            className={`forecast-grouping-btn${viewMode === "previous" ? " is-active" : ""}`}
            prefetch={false}
          >
            ⏪ חודש קודם
          </Link>
        </div>
        {/* Native month picker — only useful when looking at a prior
            month. Defaults to the URL value (= previousYearMonth when
            no explicit month is set) and auto-submits the form on
            change. Capped at prevYm so the user can't roll forward
            into the current/future month from this view (current-
            month view is the other toggle). */}
        {viewMode === "previous" && (
          <ForecastMonthPicker
            key={selectedMonth}
            defaultValue={selectedMonth}
            max={prevYm}
          />
        )}
        {/* Metrics toggle — only meaningful in previous-month view. In
            current-month view the columns wouldn't add value (the
            partial-month ₪/result numbers are misleading mid-pace), so
            the toggle is hidden entirely. */}
        {viewMode === "previous" && (
          <div className="forecast-grouping-toggle" role="tablist" aria-label="מדדים">
            <Link
              href={`/morning/forecast?${buildHref(sp, { metrics: "" })}`}
              className={`forecast-grouping-btn${!showMetrics ? " is-active" : ""}`}
              prefetch={false}
            >
              💰 הוצאה בלבד
            </Link>
            <Link
              href={`/morning/forecast?${buildHref(sp, { metrics: "1" })}`}
              className={`forecast-grouping-btn${showMetrics ? " is-active" : ""}`}
              prefetch={false}
            >
              📈 כולל מדדים
            </Link>
          </div>
        )}
        <div className="forecast-filter-actions">
          <button type="submit" className="btn-primary btn-sm">
            סנן
          </button>
          {hasFilter && (
            <Link href="/morning/forecast" className="btn-ghost btn-sm">
              נקה
            </Link>
          )}
        </div>
        {/* Preserve sort + grouping + view + metrics params across the
            GET submit so picking new filter values doesn't reset the
            user's column sort, grouping mode, or view choice. The
            searchable multi-select itself writes a single hidden input
            per filter name — no submit-interceptor script needed anymore. */}
        {sp.sort && <input type="hidden" name="sort" value={sp.sort} />}
        {sp.dir && <input type="hidden" name="dir" value={sp.dir} />}
        {groupingMode === "flat" && (
          <input type="hidden" name="grouping" value="flat" />
        )}
        {viewMode === "previous" && (
          <input type="hidden" name="view" value="previous" />
        )}
        {showMetrics && <input type="hidden" name="metrics" value="1" />}
      </form>

      <section className="forecast-grand">
        <div className="forecast-grand-row">
          <span className="forecast-grand-label">
            {hasFilter
              ? "סך תיק לפי הסינון"
              : viewMode === "previous"
                ? "סך החודש הקודם"
                : "סך תיק נוכחי"}
          </span>
          <span className="forecast-grand-num">
            <b>{fmtIls(grand.totalSpend)}</b> בפועל
          </span>
          {viewMode === "current" && (
            <>
              <span className="forecast-grand-num">
                <b>{fmtIls(grand.totalBudget)}</b> תקציב
              </span>
              <span className="forecast-grand-num">
                <b>{fmtIls(grand.totalFeeBudget)}</b> דמי ניהול (תקציב)
              </span>
              <span className="forecast-grand-num">
                <b>{fmtIls(grand.totalFeeActual)}</b> דמי ניהול (בפועל)
              </span>
            </>
          )}
          {viewMode === "previous" && showMetrics && (
            <>
              <span className="forecast-grand-num">
                <b>{grand.totalLeads.toLocaleString("he-IL")}</b> לידים
              </span>
              <span className="forecast-grand-num">
                <b>{grand.totalScheduled.toLocaleString("he-IL")}</b> תיאומים
              </span>
              <span className="forecast-grand-num">
                <b>{grand.totalMeetings.toLocaleString("he-IL")}</b> ביצועים
              </span>
            </>
          )}
          <span className="forecast-grand-num">
            ({filtered.length} שורות)
          </span>
        </div>
      </section>

      {filtered.length === 0 ? (
        <div className="empty">
          <span className="emoji" aria-hidden>🌥️</span>
          {hasFilter
            ? "אין תוצאות לסינון הנוכחי."
            : `לא נמצאו שורות חודשי שחלונן כולל את היום (${todayIso}).`}
        </div>
      ) : groupingMode === "flat" ? (
        // Flat single-table view. Every row from `filtered` sorted by
        // the URL-selected column, with project + company surfaced
        // as additional columns (since the grouping isn't doing that
        // job anymore). Same channel-row comparator as the grouped
        // view → flipping the toggle preserves the user's sort.
        (() => {
          const flatRows = filtered.slice().sort(compareRows);
          return (
            <div className="forecast-table-wrap">
              <table className="forecast-table forecast-table-flat">
                <thead>
                  <tr>
                    <SortHeader col="project" label="פרויקט" currentCol={sortCol} currentDir={sortDir} sp={sp} align="start" />
                    <SortHeader col="company" label="חברה" currentCol={sortCol} currentDir={sortDir} sp={sp} align="start" />
                    <SortHeader col="manager" label="מנהל קמפיינים" currentCol={sortCol} currentDir={sortDir} sp={sp} align="start" />
                    <SortHeader col="channel" label="ערוץ" currentCol={sortCol} currentDir={sortDir} sp={sp} align="start" />
                    {viewMode === "current" && (
                      <>
                        <SortHeader col="budget" label="תקציב" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                        <SortHeader col="spend" label="בפועל" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                        <SortHeader col="utilizationPct" label="% ניצול" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                        <SortHeader col="feePct" label="% ניהול" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                        <SortHeader col="feeIlsBudget" label="דמי ניהול תקציב" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                        <SortHeader col="feeIlsActual" label="דמי ניהול בפועל" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                      </>
                    )}
                    {viewMode === "previous" && (
                      <>
                        <SortHeader col="spend" label="בפועל" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                        {showMetrics && (
                          <>
                            <SortHeader col="leads" label="לידים" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                            <SortHeader col="costPerLead" label="₪ / ליד" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                            <SortHeader col="scheduled" label="תיאומים" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                            <SortHeader col="costPerScheduled" label="₪ / תיאום" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                            <SortHeader col="meetings" label="ביצועים" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                            <SortHeader col="costPerMeeting" label="₪ / ביצוע" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                          </>
                        )}
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {flatRows.map((r, i) => {
                    const flatSheetUrl =
                      sheetUrlBySlug.get(r.slug.toLowerCase().trim()) || "";
                    return (
                      <tr key={`${r.slug}-${r.channel}-${i}`}>
                        <td className="c-project" dir="auto">
                          <span className="forecast-project-name">
                            {r.projectName}
                            <ProjectQuickOpen
                              projectName={r.projectName}
                              sheetTabUrl={flatSheetUrl}
                            />
                          </span>
                        </td>
                        <td className="c-company" dir="auto">{r.company}</td>
                        <td className="c-manager" dir="auto">{r.campaignManager}</td>
                        <td className="c-channel" dir="auto">{r.channel}</td>
                        {viewMode === "current" && (
                          <>
                            <td className="c-num">{fmtIls(r.budget)}</td>
                            <td className="c-num">{fmtIls(r.spend)}</td>
                            <td className="c-num">{fmtPct(r.utilizationPct)}</td>
                            <td className="c-fee">
                              <ManagementFeeCell
                                slug={r.slug}
                                channel={r.channel}
                                initialPercent={r.feePercent}
                              />
                            </td>
                            <td className="c-num">{fmtIls(r.feeIlsBudget)}</td>
                            <td className="c-num">{fmtIls(r.feeIlsActual)}</td>
                          </>
                        )}
                        {viewMode === "previous" && (
                          <>
                            <td className="c-num">{fmtIls(r.spend)}</td>
                            {showMetrics && (
                              <>
                                <td className="c-num">{fmtNum(r.leads)}</td>
                                <td className="c-num">{fmtIlsNullable(costPerLead(r))}</td>
                                <td className="c-num">{fmtNum(r.scheduled)}</td>
                                <td className="c-num">{fmtIlsNullable(costPerScheduled(r))}</td>
                                <td className="c-num">{fmtNum(r.meetings)}</td>
                                <td className="c-num">{fmtIlsNullable(costPerMeeting(r))}</td>
                              </>
                            )}
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })()
      ) : (
        managers.map((m) => (
          <details key={m.name} className="forecast-manager" open>
            <summary className="forecast-manager-head">
              <span dir="auto">{m.name}</span>
              <GroupTotalsStrip
                totals={m}
                viewMode={viewMode}
                showMetrics={showMetrics}
                className="forecast-manager-totals"
              />
            </summary>
            {m.companies.map((c) => (
              <details key={c.company} className="forecast-company">
                <summary className="forecast-company-head">
                  <span dir="auto">{c.company}</span>
                  <GroupTotalsStrip
                    totals={c}
                    viewMode={viewMode}
                    showMetrics={showMetrics}
                    className="forecast-company-totals"
                  />
                </summary>
                {c.projects.map((p) => (
                  <details key={p.project + p.slug} className="forecast-project" open>
                    <summary className="forecast-project-head">
                      <span className="forecast-project-name" dir="auto">
                        {p.project}
                        <ProjectQuickOpen
                          projectName={p.project}
                          sheetTabUrl={p.sheetTabUrl}
                        />
                      </span>
                      <GroupTotalsStrip
                        totals={p}
                        viewMode={viewMode}
                        showMetrics={showMetrics}
                        className="forecast-project-totals"
                      />
                    </summary>
                    <div className="forecast-table-wrap">
                      <table className="forecast-table">
                        <thead>
                          <tr>
                            <SortHeader col="channel" label="ערוץ" currentCol={sortCol} currentDir={sortDir} sp={sp} align="start" />
                            {viewMode === "current" && (
                              <>
                                <SortHeader col="budget" label="תקציב" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                                <SortHeader col="spend" label="בפועל" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                                <SortHeader col="utilizationPct" label="% ניצול" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                                <SortHeader col="feePct" label="% ניהול" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                                <SortHeader col="feeIlsBudget" label="דמי ניהול תקציב" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                                <SortHeader col="feeIlsActual" label="דמי ניהול בפועל" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                              </>
                            )}
                            {viewMode === "previous" && (
                              <>
                                <SortHeader col="spend" label="בפועל" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                                {showMetrics && (
                                  <>
                                    <SortHeader col="leads" label="לידים" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                                    <SortHeader col="costPerLead" label="₪ / ליד" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                                    <SortHeader col="scheduled" label="תיאומים" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                                    <SortHeader col="costPerScheduled" label="₪ / תיאום" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                                    <SortHeader col="meetings" label="ביצועים" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                                    <SortHeader col="costPerMeeting" label="₪ / ביצוע" currentCol={sortCol} currentDir={sortDir} sp={sp} />
                                  </>
                                )}
                              </>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {p.rows.map((r, i) => (
                            <tr key={`${r.slug}-${r.channel}-${i}`}>
                              <td className="c-channel" dir="auto">
                                {r.channel}
                              </td>
                              {viewMode === "current" && (
                                <>
                                  <td className="c-num">{fmtIls(r.budget)}</td>
                                  <td className="c-num">{fmtIls(r.spend)}</td>
                                  <td className="c-num">{fmtPct(r.utilizationPct)}</td>
                                  <td className="c-fee">
                                    <ManagementFeeCell
                                      slug={r.slug}
                                      channel={r.channel}
                                      initialPercent={r.feePercent}
                                    />
                                  </td>
                                  <td className="c-num">{fmtIls(r.feeIlsBudget)}</td>
                                  <td className="c-num">{fmtIls(r.feeIlsActual)}</td>
                                </>
                              )}
                              {viewMode === "previous" && (
                                <>
                                  <td className="c-num">{fmtIls(r.spend)}</td>
                                  {showMetrics && (
                                    <>
                                      <td className="c-num">{fmtNum(r.leads)}</td>
                                      <td className="c-num">{fmtIlsNullable(costPerLead(r))}</td>
                                      <td className="c-num">{fmtNum(r.scheduled)}</td>
                                      <td className="c-num">{fmtIlsNullable(costPerScheduled(r))}</td>
                                      <td className="c-num">{fmtNum(r.meetings)}</td>
                                      <td className="c-num">{fmtIlsNullable(costPerMeeting(r))}</td>
                                    </>
                                  )}
                                </>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ))}
              </details>
            ))}
          </details>
        ))
      )}
    </main>
  );
}

/**
 * Two quick-open icons rendered next to each project name:
 *   📊  → opens the project's master-sheet tab (the hyperlink on
 *        Keys' `campaign ID` column rich-text). Only renders when a
 *        URL exists — projects whose Keys cell isn't hyperlinked
 *        skip the icon instead of rendering a dead button.
 *   🔗  → opens the project's hub page (/projects/[name]). Always
 *        renders since every row has a project name.
 *
 * Minimal labeling per the owner's spec: icon-only, title tooltips
 * carry the verbose label.
 */
function ProjectQuickOpen({
  projectName,
  sheetTabUrl,
}: {
  projectName: string;
  sheetTabUrl: string;
}) {
  return (
    <span className="forecast-quick-actions">
      {sheetTabUrl && (
        <a
          className="forecast-quick-btn"
          href={sheetTabUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="פתח את לשונית הגיליון של הפרויקט"
          aria-label="פתח גיליון"
        >
          📊
        </a>
      )}
      <Link
        href={`/projects/${encodeURIComponent(projectName)}`}
        className="forecast-quick-btn"
        title="פתח את עמוד הפרויקט בהאב"
        aria-label="פתח עמוד פרויקט"
        prefetch={false}
      >
        🏢
      </Link>
    </span>
  );
}

/**
 * Clickable column header. Builds a URL that toggles direction when
 * clicking the active column, or sets `?sort=col&dir=desc` when
 * switching to a different column (start newcomers at desc — most
 * useful for ₪ columns; alpha columns default to asc instead).
 */
function SortHeader({
  col,
  label,
  currentCol,
  currentDir,
  sp,
  align = "start",
}: {
  col:
    | "channel"
    | "spend"
    | "budget"
    | "utilizationPct"
    | "feePct"
    | "feeIlsBudget"
    | "feeIlsActual"
    | "leads"
    | "scheduled"
    | "meetings"
    | "costPerLead"
    | "costPerScheduled"
    | "costPerMeeting"
    | "project"
    | "company"
    | "manager";
  label: string;
  currentCol: string;
  currentDir: "asc" | "desc";
  sp: SpShape;
  align?: "start" | "end";
}) {
  const isActive = currentCol === col;
  const isAlpha =
    col === "channel" ||
    col === "project" ||
    col === "company" ||
    col === "manager";
  // Toggle direction when re-clicking the active column. When
  // switching columns, default to asc for alpha cols (A→Z reads
  // naturally) and desc for numeric (₪ desc surfaces the largest
  // first, which is what people usually want).
  const nextDir = isActive
    ? currentDir === "asc"
      ? "desc"
      : "asc"
    : isAlpha
      ? "asc"
      : "desc";
  // Preserve every other URL param (filters, grouping) so clicking a
  // header doesn't reset the user's other state.
  const href = `/morning/forecast?${buildHref(sp, { sort: col, dir: nextDir })}`;
  const arrow = isActive ? (currentDir === "asc" ? "▲" : "▼") : "";
  return (
    <th
      className={`forecast-th-sort${isActive ? " is-active" : ""}`}
      style={{ textAlign: align === "end" ? "end" : "start" }}
      aria-sort={
        isActive
          ? currentDir === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <Link href={href} prefetch={false} className="forecast-th-link">
        {label}
        {arrow && <span className="forecast-th-arrow"> {arrow}</span>}
      </Link>
    </th>
  );
}

// `FilterDropdown` removed (iter 8) — replaced by
// SearchableMultiSelectFilter for a search-driven UX that matches
// the CRM funnel filter pattern.

/**
 * Inline summary strip used on every level of the nested view
 * (manager / company / project headings). Switches columns by view:
 *
 *   current  — בפועל / תקציב / דמי ניהול (תקציב) / דמי ניהול (בפועל)
 *   previous — בפועל only, + לידים / תיאומים / ביצועים when the
 *              metrics toggle is on.
 *
 * Kept thin on purpose — every label is a literal, the totals come
 * from a shared GroupTotals shape, and the wrapper className lets the
 * three call-sites keep their existing CSS hooks
 * (.forecast-manager-totals / -company-totals / -project-totals).
 */
function GroupTotalsStrip({
  totals,
  viewMode,
  showMetrics,
  className,
}: {
  totals: GroupTotals;
  viewMode: "current" | "previous";
  showMetrics: boolean;
  className: string;
}) {
  return (
    <span className={className}>
      <span>בפועל: <b>{fmtIls(totals.totalSpend)}</b></span>
      {viewMode === "current" && (
        <>
          <span>תקציב: <b>{fmtIls(totals.totalBudget)}</b></span>
          <span>דמי ניהול (תקציב): <b>{fmtIls(totals.totalFeeBudget)}</b></span>
          <span>דמי ניהול (בפועל): <b>{fmtIls(totals.totalFeeActual)}</b></span>
        </>
      )}
      {viewMode === "previous" && showMetrics && (
        <>
          <span>לידים: <b>{fmtNum(totals.totalLeads)}</b></span>
          <span>תיאומים: <b>{fmtNum(totals.totalScheduled)}</b></span>
          <span>ביצועים: <b>{fmtNum(totals.totalMeetings)}</b></span>
        </>
      )}
    </span>
  );
}
