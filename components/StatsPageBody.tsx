"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { PortfolioBenchmarks } from "@/lib/portfolioBenchmarks";
import type { ProjectMetrics } from "@/lib/appsScript";
import type { DiagnosisCard } from "@/lib/paidDiagnosis";
import type { Metric } from "@/lib/statsInsights";
import StatsPicker from "@/components/StatsProjectPicker";
import StatsPeriodPicker from "@/components/StatsPeriodPicker";
import StatsMetricPicker from "@/components/StatsMetricPicker";
import StatsKpiBand from "@/components/StatsKpiBand";
import StatsInsightsPanel from "@/components/StatsInsightsPanel";
import StatsPortfolioTrend from "@/components/StatsPortfolioTrend";
import StatsOutliersPanel from "@/components/StatsOutliersPanel";
import StatsProjectTable from "@/components/StatsProjectTable";
import StatsChannelsView from "@/components/StatsChannelsView";
import StatsCorrelations from "@/components/StatsCorrelations";
import GaussianSection from "@/components/GaussianSection";
import StatsProjectPositioning from "@/components/StatsProjectPositioning";
import ProjectStatsView from "@/components/ProjectStatsView";

/**
 * /stats client shell — owns the page's interactive state and the tab
 * layout (2026-07 overhaul).
 *
 * Two speeds of interaction, split on purpose:
 *   - metric / periods / tab   → pure client state. Every consumer is
 *     a client component slicing the already-shipped benchmarks
 *     payload, so these flip instantly; the URL is kept shareable via
 *     history.replaceState (no server round-trip, no history spam).
 *   - project / compare        → router.push (the drill-down needs a
 *     server fetch of that project's metrics).
 *
 * Tabs: סקירה (KPIs, auto-insights, trend, attention) · פרויקטים
 * (consolidated sortable table) · ערוצים (range-bar table + full
 * distribution table) · ניתוח עומק (correlations + gaussians) ·
 * פרויקט (drill-down for the picked project).
 *
 * Inactive panels stay MOUNTED, hidden with height:0/visibility:hidden
 * (not display:none) so recharts' ResponsiveContainer keeps a real
 * width and charts are ready the moment a tab opens.
 */

export type StatsTabId =
  | "overview"
  | "projects"
  | "channels"
  | "analysis"
  | "project";

/**
 * Keep-alive for hidden tab panels. While inactive, keeps returning
 * the element tree from the last ACTIVE render — same reference, so
 * React bails out of reconciling the whole subtree. Without this,
 * flipping the metric re-rendered every chart on every hidden tab
 * (8 gaussian strips + 3 scatters + tables — multi-second jank); with
 * it, only the visible tab pays, and a panel catches up with current
 * props the moment it's activated.
 */
function FreezeWhenHidden({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const lastActive = useRef(children);
  if (active) lastActive.current = children;
  return <>{active ? children : lastActive.current}</>;
}

const TAB_IDS: StatsTabId[] = [
  "overview",
  "projects",
  "channels",
  "analysis",
  "project",
];

export default function StatsPageBody({
  benchmarks,
  aliasToRaw,
  projectNames,
  selectedProject,
  compareProject,
  project,
  projectError,
  diagnosis,
  initialMetric,
  initialPeriods,
  initialTab,
}: {
  benchmarks: PortfolioBenchmarks | null;
  aliasToRaw: Record<string, string[]>;
  projectNames: string[];
  selectedProject: string | null;
  compareProject: string | null;
  project: ProjectMetrics | null;
  projectError: string | null;
  diagnosis: DiagnosisCard[];
  initialMetric: Metric;
  initialPeriods: string[] | null;
  initialTab: StatsTabId;
}) {
  const router = useRouter();
  const [metric, setMetricState] = useState<Metric>(initialMetric);
  const [periods, setPeriodsState] = useState<string[] | null>(initialPeriods);
  const [tab, setTabState] = useState<StatsTabId>(initialTab);

  // Adopt server-provided state when a real navigation changes it
  // (browser back/forward, project-picker push) — the component stays
  // mounted across those, so client state would otherwise go stale
  // against the URL. Render-phase derive-from-prop-change pattern.
  const [seenInitial, setSeenInitial] = useState({
    tab: initialTab,
    metric: initialMetric,
    periods: initialPeriods?.join(",") ?? "",
  });
  const periodsKey = initialPeriods?.join(",") ?? "";
  if (
    seenInitial.tab !== initialTab ||
    seenInitial.metric !== initialMetric ||
    seenInitial.periods !== periodsKey
  ) {
    setSeenInitial({ tab: initialTab, metric: initialMetric, periods: periodsKey });
    if (seenInitial.tab !== initialTab) setTabState(initialTab);
    if (seenInitial.metric !== initialMetric) setMetricState(initialMetric);
    if (seenInitial.periods !== periodsKey) setPeriodsState(initialPeriods);
  }

  /** Mirror a client-state change into the URL without a server nav.
   *  Next 15 syncs useSearchParams from history.replaceState, so the
   *  project/compare pickers (router-based) still see fresh params. */
  const syncUrl = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === "") params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
    );
  }, []);

  const setMetric = useCallback(
    (m: Metric) => {
      setMetricState(m);
      syncUrl({ metric: m === "cpl" ? null : m }); // CPL default — keep URL clean
    },
    [syncUrl],
  );

  const setPeriods = useCallback(
    (p: string[] | null) => {
      setPeriodsState(p);
      syncUrl({ periods: p && p.length ? p.join(",") : null });
    },
    [syncUrl],
  );

  const setTab = useCallback(
    (t: StatsTabId) => {
      setTabState(t);
      syncUrl({ tab: t === "overview" ? null : t });
      // Nudge anything that measures itself (recharts) after unhide.
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    },
    [syncUrl],
  );

  /** Open a project in the drill-down tab — the one interaction that
   *  needs the server (fetches that project's metrics). */
  const selectProject = useCallback(
    (name: string) => {
      setTabState("project");
      const params = new URLSearchParams(window.location.search);
      params.set("project", name);
      params.set("tab", "project");
      router.push(`/stats?${params.toString()}`);
    },
    [router],
  );

  const onInsightAction = useCallback(
    (action: { kind: "tab" | "project"; tab?: string; project?: string }) => {
      if (action.kind === "project" && action.project) {
        selectProject(action.project);
      } else if (action.kind === "tab" && action.tab) {
        const t = action.tab as StatsTabId;
        if (TAB_IDS.includes(t)) setTab(t);
      }
    },
    [selectProject, setTab],
  );

  const tabs: Array<{ id: StatsTabId; icon: string; label: string }> = [
    { id: "overview", icon: "🏠", label: "סקירה" },
    { id: "projects", icon: "📋", label: "פרויקטים" },
    { id: "channels", icon: "📡", label: "ערוצים" },
    { id: "analysis", icon: "🔬", label: "ניתוח עומק" },
    {
      id: "project",
      icon: "🔍",
      label: selectedProject || "פרויקט",
    },
  ];

  const panelCls = (id: StatsTabId) =>
    "stats-tabpanel" + (tab === id ? " is-active" : "");

  return (
    <>
      {/* Sticky chrome — context pickers + tabs. One filter row scopes
          every tab (the pickers apply to all of them). */}
      <div className="stats-chrome">
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
              selected={periods}
              onChange={setPeriods}
            />
          )}
          <StatsMetricPicker selected={metric} onChange={setMetric} />
        </div>
        <nav className="stats-tabs" role="tablist" aria-label="תצוגות סטטיסטיקה">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`stats-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`stats-panel-${t.id}`}
              className={
                "stats-tab" +
                (tab === t.id ? " is-active" : "") +
                (t.id === "project" && !selectedProject ? " is-muted" : "")
              }
              onClick={() => setTab(t.id)}
            >
              <span aria-hidden>{t.icon}</span> {t.label}
            </button>
          ))}
        </nav>
      </div>

      {!benchmarks && (
        <section className="stats-section">
          <div className="stats-empty">
            לא ניתן לטעון את נתוני התיק. נסה לרענן.
          </div>
        </section>
      )}

      {benchmarks && (
        <>
          {/* ── סקירה ─────────────────────────────────────────── */}
          <div
            id="stats-panel-overview"
            role="tabpanel"
            aria-labelledby="stats-tab-overview"
            className={panelCls("overview")}
          >
            <FreezeWhenHidden active={tab === "overview"}>
              <StatsKpiBand benchmarks={benchmarks} />
              <StatsInsightsPanel
                benchmarks={benchmarks}
                metric={metric}
                onAction={onInsightAction}
              />
              <StatsPortfolioTrend benchmarks={benchmarks} metric={metric} />
              <StatsOutliersPanel
                benchmarks={benchmarks}
                metric={metric}
                onSelectProject={selectProject}
              />
            </FreezeWhenHidden>
          </div>

          {/* ── פרויקטים ──────────────────────────────────────── */}
          <div
            id="stats-panel-projects"
            role="tabpanel"
            aria-labelledby="stats-tab-projects"
            className={panelCls("projects")}
          >
            <FreezeWhenHidden active={tab === "projects"}>
              <StatsProjectTable
                benchmarks={benchmarks}
                metric={metric}
                onSelectProject={selectProject}
              />
            </FreezeWhenHidden>
          </div>

          {/* ── ערוצים ────────────────────────────────────────── */}
          <div
            id="stats-panel-channels"
            role="tabpanel"
            aria-labelledby="stats-tab-channels"
            className={panelCls("channels")}
          >
            <FreezeWhenHidden active={tab === "channels"}>
              <StatsChannelsView
                benchmarks={benchmarks}
                aliasToRaw={aliasToRaw}
                metric={metric}
              />
            </FreezeWhenHidden>
          </div>

          {/* ── ניתוח עומק ────────────────────────────────────── */}
          <div
            id="stats-panel-analysis"
            role="tabpanel"
            aria-labelledby="stats-tab-analysis"
            className={panelCls("analysis")}
          >
            <FreezeWhenHidden active={tab === "analysis"}>
              <StatsCorrelations
                benchmarks={benchmarks}
                highlightProject={selectedProject}
                compareProject={compareProject}
                selectedPeriods={periods}
              />
              <GaussianSection
                benchmarks={benchmarks}
                selectedProject={selectedProject}
                compareProject={compareProject}
                selectedPeriods={periods}
                metric={metric}
              />
            </FreezeWhenHidden>
          </div>

          {/* ── פרויקט (drill-down) ───────────────────────────── */}
          <div
            id="stats-panel-project"
            role="tabpanel"
            aria-labelledby="stats-tab-project"
            className={panelCls("project")}
          >
            <FreezeWhenHidden active={tab === "project"}>
            {projectError && (
              <section className="stats-section">
                <div className="stats-error">
                  טעינת הפרויקט נכשלה: {projectError}
                </div>
              </section>
            )}
            {!projectError && !project && (
              <section className="stats-section">
                <div className="stats-empty">
                  בחר פרויקט בסרגל למעלה (📋) — או לחץ על שורה בטאב
                  הפרויקטים — כדי לראות ניתוח מלא: מיצוב מול התיק, מגמה
                  היסטורית ואבחון ערוצים.
                </div>
              </section>
            )}
            {project && selectedProject && (
              <>
                <StatsProjectPositioning
                  benchmarks={benchmarks}
                  project={selectedProject}
                />
                <ProjectStatsView
                  project={project}
                  diagnosis={diagnosis}
                  selectedPeriods={periods}
                />
              </>
            )}
            </FreezeWhenHidden>
          </div>
        </>
      )}

      {/* Benchmarks failed but a project IS loaded — still show it. */}
      {!benchmarks && (project || projectError) && (
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
              selectedPeriods={periods}
            />
          )}
        </section>
      )}
    </>
  );
}
