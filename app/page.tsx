import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getMyProjects,
  getMyCounts,
  type Project,
  type MyCountsPerProject,
} from "@/lib/appsScript";
import { companyColorSlot } from "@/lib/colors";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Projects + counts in parallel — both one Apps Script call each, no shared
  // computation so no point in serializing them.
  const [projectsRes, countsRes] = await Promise.allSettled([
    getMyProjects(),
    getMyCounts(),
  ]);

  const data = projectsRes.status === "fulfilled" ? projectsRes.value : null;
  const counts = countsRes.status === "fulfilled" ? countsRes.value : null;
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

  const grouped = data ? groupByCompany(data.projects) : [];
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
            </div>
          )}
        </div>
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
            return (
              <details
                key={g.company || "__ungrouped"}
                className="company-group"
                data-co={slot}
              >
                <summary className="company-group-summary">
                  <span className="company-group-name">
                    {g.company || "ללא חברה"}
                  </span>
                  <ProjectPillBadges
                    counts={byCompany.get(g.company || "__ungrouped")}
                  />
                  <span className="company-group-count">{g.projects.length}</span>
                  <span className="company-group-chevron" aria-hidden>
                    ▸
                  </span>
                </summary>
                <ul className="project-list">
                  {g.projects.map((p) => {
                    const pc = byProject[p.name];
                    return (
                      <li key={p.name}>
                        <Link href={`/projects/${encodeURIComponent(p.name)}`}>
                          <span className="project-pill-name">{p.name}</span>
                          <ProjectPillBadges counts={pc} />
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
