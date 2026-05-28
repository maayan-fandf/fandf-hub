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

  // Group: campaign manager → rows. Sorted: managers by total spend
  // desc; rows inside each manager by project name → channel.
  const byManager = new Map<string, EnrichedRow[]>();
  for (const r of filtered) {
    const k = r.campaignManager;
    if (!byManager.has(k)) byManager.set(k, []);
    byManager.get(k)!.push(r);
  }
  const managers = Array.from(byManager.entries())
    .map(([name, rows]) => {
      rows.sort(
        (a, b) =>
          collator.compare(a.projectName, b.projectName) ||
          collator.compare(a.channel, b.channel),
      );
      const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
      const totalBudget = rows.reduce((s, r) => s + r.budget, 0);
      const totalFee = rows.reduce((s, r) => s + r.feeIls, 0);
      return { name, rows, totalSpend, totalBudget, totalFee };
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
                <span>{m.rows.length} שורות</span>
              </span>
            </h2>
            <div className="forecast-table-wrap">
              <table className="forecast-table">
                <thead>
                  <tr>
                    <th>פרויקט</th>
                    <th>חברה</th>
                    <th>ערוץ</th>
                    <th>בפועל</th>
                    <th>תקציב</th>
                    <th>% ניהול</th>
                    <th>₪ ניהול</th>
                  </tr>
                </thead>
                <tbody>
                  {m.rows.map((r, i) => (
                    <tr key={`${r.slug}-${r.channel}-${i}`}>
                      <td className="c-project" dir="auto">
                        <Link
                          href={`/projects/${encodeURIComponent(r.projectName)}`}
                          className="forecast-project-link"
                        >
                          {r.projectName}
                        </Link>
                      </td>
                      <td className="c-company" dir="auto">
                        {r.company}
                      </td>
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
          </section>
        ))
      )}
    </main>
  );
}
