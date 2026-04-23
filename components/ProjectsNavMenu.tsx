import Link from "next/link";
import ActiveLink from "./ActiveLink";
import type { Project } from "@/lib/appsScript";

// 2-level projects dropdown in the top nav. The trigger is a real Link — click
// navigates to the home page. HOVER reveals a dropdown of companies; hovering
// any company reveals that company's projects as a sub-menu popping to the
// LEFT of the company row (RTL: the sub-menu opens further "in" to the page).
// All state handled by CSS :hover / :focus-within — no React state required, so
// this can stay a plain server component.
export default function ProjectsNavMenu({ projects }: { projects: Project[] }) {
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
        {grouped.map(({ company, projects: list }) => (
          <div key={company} className="projects-nav-company">
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
              {list.map((p) => (
                <li key={p.name}>
                  <Link
                    href={`/projects/${encodeURIComponent(p.name)}`}
                    role="menuitem"
                  >
                    {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
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
      projects: list.slice().sort((a, b) => collator.compare(a.name, b.name)),
    }));
}
