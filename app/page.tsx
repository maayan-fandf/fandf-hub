import Link from "next/link";
import { redirect } from "next/navigation";
import HomeFilterBar from "@/components/HomeFilterBar";
import {
  getMyProjects,
  getMyCounts,
  getMorningFeed,
  currentUserEmail,
  type Project,
  type MyCountsPerProject,
  type MorningFeed,
} from "@/lib/appsScript";
import { getUserPrefs } from "@/lib/userPrefs";
import { companyColorSlot } from "@/lib/colors";

type AlertCounts = { severe: number; warn: number; info: number };

export const dynamic = "force-dynamic";

/** True if the project's morning-feed endIso is more than 5 days in the past. */
function isProjectEndedByIso(endIso: string | undefined): boolean {
  if (!endIso) return false;
  const end = new Date(endIso + "T00:00:00");
  if (isNaN(end.getTime())) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 5);
  cutoff.setHours(0, 0, 0, 0);
  return end < cutoff;
}

export default async function HomePage() {
  // Honor the gear-menu "view as" pref so the home page mirrors the
  // /tasks default-filter behavior and the top-nav projects list. Failures
  // fall back to the session user's own identity — view-as is best-effort,
  // not a security gate.
  const me = await currentUserEmail().catch(() => "");
  const prefs = me ? await getUserPrefs(me).catch(() => null) : null;
  const viewAs = prefs?.view_as_email || "";
  const isViewingAs = !!viewAs && viewAs !== me;
  const effectiveMe = viewAs || me;

  // Decide morning scope cheaply — without waiting for getMyProjects.
  // Admins (HUB_ADMIN_EMAILS) + @fandf.co.il domain users get scope=all
  // (they have access to everything); everyone else gets scope=mine.
  // Matches the previous "isAdmin || isStaff" check closely enough for
  // the morning feed; the projects call still applies access control
  // downstream regardless. The win: all three reads now run truly in
  // parallel, removing the serial 3+s wait.
  const HUB_ADMIN_EMAILS = new Set([
    "maayan@fandf.co.il",
    "nadav@fandf.co.il",
    "felix@fandf.co.il",
  ]);
  const lcEffectiveMe = effectiveMe.toLowerCase().trim();
  const morningScope: "all" | "mine" =
    HUB_ADMIN_EMAILS.has(lcEffectiveMe) || lcEffectiveMe.endsWith("@fandf.co.il")
      ? "all"
      : "mine";

  const [projectsRes, countsRes, morningRes] = await Promise.allSettled([
    getMyProjects(viewAs || undefined),
    getMyCounts(viewAs || undefined),
    // Morning feed powers alert badges AND the "hide ended" filter (via
    // endIso). Returns empty for clients (gated internal-only) so we
    // silently swallow access errors.
    getMorningFeed({ scope: morningScope, overrideEmail: viewAs || undefined }),
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

  // Per-person scoping is now driven entirely by the gear-menu "view as"
  // pref above (passed into getMyProjects). The home grid renders whatever
  // projects came back — no client-side person filter on top.
  const grouped = data ? groupByCompany(data.projects) : [];

  // endIso map from the morning feed — powers the hide-ended filter.
  const endIsoByProject = new Map<string, string>();
  if (morning) {
    for (const p of morning.projects) {
      if (p.endIso) endIsoByProject.set(p.name, p.endIso);
    }
  }
  const byProject = counts?.byProject ?? {};
  const totals = counts?.total ?? { openTasks: 0, openMentions: 0 };

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
  const alertsByProject = new Map<string, AlertCounts>();
  // Budget + time progress per project, also from morning feed. Piggy-backs
  // on the fetch that's already happening for alerts — no extra API call.
  const progressByProject = new Map<
    string,
    { pctBudget: number; pctTime: number; budget: number; spend: number }
  >();
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
      if (p.budget > 0 || p.daysTotal > 0) {
        progressByProject.set(p.name, {
          pctBudget: p.pctBudget,
          pctTime: p.pctTime,
          budget: p.budget,
          spend: p.spend,
        });
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

      {counts && (
        <div className="stats-grid home-stats">
          <StatTile
            variant="tasks"
            label="📋 משימות פתוחות"
            value={totals.openTasks}
          />
          <StatTile
            variant="mentions"
            label="🏷️ תיוגים שלי"
            value={totals.openMentions}
          />
        </div>
      )}

      {grouped.length > 0 && (
        <div className="company-groups">
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
            return (
              <details
                key={g.company || "__ungrouped"}
                className="company-group"
                data-co={slot}
                data-all-ended={allEnded ? "1" : "0"}
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
                    const ended = isProjectEndedByIso(
                      endIsoByProject.get(p.name),
                    );
                    return (
                      <li key={p.name} data-ended={ended ? "1" : "0"}>
                        <Link href={`/projects/${encodeURIComponent(p.name)}`}>
                          <div className="project-pill-top">
                            <span className="project-pill-name">{p.name}</span>
                            <AlertPills counts={ac} />
                            <ProjectPillBadges counts={pc} />
                          </div>
                          {pg && <ProjectPillProgress progress={pg} />}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </main>
  );
}

/* ─── Subcomponents ──────────────────────────────────────────────── */

function StatTile({
  variant,
  label,
  value,
}: {
  variant: "tasks" | "mentions";
  label: string;
  value: number;
}) {
  return (
    <div className={`stat-tile stat-tile-${variant}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

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
 * Group projects by company, sorted by company name (Hebrew-aware), with
 * "ללא חברה" (no company) bucket last. Projects inside each group are
 * sorted alphabetically by name.
 */
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
      projects: list.slice().sort((a, b) => collator.compare(a.name, b.name)),
    }));

  const ungrouped = map.get("");
  if (ungrouped && ungrouped.length > 0) {
    named.push({
      company: "",
      projects: ungrouped.slice().sort((a, b) => collator.compare(a.name, b.name)),
    });
  }

  return named;
}
