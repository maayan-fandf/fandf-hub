import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canSeeCampaigns } from "@/lib/userRole";
import { getProjectMetrics } from "@/lib/appsScript";
import ProjectStatsView from "@/components/ProjectStatsView";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project } = await params;
  return { title: `סטטיסטיקה — ${decodeURIComponent(project)}` };
}

/**
 * /projects/[project]/stats — internal-only statistical baseline view.
 *
 * Mirrors the bottom-of-dashboard sections (historical trend, paid-channels
 * diagnosis, scatter + bar charts, top-funnel) as a dedicated hub page.
 * The dashboard iframe is fixed-height and clips its lower sections; the
 * owner wanted these visible at full height with native scrolling and
 * direct linkability (2026-06-04). Same data source as the dashboard —
 * getProjectMetrics() — rendered natively with Recharts.
 *
 * Phase 1: shell + historical-trend chart.
 * Phase 2: paid-channels diagnosis (task #59).
 * Phase 3: scatter + bar charts + top funnel (task #60).
 *
 * Gate: canSeeCampaigns (admins / managers / media). Statistical
 * baselines are an internal tuning tool — clients don't see this page.
 */
export default async function ProjectStatsPage({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project } = await params;
  const projectName = decodeURIComponent(project);

  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/signin");
  const allowed = await canSeeCampaigns(email).catch(() => false);
  if (!allowed) redirect("/unauthorized");

  const res = await getProjectMetrics(projectName);
  if (!res.ok) {
    return (
      <main className="container">
        <header className="page-header">
          <div>
            <h1>
              <span className="emoji" aria-hidden>
                📊
              </span>
              סטטיסטיקה — {projectName}
            </h1>
          </div>
        </header>
        <div className="stats-error">
          טעינת הנתונים נכשלה: {res.error || "שגיאה לא ידועה"}
        </div>
      </main>
    );
  }

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>
              📊
            </span>
            סטטיסטיקה — {projectName}
          </h1>
          <div className="subtitle">
            ניתוח סטטיסטי מורחב — מגמה היסטורית, ביצועי ערוצים, ואבחון.{" "}
            <Link
              href={`/projects/${encodeURIComponent(projectName)}`}
              className="stats-backlink"
            >
              ← חזרה לפרויקט
            </Link>
          </div>
        </div>
      </header>
      <ProjectStatsView project={res.project} />
    </main>
  );
}
