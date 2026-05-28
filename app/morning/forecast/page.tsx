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
import CampaignsTabs from "@/components/CampaignsTabs";

export const dynamic = "force-dynamic";

/**
 * /morning/forecast — admin-only month-end spend prediction.
 *
 * Data source: ALL CLIENTS rows with `rowType === "חודשי"` whose
 * window contains today. For each (project, channel) row we project
 * month-end spend by scaling spend-to-date by (days-in-window /
 * days-elapsed). Variance vs the row's `תקציב חודשי מאושר` (budget)
 * tells us who's tracking to over- or under-spend the month.
 *
 * Grouping: company → project → channel rows. The (project → company)
 * lookup goes through the Keys sheet (cached) since ALL CLIENTS
 * doesn't carry company directly. Projects whose company can't be
 * resolved get bucketed under "(לא מזוהה)" so they don't silently
 * drop.
 *
 * Owner request 2026-05-27.
 */

type Row = {
  channel: string;
  spend: number;
  budget: number;
  startIso: string;
  endIso: string;
  daysElapsed: number;
  daysInWindow: number;
  predictedSpend: number;
  variance: number; // predictedSpend - budget
  variancePct: number; // variance / budget (NaN-safe)
};

type ProjectGroup = {
  project: string;
  projectSlug: string;
  rows: Row[];
  totalSpend: number;
  totalBudget: number;
  totalPredicted: number;
  totalVariance: number;
};

type CompanyGroup = {
  company: string;
  projects: ProjectGroup[];
  totalSpend: number;
  totalBudget: number;
  totalPredicted: number;
  totalVariance: number;
};

function daysBetweenInclusive(startIso: string, endIso: string): number {
  if (!startIso || !endIso) return 0;
  const s = Date.parse(startIso + "T00:00:00Z");
  const e = Date.parse(endIso + "T00:00:00Z");
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 0;
  return Math.max(0, Math.round((e - s) / 86400000) + 1);
}

function buildRow(r: AllClientsRow, todayIso: string): Row {
  const daysInWindow = daysBetweenInclusive(r.startIso, r.endIso);
  const daysElapsed = Math.max(
    0,
    Math.min(daysInWindow, daysBetweenInclusive(r.startIso, todayIso)),
  );
  const safeDaysElapsed = Math.max(1, daysElapsed);
  const predictedSpend = (r.spend * daysInWindow) / safeDaysElapsed;
  const variance = predictedSpend - r.budget;
  const variancePct = r.budget > 0 ? variance / r.budget : 0;
  return {
    channel: r.channel || "(ללא ערוץ)",
    spend: r.spend,
    budget: r.budget,
    startIso: r.startIso,
    endIso: r.endIso,
    daysElapsed,
    daysInWindow,
    predictedSpend,
    variance,
    variancePct,
  };
}

function fmtIls(n: number): string {
  const v = Math.round(n);
  return `₪${v.toLocaleString("he-IL")}`;
}
function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${Math.round(n * 100)}%`;
}

function varianceTone(variancePct: number): "ok" | "warn" | "alert" {
  // Tighter band than the dashboard pacing chips (±10% vs ±15%) —
  // this is a predictive view, so flag earlier.
  const abs = Math.abs(variancePct);
  if (abs < 0.1) return "ok";
  if (abs < 0.2) return "warn";
  return "alert";
}

export default async function ForecastPage() {
  const me = await currentUserEmail().catch(() => "");
  if (!me) redirect("/signin?next=/morning/forecast");

  const projectsData = await getMyProjects().catch(() => null);
  if (!projectsData?.isAdmin) redirect("/morning");

  const subjectEmail = driveFolderOwner();
  const todayIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
  }).format(new Date());

  // Two parallel reads: the monthly rows we'll project from, and
  // the Keys sheet for the project→company join (ALL CLIENTS doesn't
  // carry company directly). Both are cached, so this is cheap on
  // warm cache.
  const [monthlyRows, keys] = await Promise.all([
    getCurrentMonthlyRows(subjectEmail, todayIso).catch(
      () => [] as AllClientsRow[],
    ),
    // Explicit type-cast on the fallback so TS doesn't infer never[]
    // (which makes `headers.indexOf("…")` require `never` arg type,
    // breaking the build).
    readKeysCached(subjectEmail).catch(
      () => ({ headers: [] as string[], rows: [] as unknown[][] }),
    ),
  ]);

  // Build a (slug → company) and (project → company) map from Keys.
  // The slug is the canonical join because ALL CLIENTS rows often have
  // an empty `פרוייקט` column (XLOOKUP migration 2026-05-01).
  const companyBySlug = new Map<string, string>();
  const companyByProject = new Map<string, string>();
  {
    const headers = keys.headers || [];
    const iProj = headers.indexOf("פרוייקט");
    const iCo = headers.indexOf("חברה");
    const iSlug = headers.indexOf("campaign ID");
    if (iProj >= 0 && iCo >= 0) {
      for (const row of keys.rows || []) {
        const proj = String(row[iProj] ?? "").trim();
        const co = String(row[iCo] ?? "").trim();
        if (proj && co) companyByProject.set(proj.toLowerCase(), co);
        if (iSlug >= 0) {
          const slug = String(row[iSlug] ?? "").trim();
          if (slug && co) companyBySlug.set(slug.toLowerCase(), co);
        }
      }
    }
  }

  // Group rows: company → project → channel rows.
  const companyMap = new Map<string, CompanyGroup>();
  for (const r of monthlyRows) {
    const slugKey = (r.projectSlug || "").toLowerCase();
    const projKey = (r.project || "").toLowerCase();
    const company =
      companyBySlug.get(slugKey) ||
      companyByProject.get(projKey) ||
      "(לא מזוהה)";
    const projectName = r.project || r.projectSlug || "(ללא שם)";

    let cg = companyMap.get(company);
    if (!cg) {
      cg = {
        company,
        projects: [],
        totalSpend: 0,
        totalBudget: 0,
        totalPredicted: 0,
        totalVariance: 0,
      };
      companyMap.set(company, cg);
    }

    let pg = cg.projects.find(
      (p) => p.projectSlug === r.projectSlug || p.project === projectName,
    );
    if (!pg) {
      pg = {
        project: projectName,
        projectSlug: r.projectSlug,
        rows: [],
        totalSpend: 0,
        totalBudget: 0,
        totalPredicted: 0,
        totalVariance: 0,
      };
      cg.projects.push(pg);
    }

    const built = buildRow(r, todayIso);
    pg.rows.push(built);
    pg.totalSpend += built.spend;
    pg.totalBudget += built.budget;
    pg.totalPredicted += built.predictedSpend;
    pg.totalVariance += built.variance;

    cg.totalSpend += built.spend;
    cg.totalBudget += built.budget;
    cg.totalPredicted += built.predictedSpend;
    cg.totalVariance += built.variance;
  }

  // Sort: companies by total predicted spend desc (biggest outlay
  // first); projects within each company by predicted desc; rows
  // within each project by predicted desc.
  const companies = Array.from(companyMap.values()).sort(
    (a, b) => b.totalPredicted - a.totalPredicted,
  );
  for (const c of companies) {
    c.projects.sort((a, b) => b.totalPredicted - a.totalPredicted);
    for (const p of c.projects) {
      p.rows.sort((a, b) => b.predictedSpend - a.predictedSpend);
    }
  }

  // Grand totals across all rows — pinned at the top so the user gets
  // a single-screen "is the whole portfolio over- or under-spending
  // the month" read before drilling into specifics.
  const grand = companies.reduce(
    (acc, c) => ({
      spend: acc.spend + c.totalSpend,
      budget: acc.budget + c.totalBudget,
      predicted: acc.predicted + c.totalPredicted,
      variance: acc.variance + c.totalVariance,
    }),
    { spend: 0, budget: 0, predicted: 0, variance: 0 },
  );
  const grandPct = grand.budget > 0 ? grand.variance / grand.budget : 0;
  const grandTone = varianceTone(grandPct);

  return (
    <main className="container forecast-page">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>🔮</span>
            תחזית הוצאה — חודש נוכחי
          </h1>
          <div className="subtitle">
            מבוסס על שורות חודשי ב־ALL CLIENTS שחלון התאריכים שלהן כולל את
            היום ({todayIso}). הוצאה צפויה ={" "}
            <code>spend × (days-in-window ÷ days-elapsed)</code>. סטייה נמדדת
            מול התקציב החודשי המאושר של אותה שורה.
          </div>
        </div>
      </header>

      <CampaignsTabs active="forecast" showForecast />

      {companies.length === 0 ? (
        <div className="empty">
          <span className="emoji" aria-hidden>🌥️</span>
          לא נמצאו שורות חודשי שחלונן כולל את היום ({todayIso}).
        </div>
      ) : (
        <>
          <section className={`forecast-grand forecast-grand-${grandTone}`}>
            <div className="forecast-grand-row">
              <span className="forecast-grand-label">סך תיק נוכחי</span>
              <span className="forecast-grand-num">
                <b>{fmtIls(grand.spend)}</b> בפועל
              </span>
              <span className="forecast-grand-num">
                <b>{fmtIls(grand.budget)}</b> תקציב
              </span>
              <span className="forecast-grand-num forecast-grand-predicted">
                <b>{fmtIls(grand.predicted)}</b> צפי לסוף החודש
              </span>
              <span
                className={`forecast-grand-variance is-${grandTone}`}
                title="(צפי − תקציב)"
              >
                <b>{fmtIls(grand.variance)}</b> ({fmtPct(grandPct)})
              </span>
            </div>
          </section>

          {companies.map((c) => {
            const coPct =
              c.totalBudget > 0 ? c.totalVariance / c.totalBudget : 0;
            const coTone = varianceTone(coPct);
            return (
              <section key={c.company} className="forecast-company">
                <h2 className="forecast-company-head">
                  <span dir="auto">{c.company}</span>
                  <span className="forecast-company-totals">
                    <span>{fmtIls(c.totalSpend)} ⇒ {fmtIls(c.totalPredicted)}</span>
                    <span className={`forecast-pill is-${coTone}`}>
                      {fmtPct(coPct)}
                    </span>
                  </span>
                </h2>
                {c.projects.map((p) => {
                  const pPct =
                    p.totalBudget > 0 ? p.totalVariance / p.totalBudget : 0;
                  const pTone = varianceTone(pPct);
                  return (
                    <div key={p.project + p.projectSlug} className="forecast-project">
                      <h3 className="forecast-project-head">
                        <Link
                          href={`/projects/${encodeURIComponent(p.project)}`}
                          className="forecast-project-link"
                        >
                          <span dir="auto">{p.project}</span>
                        </Link>
                        <span className="forecast-project-totals">
                          <span>{fmtIls(p.totalSpend)} ⇒ {fmtIls(p.totalPredicted)}</span>
                          <span
                            className={`forecast-pill is-${pTone}`}
                            title={`תקציב: ${fmtIls(p.totalBudget)}`}
                          >
                            {fmtPct(pPct)}
                          </span>
                        </span>
                      </h3>
                      <div className="forecast-table-wrap">
                        <table className="forecast-table">
                          <thead>
                            <tr>
                              <th>ערוץ</th>
                              <th>בפועל</th>
                              <th>תקציב</th>
                              <th>ימים</th>
                              <th>צפי</th>
                              <th>סטייה</th>
                            </tr>
                          </thead>
                          <tbody>
                            {p.rows.map((r, i) => {
                              const tone = varianceTone(r.variancePct);
                              return (
                                <tr
                                  key={r.channel + i}
                                  data-tone={tone}
                                  className="forecast-row"
                                >
                                  <td className="c-channel" dir="auto">
                                    {r.channel}
                                  </td>
                                  <td className="c-num">{fmtIls(r.spend)}</td>
                                  <td className="c-num">{fmtIls(r.budget)}</td>
                                  <td className="c-num">
                                    {r.daysElapsed}/{r.daysInWindow}
                                  </td>
                                  <td className="c-num c-predicted">
                                    {fmtIls(r.predictedSpend)}
                                  </td>
                                  <td className={`c-num c-variance is-${tone}`}>
                                    <b>{fmtIls(r.variance)}</b>
                                    <span className="forecast-pct">
                                      {fmtPct(r.variancePct)}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </>
      )}
    </main>
  );
}
