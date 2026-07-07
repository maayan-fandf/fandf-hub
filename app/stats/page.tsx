import { redirect } from "next/navigation";
import { canSeeCampaigns } from "@/lib/userRole";
import { currentUserEmail, getMyProjects, getProjectMetrics } from "@/lib/appsScript";
import { getPortfolioBenchmarks } from "@/lib/portfolioBenchmarks";
import { diagnosePaidChannels } from "@/lib/paidDiagnosis";
import StatsPageBody, { type StatsTabId } from "@/components/StatsPageBody";

export const dynamic = "force-dynamic";
export const metadata = { title: "סטטיסטיקה" };

/**
 * /stats — central statistical page for the whole book. Internal-only.
 *
 * 2026-07 overhaul: instead of ten stacked sections (~8,000px of
 * scroll), the page is organized as five question-shaped tabs behind a
 * KPI band + auto-insights opener:
 *
 *   סקירה      what's the state of the book right now, what changed,
 *              what needs attention (KPIs · insights · trend · outliers)
 *   פרויקטים   one sortable comparison table (replaces the old
 *              Top/Bottom-10, consistency and outlier-list sections)
 *   ערוצים     channel families as a range-bar table on a shared scale
 *              + the full P25/median/P75 distribution table (the
 *              original "main star", one click away instead of 4,300px
 *              of scrolling)
 *   ניתוח עומק correlations + gaussian strip plots (the stats-nerd layer)
 *   פרויקט     drill-down for the picked project (positioning vs the
 *              book + history + paid-channels diagnosis)
 *
 * This server component only gates + fetches; all interaction state
 * (tab, metric, periods) lives in StatsPageBody, which mirrors it to
 * the URL so links stay shareable. ?project= changes still round-trip
 * here (the drill-down needs a per-project fetch).
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
    tab?: string;
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
  // "all monthly months" default is applied inside the picker so the
  // URL stays clean for the common case).
  const selectedPeriods = (params.periods || "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const selectedPeriodsOrNull =
    selectedPeriods.length > 0 ? selectedPeriods : null;
  // Metric param — defaults to CPL.
  const rawMetric = (params.metric || "cpl").trim().toLowerCase();
  const selectedMetric: "cpl" | "cps" | "cpm" =
    rawMetric === "cps" || rawMetric === "cpm" ? rawMetric : "cpl";
  // Tab param — landing on a project link opens the drill-down.
  const rawTab = (params.tab || "").trim().toLowerCase();
  const validTabs: StatsTabId[] = [
    "overview",
    "projects",
    "channels",
    "analysis",
    "project",
  ];
  const initialTab: StatsTabId = (validTabs as string[]).includes(rawTab)
    ? (rawTab as StatsTabId)
    : selectedProject
      ? "project"
      : "overview";

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

  const project = projectRes && projectRes.ok ? projectRes.project : null;
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
            תמונת מצב, השוואות והתפלגויות על כל תיק־הלקוחות · הנתונים
            מתרעננים כ־10 דקות
          </div>
        </div>
      </header>

      <StatsPageBody
        benchmarks={benchmarks}
        aliasToRaw={aliasToRaw}
        projectNames={projectNames}
        selectedProject={selectedProject}
        compareProject={compareProject}
        project={project}
        projectError={projectError}
        diagnosis={diagnosis}
        initialMetric={selectedMetric}
        initialPeriods={selectedPeriodsOrNull}
        initialTab={initialTab}
      />
    </main>
  );
}
