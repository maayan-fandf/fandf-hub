import Link from "next/link";
import { redirect } from "next/navigation";
import { getMyProjects, type Project } from "@/lib/appsScript";

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
          <h1>Projects</h1>
          {data && (
            <div className="subtitle">
              Signed in as {data.email}
              {data.isAdmin && " · Admin"}
            </div>
          )}
        </div>
      </header>

      {error && (
        <div className="error">
          <strong>Failed to load projects.</strong>
          <br />
          {error}
          <br />
          <br />
          Check <code>APPS_SCRIPT_API_URL</code>,{" "}
          <code>APPS_SCRIPT_API_TOKEN</code>, and <code>DEV_USER_EMAIL</code> in{" "}
          <code>.env.local</code>.
        </div>
      )}

      {data && data.projects.length === 0 && (
        <div className="empty">No projects you have access to yet.</div>
      )}

      {grouped.length > 0 && (
        <div className="company-groups">
          {grouped.map((g) => (
            <section key={g.company || "__ungrouped"} className="company-group">
              <h2 className="company-group-title">
                {g.company || "ללא חברה"}
                <span className="company-group-count">{g.projects.length}</span>
              </h2>
              <ul className="project-list">
                {g.projects.map((p) => (
                  <li key={p.name}>
                    <Link href={`/projects/${encodeURIComponent(p.name)}`}>
                      {p.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
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
