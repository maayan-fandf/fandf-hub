import Link from "next/link";
import { redirect } from "next/navigation";
import { getMyProjects, type Project } from "@/lib/appsScript";
import { companyColorVars } from "@/lib/colors";

// Tiny helper — casts the CSS custom-property object to React's style type
// so TypeScript lets us apply it.
type CSSVars = React.CSSProperties & Record<`--${string}`, string>;

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let data;
  let error: string | null = null;
  try {
    data = await getMyProjects();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Authenticated but not authorized: no projects and not admin → send to /unauthorized.
  if (data && !data.isAdmin && data.projects.length === 0) {
    redirect("/unauthorized");
  }

  const grouped = data ? groupByCompany(data.projects) : [];

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

      {grouped.length > 0 && (
        <div className="company-groups">
          {grouped.map((g) => {
            const colorVars = companyColorVars(g.company || "__ungrouped");
            return (
              <details
                key={g.company || "__ungrouped"}
                className="company-group"
                style={colorVars as CSSVars}
              >
                <summary className="company-group-summary">
                  <span className="company-group-name">
                    {g.company || "ללא חברה"}
                  </span>
                  <span className="company-group-count">{g.projects.length}</span>
                  <span className="company-group-chevron" aria-hidden>
                    ▸
                  </span>
                </summary>
                <ul className="project-list">
                  {g.projects.map((p) => (
                    <li key={p.name}>
                      <Link href={`/projects/${encodeURIComponent(p.name)}`}>
                        {p.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      )}
    </main>
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
