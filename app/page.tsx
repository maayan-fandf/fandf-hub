import Link from "next/link";
import { redirect } from "next/navigation";
import { getMyProjects } from "@/lib/appsScript";

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

      {data && data.projects.length > 0 && (
        <ul className="project-list">
          {data.projects.map((name) => (
            <li key={name}>
              <Link href={`/projects/${encodeURIComponent(name)}/tasks`}>
                {name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
