import { redirect } from "next/navigation";
import { canSeeCampaigns } from "@/lib/userRole";
import { currentUserEmail, getMyProjects, getProjectMetrics } from "@/lib/appsScript";
import { getPortfolioBenchmarks } from "@/lib/portfolioBenchmarks";
import { diagnosePaidChannels } from "@/lib/paidDiagnosis";
import PortfolioBenchmarksTable from "@/components/PortfolioBenchmarksTable";
import StatsPicker from "@/components/StatsProjectPicker";
import StatsPeriodPicker from "@/components/StatsPeriodPicker";
import StatsMetricPicker from "@/components/StatsMetricPicker";
import StatsOutliersPanel from "@/components/StatsOutliersPanel";
import StatsRankings from "@/components/StatsRankings";
import StatsPortfolioTrend from "@/components/StatsPortfolioTrend";
import StatsChannelRanking from "@/components/StatsChannelRanking";
import StatsConsistency from "@/components/StatsConsistency";
import StatsCorrelations from "@/components/StatsCorrelations";
import ProjectStatsView from "@/components/ProjectStatsView";
import GaussianSection from "@/components/GaussianSection";

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
  searchParams: Promise<{
    project?: string;
    compare?: string;
    periods?: string;
    metric?: string;
  }>;
}) {
  // currentUserEmail() honors DEV_USER_EMAIL for local-dev auth bypass
  // (when AUTH_GOOGLE_ID is commented out in .env.local). In prod the
  // middleware enforces the NextAuth session before this page renders.
  const email = await currentUserEmail().catch(() => "");
  if (!email) redirect("/signin");
  const allowed = await canSeeCampaigns(email).catch(() => false);
  if (!allowed) redirect("/unauthorized");

  const params = await searchParams;
  const selectedProject = (params.project || "").trim() || null;
  const compareProject = (params.compare || "").trim() || null;
  // Periods param is comma-separated. Empty / absent = null (the
  // server-default "all monthly months" is applied client-side in
  // the picker so the URL stays clean for the common case).
  const selectedPeriods = (params.periods || "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const selectedPeriodsOrNull =
    selectedPeriods.length > 0 ? selectedPeriods : null;
  // Metric param — defaults to CPL. Used by both the picker (sticky
  // bar) and the Gaussian section (renders that metric).
  const rawMetric = (params.metric || "cpl").trim().toLowerCase();
  const selectedMetric: "cpl" | "cps" | "cpm" =
    rawMetric === "cps" || rawMetric === "cpm" ? rawMetric : "cpl";

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

  // Portfolio-wide alias → raw-channel-names map comes pre-built off
  // benchmarks (lib/portfolioBenchmarks.ts:compute). Falls back to an
  // empty object when benchmarks load fails.
  const aliasToRaw: Record<string, string[]> = benchmarks?.aliasToRaw || {};

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

      {/* Sticky context bar — project + period pickers at the top so
          the user can switch context without scrolling. URL-driven
          (?project=X&periods=Y,Z) so selections survive reload and
          are shareable. */}
      <div className="stats-context-bar">
        <span className="stats-context-label">📍 הקשר:</span>
        <StatsPicker
          paramName="project"
          items={projectNames}
          selected={selectedProject}
          icon="📋"
          placeholder="בחר פרויקט…"
          searchPlaceholder="חפש פרויקט…"
        />
        {selectedProject && (
          <StatsPicker
            paramName="compare"
            items={projectNames.filter((p) => p !== selectedProject)}
            selected={compareProject}
            icon="⚖"
            placeholder="השווה ל…"
            searchPlaceholder="חפש פרויקט להשוואה…"
          />
        )}
        {benchmarks && benchmarks.availablePeriods.length > 0 && (
          <StatsPeriodPicker
            availablePeriods={benchmarks.availablePeriods}
            selected={selectedPeriodsOrNull}
          />
        )}
        <StatsMetricPicker selected={selectedMetric} />
      </div>

      {/* Heads-up — auto-flagged outliers across the portfolio. Sits
          at the top so the user sees who needs attention before they
          scroll into the distribution data. */}
      {benchmarks && (
        <StatsOutliersPanel benchmarks={benchmarks} metric={selectedMetric} />
      )}

      {/* Top / Bottom 10 rankings — side-by-side leaderboards driven by
          the same project-lifetime samples the outliers panel uses. */}
      {benchmarks && (
        <StatsRankings benchmarks={benchmarks} metric={selectedMetric} />
      )}

      {/* Portfolio time-trend — direction-of-travel for the whole
          book over the past N months. */}
      {benchmarks && (
        <StatsPortfolioTrend
          benchmarks={benchmarks}
          metric={selectedMetric}
        />
      )}

      {/* Project consistency leaderboard — CV (σ/μ of monthly values)
          per project, surfaced as Most-Stable + Most-Volatile lists. */}
      {benchmarks && (
        <StatsConsistency benchmarks={benchmarks} metric={selectedMetric} />
      )}

      {/* Channel-family ranking — which families deliver best CPL
          across the portfolio. Bar chart sorted cheap → expensive. */}
      {benchmarks && (
        <StatsChannelRanking
          benchmarks={benchmarks}
          metric={selectedMetric}
        />
      )}

      {/* Funnel correlations — CPL vs CPS and CPL vs CPM. Tells you
          whether cheap leads also turn into cheap meetings, or whether
          the funnel breaks somewhere between intake and scheduling. */}
      {benchmarks && (
        <StatsCorrelations
          benchmarks={benchmarks}
          highlightProject={selectedProject}
          compareProject={compareProject}
          selectedPeriods={selectedPeriodsOrNull}
        />
      )}

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

      {/* Gaussian distribution plots — master (project-aggregate) +
          top channel families. Wrapped in a client component so the
          metric picker (CPL / CPS / CPM) can swap the grid without a
          server round-trip. Legend rendered inside. */}
      {benchmarks && (
        <GaussianSection
          benchmarks={benchmarks}
          selectedProject={selectedProject}
          compareProject={compareProject}
          selectedPeriods={selectedPeriodsOrNull}
          metric={selectedMetric}
        />
      )}

      {/* Project drill-down — only shown when a project is picked in
          the top context bar. Empty state hidden because the picker
          itself sits at the top with its own placeholder hint. */}
      {(project || projectError) && (
        <section className="stats-section">
          <h2>🔎 ניתוח פרויקט נבחר</h2>
          {projectError && (
            <div className="stats-error">
              טעינת הפרויקט נכשלה: {projectError}
            </div>
          )}
          {project && (
            <ProjectStatsView
              project={project}
              diagnosis={diagnosis}
              selectedPeriods={selectedPeriodsOrNull}
            />
          )}
        </section>
      )}
    </main>
  );
}
