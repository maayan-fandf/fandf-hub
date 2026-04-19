import Link from "next/link";
import { getMyProjects } from "@/lib/appsScript";
import MetricsIframe from "@/components/MetricsIframe";

export const dynamic = "force-dynamic";

type Params = { project: string };

/**
 * Per-project metrics page — iframes the Apps Script dashboard filtered to
 * this specific company + project. The dashboard accepts
 * `?company=X&project=Y` in its URL (per CLIENT_DASHBOARD.md) and auto-
 * applies those filters on load.
 *
 * We rely on the end-user's Google session to auth the iframe (dashboard
 * deployment uses USER_ACCESSING). If that fails — third-party cookies
 * blocked, sign-in loop, etc. — MetricsIframe always renders a prominent
 * "open in new tab" fallback so the user is never stuck.
 */
export default async function MetricsPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { project: projectParam } = await params;
  const projectName = decodeURIComponent(projectParam);

  // Look up the project's company so we can filter the dashboard URL
  // properly. getMyProjects is cheap and we've been using it as the /api/me
  // equivalent — it's already memoized for this request.
  let company = "";
  let loadError: string | null = null;
  try {
    const me = await getMyProjects();
    const p = me.projects.find((x) => x.name === projectName);
    company = p?.company ?? "";
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const dashboardBaseUrl = process.env.DASHBOARD_URL ?? "";
  const dashboardUrl = dashboardBaseUrl
    ? buildDashboardUrl(dashboardBaseUrl, { company, project: projectName })
    : "";

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>📊</span>
            {projectName} · מטריקות
          </h1>
          <div className="subtitle">
            <Link href={`/projects/${encodeURIComponent(projectName)}`}>
              → סקירת {projectName}
            </Link>
          </div>
        </div>
      </header>

      {loadError && (
        <div className="error">
          <strong>שגיאה בטעינת הפרויקט.</strong>
          <br />
          {loadError}
        </div>
      )}

      {!dashboardUrl && !loadError && (
        <div className="error">
          <strong>חסרה הגדרה:</strong> משתנה סביבה <code>DASHBOARD_URL</code> לא
          מוגדר ב-hub.
        </div>
      )}

      {dashboardUrl && (
        <MetricsIframe src={dashboardUrl} projectName={projectName} />
      )}
    </main>
  );
}

/** Append project+company filter query params, preserving any existing ones. */
function buildDashboardUrl(
  base: string,
  filters: { company?: string; project?: string },
): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return base;
  }
  if (filters.company) url.searchParams.set("company", filters.company);
  if (filters.project) url.searchParams.set("project", filters.project);
  return url.toString();
}
