import Link from "next/link";
import { redirect } from "next/navigation";
import HomeFilterBar from "@/components/HomeFilterBar";
import StaggerReveal from "@/components/anim/StaggerReveal";

export const metadata = { title: "פרויקטים" };
import {
  getMyProjects,
  getMyCounts,
  getMorningFeed,
  currentUserEmail,
  GENERAL_PROJECT_NAME,
  type Project,
  type MyCountsPerProject,
  type MorningFeed,
} from "@/lib/appsScript";
import { getUserPrefs } from "@/lib/userPrefs";
import { getEffectiveViewAs } from "@/lib/viewAsCookie";
import { companyColorSlot } from "@/lib/colors";
import { scopeProjectsToPerson } from "@/lib/scope";
import { projectHref } from "@/lib/projectHref";
import { isProjectEndedByIso, morningScopeFor } from "@/lib/projectEnded";
import {
  getAllClientsAllRows,
  getSlugByProjectName,
  sumProjectFunnels,
  lookupProjectFunnel,
  type ProjectFunnelTotals,
} from "@/lib/allClients";
import { driveFolderOwner } from "@/lib/sa";
import { costChipStyle } from "@/lib/budgetShiftSuggestions";

type AlertCounts = { severe: number; warn: number; info: number };

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Honor the gear-menu "view as" pref so the home page mirrors the
  // /tasks default-filter behavior and the top-nav projects list. Failures
  // fall back to the session user's own identity — view-as is best-effort,
  // not a security gate.
  const me = await currentUserEmail().catch(() => "");
  // prefs + view-as fetched in parallel — they were serial awaits
  // (two stacked round-trips on every home load). Speed pass 2026-06-10.
  const [prefs, viewAs] = me
    ? await Promise.all([
        getUserPrefs(me).catch(() => null),
        getEffectiveViewAs(me).catch(() => ""),
      ])
    : [null, ""];
  const isViewingAs = !!viewAs && viewAs !== me;
  const effectiveMe = viewAs || me;

  // Decide morning scope cheaply — without waiting for getMyProjects.
  // Shared with app/layout.tsx (top-nav dropdown's hide-ended filter)
  // via `morningScopeFor` so both call sites hit the same unstable_cache
  // entry — otherwise the morning feed would fetch twice per request.
  const morningScope = morningScopeFor(effectiveMe);

  const [projectsRes, countsRes, morningRes, allClientsRes, slugMapRes] =
    await Promise.allSettled([
      getMyProjects(viewAs || undefined),
      getMyCounts(viewAs || undefined),
      // Morning feed powers alert badges AND the "hide ended" filter (via
      // endIso). Returns empty for clients (gated internal-only) so we
      // silently swallow access errors.
      getMorningFeed({ scope: morningScope, overrideEmail: viewAs || undefined }),
      // ALL CLIENTS (5-min cached, read as the folder owner) + the Keys
      // name→slug map power the per-project CRM funnel strip (leads /
      // sched / held + cost-per-metric). Both are cheap cached reads that
      // overlap the ~6s morning feed, so they add ~no wall-clock. Read
      // for everyone but only joined for internal users below — a client's
      // result is discarded server-side, never serialized.
      getAllClientsAllRows(driveFolderOwner()),
      getSlugByProjectName(driveFolderOwner()),
    ]);

  const data = projectsRes.status === "fulfilled" ? projectsRes.value : null;
  const counts = countsRes.status === "fulfilled" ? countsRes.value : null;
  const morning: MorningFeed | null =
    morningRes.status === "fulfilled" ? morningRes.value : null;
  const error =
    projectsRes.status === "rejected"
      ? projectsRes.reason instanceof Error
        ? projectsRes.reason.message
        : String(projectsRes.reason)
      : null;

  // Authenticated but not authorized: no projects and not admin → send to /unauthorized.
  if (data && !data.isAdmin && data.projects.length === 0) {
    redirect("/unauthorized");
  }

  // Render the full access list — "הכל" mode in the filter bar shows
  // everything the API granted (blanket-access internal pool for staff;
  // owned-only for clients). The "רק שלי" toggle narrows to roster
  // membership client-side via CSS + data attributes; we precompute the
  // membership set here so the data-mine stamp lines up with the
  // existing scopeProjectsToPerson behavior (which also re-attaches each
  // represented company's כללי project + falls back to the full list
  // when the filter would otherwise be empty for admins).
  const allProjects = data?.projects ?? [];
  const grouped = data ? groupByCompany(allProjects) : [];
  const mineKeys = data
    ? new Set(
        scopeProjectsToPerson(
          data.projects,
          data.person,
          data.isClient,
        ).map((p) => `${p.company}|${p.name}`),
      )
    : new Set<string>();

  // Per-project portfolio metrics — budget / spend / flight-window / CRM
  // funnel — derived DIRECTLY from the ALL CLIENTS sheet, NOT the Apps Script
  // morning feed. The morning feed is flaky (Apps Script), and when it was
  // down it blanked every pill's metrics AND broke the active/ended filters
  // (nothing got a data-ended / data-inactive stamp, so the filter hid
  // nothing). The direct read is the same source the project pages use.
  //
  // Internal-only: leads + cost must never reach a client render, so gate on
  // the caller not being a client (the morning feed — empty for clients — was
  // the previous internal proxy for exactly this reason). When we can't build
  // the metrics (a client, or the reads failed) the maps stay empty and the
  // filters simply show everything, matching the prior no-feed behavior.
  const todayIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
  }).format(new Date());
  const pctTimeFor = (startIso: string, endIso: string): number => {
    if (!startIso || !endIso) return 0;
    const s = Date.parse(startIso + "T00:00:00Z");
    const e = Date.parse(endIso + "T00:00:00Z");
    const t = Date.parse(todayIso + "T00:00:00Z");
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
    const total = e - s;
    return Math.min(Math.max(t - s, 0), total) / total;
  };

  const showPortfolioMetrics =
    !!data &&
    !data.isClient &&
    allClientsRes.status === "fulfilled" &&
    slugMapRes.status === "fulfilled";
  const funnelIndex = showPortfolioMetrics
    ? sumProjectFunnels(allClientsRes.value)
    : null;
  const slugByName =
    slugMapRes.status === "fulfilled"
      ? slugMapRes.value
      : new Map<string, string>();

  const endIsoByProject = new Map<string, string>();
  const inactiveByProject = new Set<string>();
  // Budget + time progress per project (native — was `morning`-sourced).
  const progressByProject = new Map<
    string,
    { pctBudget: number; pctTime: number; budget: number; spend: number }
  >();
  // Per-project CRM funnel (leads → scheduled → held) + blended cost-per.
  const funnelByProject = new Map<string, ProjectFunnelTotals>();
  if (funnelIndex) {
    for (const p of allProjects) {
      // General (כללי) is never a media project — leave it out of the metric
      // maps so it's never marked inactive / ended.
      if (p.name === GENERAL_PROJECT_NAME) continue;
      const f = lookupProjectFunnel(
        funnelIndex,
        p.name,
        slugByName.get(p.name.toLowerCase().trim()),
      );
      // No ALL CLIENTS match → leave the pill untouched (don't risk hiding a
      // live project on a name/slug join miss).
      if (!f) continue;
      if (f.endIso) endIsoByProject.set(p.name, f.endIso);
      // "inactive" = no spend has landed AND no budget is planned. The budget
      // check keeps day-1-of-month projects (spend still 0) visible.
      if (!(f.spend > 0) && !(f.budget > 0)) inactiveByProject.add(p.name);
      if (f.budget > 0 || (f.startIso && f.endIso)) {
        progressByProject.set(p.name, {
          pctBudget: f.budget > 0 ? f.spend / f.budget : 0,
          pctTime: pctTimeFor(f.startIso, f.endIso),
          budget: f.budget,
          spend: f.spend,
        });
      }
      if (f.leads > 0 || f.scheduled > 0 || f.held > 0) {
        funnelByProject.set(p.name, f);
      }
    }
  }
  const byProject = counts?.byProject ?? {};

  // Company-level aggregates. Sum per-project counts for each company
  // group so we can render a "6 tasks + 2 mentions" summary on the
  // collapsed company bar.
  const byCompany = new Map<string, MyCountsPerProject>();
  for (const g of grouped) {
    let openTasks = 0;
    let openMentions = 0;
    for (const p of g.projects) {
      const pc = byProject[p.name];
      if (pc) {
        openTasks += pc.openTasks;
        openMentions += pc.openMentions;
      }
    }
    byCompany.set(g.company || "__ungrouped", { openTasks, openMentions });
  }

  // Alert counts per project + per company, built from the morning feed.
  // Dismissed signals are explicitly excluded so badges reflect what still
  // needs attention — matches the severity-count logic inside the feed.
  // Alert badge counts stay sourced from the morning feed — the alert
  // *signals* are the morning-feed computation itself and have no direct
  // equivalent. When the feed is down, pills just show no alert badge (the
  // metrics + filters no longer depend on it).
  const alertsByProject = new Map<string, AlertCounts>();
  if (morning) {
    for (const p of morning.projects) {
      const ac: AlertCounts = { severe: 0, warn: 0, info: 0 };
      for (const s of p.signals) {
        if (s.dismissed) continue;
        if (s.severity === "severe") ac.severe++;
        else if (s.severity === "warn") ac.warn++;
        else if (s.severity === "info") ac.info++;
      }
      if (ac.severe || ac.warn || ac.info) {
        alertsByProject.set(p.name, ac);
      }
    }
  }
  const alertsByCompany = new Map<string, AlertCounts>();
  for (const g of grouped) {
    const agg: AlertCounts = { severe: 0, warn: 0, info: 0 };
    for (const p of g.projects) {
      const ac = alertsByProject.get(p.name);
      if (ac) {
        agg.severe += ac.severe;
        agg.warn += ac.warn;
        agg.info += ac.info;
      }
    }
    if (agg.severe || agg.warn || agg.info) {
      alertsByCompany.set(g.company || "__ungrouped", agg);
    }
  }

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>📂</span>
            פרויקטים
          </h1>
          {data && (
            <div className="subtitle">
              מחובר כ-<span dir="ltr">{data.email}</span>
              {data.isAdmin && " · 👑 אדמין"}
              {isViewingAs && (
                <>
                  {" "}· 👁️ <b>מציג כ-<span dir="ltr">{viewAs}</span></b> (שינוי
                  בגלגל ההגדרות)
                </>
              )}
            </div>
          )}
        </div>
        <HomeFilterBar />
      </header>

      {error && (
        <div className="error">
          <strong>שגיאה בטעינת הפרויקטים.</strong>
          <br />
          {error}
          <br />
          <br />
          בדוק את <code>APPS_SCRIPT_API_URL</code>,{" "}
          <code>APPS_SCRIPT_API_TOKEN</code>, ו-<code>DEV_USER_EMAIL</code> ב-
          <code>.env.local</code>.
        </div>
      )}

      {data && data.projects.length === 0 && (
        <div className="empty">
          <span className="emoji" aria-hidden>🗂️</span>
          אין פרויקטים שיש לך גישה אליהם עדיין.
        </div>
      )}

      {grouped.length > 0 && (
        <StaggerReveal
          className="company-groups"
          childSelector=":scope > .company-group"
        >
          {grouped.map((g) => {
            const slot = companyColorSlot(g.company || "__ungrouped");
            // A company is "fully ended" only when every one of its projects
            // is past-end. CSS uses data-all-ended="1" on the whole group to
            // hide the group (not just its rows) when hide-ended is active.
            const allEnded =
              g.projects.length > 0 &&
              g.projects.every((p) =>
                isProjectEndedByIso(endIsoByProject.get(p.name)),
              );
            // "רק שלי" filter — a project is "mine" when the viewer is
            // on its roster (matches the /tasks-page semantic of "you
            // are involved in this work"). Membership is precomputed
            // server-side via scopeProjectsToPerson (which also handles
            // the company-כללי re-attachment + admin empty-fallback);
            // we stamp data-mine on each <li> + data-any-mine on each
            // <details>. The toggle in HomeFilterBar flips
            // <html data-show-mine> and CSS hides the "0" rows/groups.
            const anyMine = g.projects.some((p) =>
              mineKeys.has(`${p.company}|${p.name}`),
            );
            // "Fully inactive" — every non-General project is paused/
            // never-ran. General (כללי) is excluded so a company that
            // only has its catch-all as "active" still collapses out
            // when hide-inactive is on.
            const allInactive =
              g.projects.filter((p) => p.name !== GENERAL_PROJECT_NAME).length > 0 &&
              g.projects
                .filter((p) => p.name !== GENERAL_PROJECT_NAME)
                .every((p) => inactiveByProject.has(p.name));
            return (
              <details
                key={g.company || "__ungrouped"}
                className="company-group"
                data-co={slot}
                data-all-ended={allEnded ? "1" : "0"}
                data-all-inactive={allInactive ? "1" : "0"}
                data-any-mine={anyMine ? "1" : "0"}
              >
                <summary className="company-group-summary">
                  <span className="company-group-name">
                    {g.company || "ללא חברה"}
                  </span>
                  <AlertPills
                    counts={alertsByCompany.get(g.company || "__ungrouped")}
                  />
                  <ProjectPillBadges
                    counts={byCompany.get(g.company || "__ungrouped")}
                  />
                  <span
                    className="company-group-count"
                    title={`${g.projects.length} פרויקטים בחברה זו`}
                    aria-label={`${g.projects.length} פרויקטים`}
                  >
                    📁 {g.projects.length}
                  </span>
                  <span className="company-group-chevron" aria-hidden>
                    ▸
                  </span>
                </summary>
                <ul className="project-list">
                  {g.projects.map((p) => {
                    const pc = byProject[p.name];
                    const ac = alertsByProject.get(p.name);
                    const pg = progressByProject.get(p.name);
                    const pf = funnelByProject.get(p.name);
                    const ended = isProjectEndedByIso(
                      endIsoByProject.get(p.name),
                    );
                    const isMine = mineKeys.has(`${p.company}|${p.name}`);
                    const isGeneral = p.name === GENERAL_PROJECT_NAME;
                    const inactive = !isGeneral && inactiveByProject.has(p.name);
                    return (
                      <li
                        key={p.name}
                        data-ended={ended ? "1" : "0"}
                        data-inactive={inactive ? "1" : "0"}
                        data-mine={isMine ? "1" : "0"}
                        data-general={isGeneral ? "1" : "0"}
                      >
                        <Link href={projectHref(p.name, p.company)}>
                          <div className="project-pill-top">
                            <span className="project-pill-name">{p.name}</span>
                            <AlertPills counts={ac} />
                            <ProjectPillBadges counts={pc} />
                          </div>
                          {pg && <ProjectPillProgress progress={pg} />}
                          {pf && <ProjectPillFunnel funnel={pf} />}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </details>
            );
          })}
        </StaggerReveal>
      )}
    </main>
  );
}

/* ─── Subcomponents ──────────────────────────────────────────────── */

/**
 * Alert-severity pills — shown at both company and project levels when
 * the morning feed fired active signals. Dismissed alerts are excluded
 * server-side so these reflect what still needs attention. Internal /
 * admin only — for clients the morning feed returns empty and these
 * don't render.
 */
function AlertPills({ counts }: { counts: AlertCounts | undefined }) {
  if (!counts) return null;
  if (!counts.severe && !counts.warn && !counts.info) return null;
  return (
    <span className="pill-badges">
      {counts.severe > 0 && (
        <span
          className="pill-badge pill-badge-severe"
          title={`${counts.severe} התראות קריטיות`}
          aria-label={`${counts.severe} התראות קריטיות`}
        >
          🔥 {counts.severe}
        </span>
      )}
      {counts.warn > 0 && (
        <span
          className="pill-badge pill-badge-warn"
          title={`${counts.warn} אזהרות`}
          aria-label={`${counts.warn} אזהרות`}
        >
          ⚠️ {counts.warn}
        </span>
      )}
      {counts.info > 0 && (
        <span
          className="pill-badge pill-badge-info"
          title={`${counts.info} התראות מידע`}
          aria-label={`${counts.info} התראות מידע`}
        >
          📅 {counts.info}
        </span>
      )}
    </span>
  );
}

/**
 * Per-project badges shown at the end of each pill. Only rendered when
 * there's something waiting for the user on that project — zero counts
 * keep the pill visually clean.
 */
function ProjectPillBadges({
  counts,
}: {
  counts: MyCountsPerProject | undefined;
}) {
  if (!counts) return null;
  const { openTasks, openMentions } = counts;
  if (openTasks === 0 && openMentions === 0) return null;
  return (
    <span className="pill-badges">
      {openTasks > 0 && (
        <span
          className="pill-badge pill-badge-tasks"
          title={`${openTasks} משימות פתוחות בפרויקט`}
          aria-label={`${openTasks} משימות פתוחות`}
        >
          📋 {openTasks}
        </span>
      )}
      {openMentions > 0 && (
        <span
          className="pill-badge pill-badge-mentions"
          title={`${openMentions} תיוגים שלי`}
          aria-label={`${openMentions} תיוגים שלי`}
        >
          🏷️ {openMentions}
        </span>
      )}
    </span>
  );
}

/**
 * Budget-used and time-elapsed progress bars shown at the bottom of each
 * project pill. Data comes from the morning-feed call that's already happening
 * for alert badges, so no additional API round-trip. Bars only render for users
 * who receive morning-feed data (admins + internal F&F) — external clients see
 * the pill without bars.
 */
function ProjectPillProgress({
  progress,
}: {
  progress: { pctBudget: number; pctTime: number; budget: number; spend: number };
}) {
  const budgetPct = Math.round((progress.pctBudget || 0) * 100);
  const timePct = Math.round((progress.pctTime || 0) * 100);
  const budgetOver = budgetPct > 100;
  const budgetTooltip =
    progress.budget > 0
      ? `${progress.spend.toLocaleString("he-IL")} ₪ מתוך ${progress.budget.toLocaleString(
          "he-IL",
        )} ₪`
      : "אין תקציב מוגדר";
  return (
    <div className="project-pill-bars">
      <div className={`pill-bar pill-bar-budget${budgetOver ? " pill-bar-over" : ""}`}>
        <span className="pill-bar-label">תקציב</span>
        <span className="pill-bar-track" title={budgetTooltip}>
          <span
            className="pill-bar-fill"
            style={{ width: `${Math.min(budgetPct, 100)}%` }}
          />
        </span>
        <span className="pill-bar-pct">{budgetPct}%</span>
      </div>
      <div className="pill-bar pill-bar-time">
        <span className="pill-bar-label">זמן</span>
        <span className="pill-bar-track">
          <span
            className="pill-bar-fill"
            style={{ width: `${Math.min(timePct, 100)}%` }}
          />
        </span>
        <span className="pill-bar-pct">{timePct}%</span>
      </div>
    </div>
  );
}

/**
 * Mini CRM funnel shown under the progress bars: leads → scheduled → held,
 * each with its blended cost-per-metric (spend ÷ count) — the same figures
 * the project page's totals row shows. Cost chips are colored on the
 * green→red gradient shared with the budget desk (costChipStyle). Counts
 * are campaign-to-date (the full flight window). Internal-only — the caller
 * only populates funnel data for users whose morning feed returned
 * projects, so external clients never see it.
 */
function ProjectPillFunnel({ funnel }: { funnel: ProjectFunnelTotals }) {
  const ils = (v: number) =>
    v > 0 ? `₪${Math.round(v).toLocaleString("he-IL")}` : "";
  const cells: {
    metric: "cpl" | "cps" | "cpm";
    label: string;
    short: string;
    count: number;
    cost: number;
  }[] = [
    { metric: "cpl", label: "לידים", short: "ליד", count: funnel.leads, cost: funnel.cpl },
    {
      metric: "cps",
      label: "תיאומים",
      short: "תיאום",
      count: funnel.scheduled,
      cost: funnel.cps,
    },
    { metric: "cpm", label: "פגישות", short: "פגישה", count: funnel.held, cost: funnel.cpm },
  ];
  return (
    <div className="project-pill-funnel" aria-label="לידים, תיאומים ופגישות עם עלות לכל אחד">
      {cells.map((c) => {
        const chip = c.cost > 0 ? costChipStyle(c.metric, c.cost) : null;
        return (
          <div className="ppf-cell" key={c.metric}>
            <span className="ppf-count">{c.count.toLocaleString("he-IL")}</span>
            <span className="ppf-label">{c.label}</span>
            {c.cost > 0 ? (
              <span
                className="ppf-cost"
                style={chip ? { background: chip.bg, color: chip.fg } : undefined}
                title={`עלות ל${c.short}: ${ils(c.cost)}`}
              >
                {ils(c.cost)}
              </span>
            ) : (
              <span className="ppf-cost ppf-cost-empty" aria-hidden>
                —
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Group projects by company, sorted by company name (Hebrew-aware), with
 * "ללא חברה" (no company) bucket last. Projects inside each group are
 * sorted alphabetically by name.
 */
function sortProjectsHeFirstGeneralLast(
  list: Project[],
  collator: Intl.Collator,
): Project[] {
  return list.slice().sort((a, b) => {
    const aGen = a.name === GENERAL_PROJECT_NAME ? 1 : 0;
    const bGen = b.name === GENERAL_PROJECT_NAME ? 1 : 0;
    if (aGen !== bGen) return aGen - bGen; // general always last
    return collator.compare(a.name, b.name);
  });
}

function groupByCompany(
  projects: Project[],
): { company: string; projects: Project[] }[] {
  const map = new Map<string, Project[]>();
  for (const p of projects) {
    const key = (p.company || "").trim();
    const list = map.get(key) ?? [];
    list.push(p);
    map.set(key, list);
  }

  const collator = new Intl.Collator("he");
  const named = Array.from(map.entries())
    .filter(([k]) => k !== "")
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([company, list]) => ({
      company,
      projects: sortProjectsHeFirstGeneralLast(list, collator),
    }));

  const ungrouped = map.get("");
  if (ungrouped && ungrouped.length > 0) {
    named.push({
      company: "",
      projects: sortProjectsHeFirstGeneralLast(ungrouped, collator),
    });
  }

  return named;
}
