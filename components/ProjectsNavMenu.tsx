import Link from "next/link";
import ActiveLink from "./ActiveLink";
import { GENERAL_PROJECT_NAME, type Project } from "@/lib/appsScript";
import { projectHref } from "@/lib/projectHref";
import { isProjectEndedByIso } from "@/lib/projectEnded";

// 2-level projects dropdown in the top nav. The trigger is a real Link — click
// navigates to the home page. HOVER reveals a dropdown of companies; hovering
// any company reveals that company's projects as a sub-menu popping to the
// LEFT of the company row (RTL: the sub-menu opens further "in" to the page).
// All state handled by CSS :hover / :focus-within — no React state required, so
// this can stay a plain server component.
//
// Always filtered to live — unlike the home grid, this menu has no toggle.
// Two data attributes drive it, both stamped here and hidden by CSS in
// globals.css: data-ended="1" on a project past its end date, and
// data-inactive="1" on one with no budget and no spend. A company whose
// every non-כללי project is one or the other carries data-no-live="1" and
// leaves the menu whole — its way back in is the "כל הפרויקטים" link at the
// top of this dropdown, which lands on the grid where the toggle lives.
//
// The General (כללי) catch-all is never stamped either way, so it always
// shows — the user needs somewhere to drop ad-hoc tasks. That is also why
// it is excluded from the data-no-live aggregate: it would otherwise keep
// every dormant client on the menu single-handedly.
export default function ProjectsNavMenu({
  projects,
  endIsoByProject,
  inactiveByProject,
}: {
  projects: Project[];
  /** Map of project name → endIso string. Empty object means we don't have
   *  endIso data (e.g. client user, or morning feed failed) — in that case
   *  every entry stays data-ended="0" and the hide-ended toggle has no effect
   *  on this menu, which is the safe fallback. */
  endIsoByProject: Record<string, string>;
  /** Set of project names that are currently inactive (paused-budget signal
   *  or never ran). Empty object = no filter applies, all stay data-inactive="0". */
  inactiveByProject: Record<string, true>;
}) {
  const grouped = groupByCompany(projects);
  // The dropdown menu is always filtered to active projects (see globals.css
  // — the .projects-nav-projects li[data-inactive="1"] rule is unconditional).
  // Count must reflect what the user actually sees, so subtract the inactive
  // non-General projects. General (כללי) entries are excluded from the
  // inactive set by the per-li logic below, so they still count.
  const visibleCount = projects.reduce(
    (n, p) => n + (inactiveByProject[p.name] ? 0 : 1),
    0,
  );

  return (
    <div className="projects-nav-menu">
      <ActiveLink
        href="/"
        match="exact"
        matchAlso={["/projects"]}
        className="topnav-link projects-nav-trigger"
        aria-haspopup="menu"
      >
        📂 פרויקטים
        <span className="projects-nav-chev" aria-hidden>
          ▾
        </span>
      </ActiveLink>
      <div className="projects-nav-dropdown" role="menu">
        <Link href="/" className="projects-nav-all" role="menuitem">
          כל הפרויקטים ({visibleCount})
        </Link>
        {grouped.length === 0 && (
          <div className="projects-nav-empty">אין פרויקטים זמינים</div>
        )}
        {grouped.map(({ company, projects: list }) => {
          // A company leaves the menu when nothing inside it is live —
          // every non-כללי project is past-end OR has no budget and no
          // spend. Same single predicate as the home grid (app/page.tsx),
          // deliberately: the two surfaces are meant to give the same
          // answer, and the pair of all-ended / all-inactive aggregates
          // this replaces let a company through whenever its dead
          // projects were dead in two different ways — or whenever כללי
          // (never ended, never inactive) was there to hold the average up.
          //
          // The menu has no toggle of its own; the escape hatch is the
          // "כל הפרויקטים" link at the top of this dropdown, which lands
          // on the grid where the פעילים / כל הפרויקטים toggle lives.
          const nonGeneral = list.filter(
            (p) => p.name !== GENERAL_PROJECT_NAME,
          );
          const noLive =
            nonGeneral.length > 0 &&
            nonGeneral.every(
              (p) =>
                isProjectEndedByIso(endIsoByProject[p.name]) ||
                !!inactiveByProject[p.name],
            );
          return (
            <div
              key={company}
              className="projects-nav-company"
              data-no-live={noLive ? "1" : "0"}
            >
              <div
                className="projects-nav-company-btn"
                role="menuitem"
                tabIndex={0}
              >
                <span className="projects-nav-company-name">{company}</span>
                <span className="projects-nav-company-count">
                  {/* Count only what's actually shown — the menu is
                      always-filtered to active, so the raw list length
                      would over-report. Ended counts as not-shown too:
                      the CSS hides those rows, and counting only the
                      inactive ones made a company read "2" above a
                      single visible row. */}
                  {list.reduce(
                    (n, p) =>
                      n +
                      (isProjectEndedByIso(endIsoByProject[p.name]) ||
                      inactiveByProject[p.name]
                        ? 0
                        : 1),
                    0,
                  )}
                </span>
                <span className="projects-nav-company-chev" aria-hidden>
                  ‹
                </span>
              </div>
              <ul className="projects-nav-projects" role="menu">
                {list.map((p) => {
                  const ended = isProjectEndedByIso(endIsoByProject[p.name]);
                  const isGeneral = p.name === GENERAL_PROJECT_NAME;
                  // General is never marked inactive — it's a manual
                  // catch-all (per feedback_general_project_manual) so
                  // the user should always be able to reach it.
                  const inactive = !isGeneral && !!inactiveByProject[p.name];
                  return (
                    <li
                      key={p.name}
                      data-ended={ended ? "1" : "0"}
                      data-inactive={inactive ? "1" : "0"}
                      data-general={isGeneral ? "1" : "0"}
                    >
                      <Link
                        href={projectHref(p.name, p.company)}
                        role="menuitem"
                      >
                        {p.name}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function groupByCompany(
  projects: Project[],
): { company: string; projects: Project[] }[] {
  const map = new Map<string, Project[]>();
  for (const p of projects) {
    const key = (p.company || "").trim() || "ללא חברה";
    const list = map.get(key) ?? [];
    list.push(p);
    map.set(key, list);
  }
  const collator = new Intl.Collator("he");
  return Array.from(map.entries())
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([company, list]) => ({
      company,
      projects: list.slice().sort((a, b) => {
        // Sink the per-company "general" project to the bottom of the
        // submenu — same convention as the home grid.
        const aGen = a.name === GENERAL_PROJECT_NAME ? 1 : 0;
        const bGen = b.name === GENERAL_PROJECT_NAME ? 1 : 0;
        if (aGen !== bGen) return aGen - bGen;
        return collator.compare(a.name, b.name);
      }),
    }));
}
