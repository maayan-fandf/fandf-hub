import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { canSeeCampaigns } from "@/lib/userRole";
import { getMyProjects, getProjectMetrics } from "@/lib/appsScript";
import { getPortfolioBenchmarks } from "@/lib/portfolioBenchmarks";
import { diagnosePaidChannels } from "@/lib/paidDiagnosis";
import { channelAlias } from "@/lib/channelAlias";
import PortfolioBenchmarksTable from "@/components/PortfolioBenchmarksTable";
import StatsProjectPicker from "@/components/StatsProjectPicker";
import ProjectStatsView from "@/components/ProjectStatsView";

export const dynamic = "force-dynamic";
export const metadata = { title: "סטטיסטיקה" };

/**
 * /stats — central statistical baselines page. Internal-only.
 *
 * Centerpiece: the portfolio benchmarks distribution table — what the
 * dashboard renders at the very bottom (renderBenchmarksOverview),
 * showing CPL/CPS/CPM P25/median/P75 per channel-family + per-project
 * aggregate across the entire portfolio. This is the "main star" the
 * owner wanted accessible without scrolling through one project's
 * dashboard (2026-06-04).
 *
 * Below the table: project picker dropdown. Pick a project to drill
 * in — that project's hero totals, historical trend chart, and paid-
 * channels diagnosis render below. URL-driven (?project=X) so the
 * drill-down is shareable and survives reload.
 *
 * Replaces /projects/[project]/stats (still mounted, redirects here).
 *
 * Gate: canSeeCampaigns (admins / managers / media).
 */
export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/signin");
  const allowed = await canSeeCampaigns(email).catch(() => false);
  if (!allowed) redirect("/unauthorized");

  const params = await searchParams;
  const selectedProject = (params.project || "").trim() || null;

  // Always fetch: portfolio benchmarks + project list. In parallel.
  // Selected project's metrics are an additional fetch (also parallel).
  const projectFetch = selectedProject
    ? getProjectMetrics(selectedProject).catch(
        (e): { ok: false; error: string } => ({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      )
    : Promise.resolve(null);

  const [benchmarks, myProjects, projectRes] = await Promise.all([
    getPortfolioBenchmarks().catch(() => null),
    getMyProjects().catch(() => ({ projects: [] as Array<{ name: string }> })),
    projectFetch,
  ]);

  // Project list for dropdown. Sorted alphabetically — the picker is
  // searchable so order matters less.
  const projectNames = Array.from(
    new Set(
      (myProjects.projects || [])
        .map((p) => p.name)
        .filter((n) => n && n.trim().length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b, "he"));

  // For the per-channel benchmarks table, we want a hover tooltip that
  // shows the raw channel names that normalize into each alias bucket.
  // Build alias → raw-names map from the diagnosis source we already
  // have (project metrics aren't loaded for all projects here, so we
  // derive aliases from what's in benchmarks only — the hover hint will
  // miss aliases that aren't yet in any project, but that's fine).
  const aliasToRaw: Record<string, string[]> = {};
  if (projectRes && projectRes.ok) {
    for (const c of projectRes.project.channels || []) {
      const a = channelAlias(c.channel);
      if (!aliasToRaw[a]) aliasToRaw[a] = [];
      if (!aliasToRaw[a].includes(c.channel)) aliasToRaw[a].push(c.channel);
    }
  }

  const project =
    projectRes && projectRes.ok ? projectRes.project : null;
  const projectError =
    projectRes && !projectRes.ok ? projectRes.error : null;

  const diagnosis = project
    ? diagnosePaidChannels(project.channels, benchmarks)
    : [];

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>
              📊
            </span>
            סטטיסטיקה
          </h1>
          <div className="subtitle">
            התפלגות תיק־הלקוחות (CPL · CPS · CPM) ושכבת אבחון פר־פרויקט.
          </div>
        </div>
      </header>

      {/* Portfolio stats table — the main star. Always shown. */}
      <section className="stats-section">
        <h2>🏛 התפלגות התיק</h2>
        {benchmarks ? (
          <PortfolioBenchmarksTable
            benchmarks={benchmarks}
            aliasToRaw={aliasToRaw}
          />
        ) : (
          <div className="stats-empty">
            לא ניתן לטעון את נתוני התיק. נסה לרענן.
          </div>
        )}
      </section>

      {/* Project drill-down */}
      <section className="stats-section">
        <h2>🔎 ניתוח פר־פרויקט</h2>
        <StatsProjectPicker
          projects={projectNames}
          selected={selectedProject}
        />
        {projectError && (
          <div className="stats-error" style={{ marginTop: "1em" }}>
            טעינת הפרויקט נכשלה: {projectError}
          </div>
        )}
        {!selectedProject && (
          <div className="stats-empty" style={{ marginTop: "1em" }}>
            בחר פרויקט מהרשימה כדי לראות מגמה היסטורית + אבחון מדיה.
          </div>
        )}
        {project && <ProjectStatsView project={project} diagnosis={diagnosis} />}
      </section>
    </main>
  );
}
