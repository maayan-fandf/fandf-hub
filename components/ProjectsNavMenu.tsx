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
// Hide-ended: when html[data-hide-ended="1"] is active (HomeFilterBar toggle
// or the SSR default), per-project <li>s with data-ended="1" hide via CSS,
// and company groups where every project is ended (data-all-ended="1") hide
// entirely. Same data attributes + same CSS pattern as the home grid.
export default function ProjectsNavMenu({
  projects,
  endIsoByProject,
}: {
  projects: Project[];
  /** Map of project name → endIso string. Empty object means we don't have
   *  endIso data (e.g. client user, or morning feed failed) — in that case
   *  every entry stays data-ended="0" and the hide-ended toggle has no effect
   *  on this menu, which is the safe fallback. */
  endIsoByProject: Record<string, string>;
}) {
  const grouped = groupByCompany(projects);

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
          כל הפרויקטים ({projects.length})
        </Link>
        {grouped.length === 0 && (
          <div className="projects-nav-empty">אין פרויקטים זמינים</div>
        )}
        {grouped.map(({ company, projects: list }) => {
          // A company is "fully ended" only when every one of its projects
          // is past-end. CSS uses data-all-ended="1" to hide the whole
          // company entry (not just the inner <li>s) when hide-ended is
          // active — matches the home grid's company-group treatment.
          const allEnded =
            list.length > 0 &&
            list.every((p) => isProjectEndedByIso(endIsoByProject[p.name]));
          return (
            <div
              key={company}
              className="projects-nav-company"
              data-all-ended={allEnded ? "1" : "0"}
            >
              <div
                className="projects-nav-company-btn"
                role="menuitem"
                tabIndex={0}
              >
                <span className="projects-nav-company-name">{company}</span>
                <span className="projects-nav-company-count">{list.length}</span>
                <span className="projects-nav-company-chev" aria-hidden>
                  ‹
                </span>
              </div>
              <ul className="projects-nav-projects" role="menu">
                {list.map((p) => {
                  const ended = isProjectEndedByIso(endIsoByProject[p.name]);
                  return (
                    <li
                      key={p.name}
                      data-ended={ended ? "1" : "0"}
                      data-general={p.name === GENERAL_PROJECT_NAME ? "1" : "0"}
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
