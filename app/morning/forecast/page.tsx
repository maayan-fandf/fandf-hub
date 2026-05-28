import { redirect } from "next/navigation";
import Link from "next/link";
import {
  currentUserEmail,
  getMyProjects,
} from "@/lib/appsScript";
import {
  getCurrentMonthlyRows,
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

type EnrichedRow = {
  slug: string;
  projectName: string;
  company: string;
  campaignManager: string;
  channel: string;
  spend: number;
  budget: number;
  /** Management-fee percent for this (slug, channel). Server-
   *  resolved with the 15% default when no Firestore override exists. */
  feePercent: number;
  /** Computed fee in ILS = spend × feePercent / 100. Server-side so
   *  the per-manager + grand totals can include it without
   *  re-deriving on the client. */
  feeIls: number;
};

function fmtIls(n: number): string {
  const v = Math.round(n);
  return `₪${v.toLocaleString("he-IL")}`;
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
  }>;
}) {
  const me = await currentUserEmail().catch(() => "");
  if (!me) redirect("/signin?next=/morning/forecast");

  const projectsData = await getMyProjects().catch(() => null);
  if (!projectsData?.isAdmin) redirect("/morning");

  const sp = await searchParams;
  const fCompany = (sp.company || "").trim();
  const fProject = (sp.project || "").trim();
  const fChannel = (sp.channel || "").trim();

  // Sort state. Valid columns: channel, spend, budget, feePct, feeIls.
  // Falls back to "spend / desc" so the busiest row is first when the
  // user lands without a sort param. Project / company are
  // intentionally NOT sortable on a row — they're grouping keys, all
  // rows inside one group share the same value.
  type SortCol = "channel" | "spend" | "budget" | "feePct" | "feeIls";
  type SortDir = "asc" | "desc";
  const ALLOWED_SORTS: ReadonlySet<SortCol> = new Set<SortCol>([
    "channel",
    "spend",
    "budget",
    "feePct",
    "feeIls",
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

  const [monthlyRows, keys, feeMap] = await Promise.all([
    getCurrentMonthlyRows(subjectEmail, todayIso).catch(
      () => [] as AllClientsRow[],
    ),
    readKeysCached(subjectEmail).catch(
      () => ({ headers: [] as string[], rows: [] as unknown[][] }),
    ),
    readAllManagementFees().catch(() => new Map<string, number>()),
  ]);

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
    const feeIls = (r.spend * feePercent) / 100;
    return {
      slug: r.projectSlug,
      projectName: meta.projectName,
      company: meta.company || UNKNOWN_COMPANY,
      campaignManager: meta.campaignManager || UNASSIGNED,
      channel,
      spend: r.spend,
      budget: r.budget,
      feePercent,
      feeIls,
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
    if (fCompany && r.company !== fCompany) return false;
    if (fProject && r.projectName !== fProject) return false;
    if (fChannel && r.channel !== fChannel) return false;
    return true;
  });

  // Three-level grouping: campaign manager → company → project → rows.
  // Within each project, channel rows sort by the URL-selected column.
  // Companies within a manager and projects within a company always
  // sort by their accumulated totalSpend desc (most-active group first
  // — same convention used elsewhere in the app, e.g. /team grid).
  type ProjectGroup = {
    project: string;
    slug: string;
    rows: EnrichedRow[];
    totalSpend: number;
    totalBudget: number;
    totalFee: number;
  };
  type CompanyGroup = {
    company: string;
    projects: ProjectGroup[];
    totalSpend: number;
    totalBudget: number;
    totalFee: number;
  };
  type ManagerGroup = {
    name: string;
    companies: CompanyGroup[];
    totalSpend: number;
    totalBudget: number;
    totalFee: number;
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
    // dupes separated when slug is empty.
    const projKey = `${r.projectName} ${r.slug}`;
    let rows = projMap.get(projKey);
    if (!rows) {
      rows = [];
      projMap.set(projKey, rows);
    }
    rows.push(r);
  }

  // Channel-row comparator based on URL sort. Falls back to alpha
  // channel sort when the chosen column ties (so the order is stable
  // across re-renders even when many rows share, say, 0 spend).
  const sortMul = sortDir === "asc" ? 1 : -1;
  const compareRows = (a: EnrichedRow, b: EnrichedRow): number => {
    let primary = 0;
    if (sortCol === "channel") {
      primary = collator.compare(a.channel, b.channel) * sortMul;
    } else if (sortCol === "spend") {
      primary = (a.spend - b.spend) * sortMul;
    } else if (sortCol === "budget") {
      primary = (a.budget - b.budget) * sortMul;
    } else if (sortCol === "feePct") {
      primary = (a.feePercent - b.feePercent) * sortMul;
    } else if (sortCol === "feeIls") {
      primary = (a.feeIls - b.feeIls) * sortMul;
    }
    if (primary !== 0) return primary;
    return collator.compare(a.channel, b.channel);
  };

  const managers: ManagerGroup[] = Array.from(managerMap.entries())
    .map(([mgrName, coMap]) => {
      const companies: CompanyGroup[] = Array.from(coMap.entries())
        .map(([coName, projMap]) => {
          const projects: ProjectGroup[] = Array.from(projMap.entries())
            .map(([projKey, rows]) => {
              const [project] = projKey.split(" ");
              const slug = rows[0]?.slug ?? "";
              rows.sort(compareRows);
              const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
              const totalBudget = rows.reduce((s, r) => s + r.budget, 0);
              const totalFee = rows.reduce((s, r) => s + r.feeIls, 0);
              return { project, slug, rows, totalSpend, totalBudget, totalFee };
            })
            .sort((a, b) => b.totalSpend - a.totalSpend);
          return {
            company: coName,
            projects,
            totalSpend: projects.reduce((s, p) => s + p.totalSpend, 0),
            totalBudget: projects.reduce((s, p) => s + p.totalBudget, 0),
            totalFee: projects.reduce((s, p) => s + p.totalFee, 0),
          };
        })
        .sort((a, b) => b.totalSpend - a.totalSpend);
      return {
        name: mgrName,
        companies,
        totalSpend: companies.reduce((s, c) => s + c.totalSpend, 0),
        totalBudget: companies.reduce((s, c) => s + c.totalBudget, 0),
        totalFee: companies.reduce((s, c) => s + c.totalFee, 0),
      };
    })
    .sort((a, b) => b.totalSpend - a.totalSpend);

  // Grand totals across visible rows.
  const grand = filtered.reduce(
    (acc, r) => ({
      spend: acc.spend + r.spend,
      budget: acc.budget + r.budget,
      fee: acc.fee + r.feeIls,
    }),
    { spend: 0, budget: 0, fee: 0 },
  );

  const hasFilter = !!(fCompany || fProject || fChannel);

  return (
    <main className="container forecast-page">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>🔮</span>
            תחזית הוצאה — חודש נוכחי
          </h1>
          <div className="subtitle">
            שורות חודשי ב־ALL CLIENTS שחלון התאריכים שלהן כולל את היום
            ({todayIso}), מקובצות לפי מנהל/ת קמפיינים.
          </div>
        </div>
      </header>

      <CampaignsTabs active="forecast" showForecast />

      {/* Filter bar — three uncontrolled <select>s submitted as a
          GET form so the URL carries the state (shareable, back-
          button friendly, no client JS). Each <select> lists the
          live distinct values; "הכל" is the no-filter option. */}
      <form className="forecast-filterbar" action="/morning/forecast" method="get">
        <label className="forecast-filter">
          <span>חברה</span>
          <select name="company" defaultValue={fCompany}>
            <option value="">הכל</option>
            {distinctCompanies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="forecast-filter">
          <span>פרויקט</span>
          <select name="project" defaultValue={fProject}>
            <option value="">הכל</option>
            {distinctProjects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="forecast-filter">
          <span>ערוץ</span>
          <select name="channel" defaultValue={fChannel}>
            <option value="">הכל</option>
            {distinctChannels.map((ch) => (
              <option key={ch} value={ch}>
                {ch}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-primary btn-sm">
          סנן
        </button>
        {hasFilter && (
          <Link href="/morning/forecast" className="btn-ghost btn-sm">
            נקה
          </Link>
        )}
      </form>

      <section className="forecast-grand">
        <div className="forecast-grand-row">
          <span className="forecast-grand-label">
            {hasFilter ? "סך תיק לפי הסינון" : "סך תיק נוכחי"}
          </span>
          <span className="forecast-grand-num">
            <b>{fmtIls(grand.spend)}</b> בפועל
          </span>
          <span className="forecast-grand-num">
            <b>{fmtIls(grand.budget)}</b> תקציב
          </span>
          <span className="forecast-grand-num">
            <b>{fmtIls(grand.fee)}</b> דמי ניהול
          </span>
          <span className="forecast-grand-num">
            ({filtered.length} שורות)
          </span>
        </div>
      </section>

      {managers.length === 0 ? (
        <div className="empty">
          <span className="emoji" aria-hidden>🌥️</span>
          {hasFilter
            ? "אין תוצאות לסינון הנוכחי."
            : `לא נמצאו שורות חודשי שחלונן כולל את היום (${todayIso}).`}
        </div>
      ) : (
        managers.map((m) => (
          <section key={m.name} className="forecast-manager">
            <h2 className="forecast-manager-head">
              <span dir="auto">{m.name}</span>
              <span className="forecast-manager-totals">
                <span>בפועל: <b>{fmtIls(m.totalSpend)}</b></span>
                <span>תקציב: <b>{fmtIls(m.totalBudget)}</b></span>
                <span>דמי ניהול: <b>{fmtIls(m.totalFee)}</b></span>
              </span>
            </h2>
            {m.companies.map((c) => (
              <div key={c.company} className="forecast-company">
                <h3 className="forecast-company-head">
                  <span dir="auto">{c.company}</span>
                  <span className="forecast-company-totals">
                    <span>בפועל: <b>{fmtIls(c.totalSpend)}</b></span>
                    <span>תקציב: <b>{fmtIls(c.totalBudget)}</b></span>
                    <span>דמי ניהול: <b>{fmtIls(c.totalFee)}</b></span>
                  </span>
                </h3>
                {c.projects.map((p) => (
                  <div key={p.project + p.slug} className="forecast-project">
                    <h4 className="forecast-project-head">
                      <Link
                        href={`/projects/${encodeURIComponent(p.project)}`}
                        className="forecast-project-link"
                      >
                        <span dir="auto">{p.project}</span>
                      </Link>
                      <span className="forecast-project-totals">
                        <span>בפועל: <b>{fmtIls(p.totalSpend)}</b></span>
                        <span>תקציב: <b>{fmtIls(p.totalBudget)}</b></span>
                        <span>דמי ניהול: <b>{fmtIls(p.totalFee)}</b></span>
                      </span>
                    </h4>
                    <div className="forecast-table-wrap">
                      <table className="forecast-table">
                        <thead>
                          <tr>
                            <SortHeader
                              col="channel"
                              label="ערוץ"
                              currentCol={sortCol}
                              currentDir={sortDir}
                              sp={sp}
                              align="start"
                            />
                            <SortHeader
                              col="spend"
                              label="בפועל"
                              currentCol={sortCol}
                              currentDir={sortDir}
                              sp={sp}
                            />
                            <SortHeader
                              col="budget"
                              label="תקציב"
                              currentCol={sortCol}
                              currentDir={sortDir}
                              sp={sp}
                            />
                            <SortHeader
                              col="feePct"
                              label="% ניהול"
                              currentCol={sortCol}
                              currentDir={sortDir}
                              sp={sp}
                            />
                            <SortHeader
                              col="feeIls"
                              label="₪ ניהול"
                              currentCol={sortCol}
                              currentDir={sortDir}
                              sp={sp}
                            />
                          </tr>
                        </thead>
                        <tbody>
                          {p.rows.map((r, i) => (
                            <tr key={`${r.slug}-${r.channel}-${i}`}>
                              <td className="c-channel" dir="auto">
                                {r.channel}
                              </td>
                              <td className="c-num">{fmtIls(r.spend)}</td>
                              <td className="c-num">{fmtIls(r.budget)}</td>
                              <td className="c-fee">
                                <ManagementFeeCell
                                  slug={r.slug}
                                  channel={r.channel}
                                  initialPercent={r.feePercent}
                                />
                              </td>
                              <td className="c-num">{fmtIls(r.feeIls)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </section>
        ))
      )}
    </main>
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
  align = "end",
}: {
  col: "channel" | "spend" | "budget" | "feePct" | "feeIls";
  label: string;
  currentCol: string;
  currentDir: "asc" | "desc";
  sp: {
    company?: string;
    project?: string;
    channel?: string;
    sort?: string;
    dir?: string;
  };
  align?: "start" | "end";
}) {
  const isActive = currentCol === col;
  const isAlpha = col === "channel";
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
  const params = new URLSearchParams();
  if (sp.company) params.set("company", sp.company);
  if (sp.project) params.set("project", sp.project);
  if (sp.channel) params.set("channel", sp.channel);
  params.set("sort", col);
  params.set("dir", nextDir);
  const href = `/morning/forecast?${params.toString()}`;
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
