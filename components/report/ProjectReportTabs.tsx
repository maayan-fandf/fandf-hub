"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import type { ProjectReportData } from "@/lib/reportShared";
import ReportOverviewTab from "@/components/report/ReportOverviewTab";
import ReportTrendsTab from "@/components/report/ReportTrendsTab";

/**
 * Tabbed client shell for the native project report — the "tab-divided,
 * not endless scrolling" replacement for the Apps Script iframe. Mirrors
 * the /stats pattern: active tab in useState mirrored to the URL with
 * history.replaceState (no server round-trip), inactive panels kept
 * mounted behind FreezeWhenHidden so charts don't re-render on switch.
 *
 * Tabs are added per migration phase — only surfaces that are actually
 * native get a tab (no "coming soon" stubs).
 */

type TabId = "overview" | "trends";

const TAB_DEFS: { id: TabId; icon: string; label: string }[] = [
  { id: "overview", icon: "📡", label: "סקירה" },
  { id: "trends", icon: "📅", label: "מגמות" },
];

/** Keep an inactive panel mounted, returning its last-active element so
 *  React bails out of reconciling hidden charts (same as StatsPageBody). */
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

export default function ProjectReportTabs({
  data,
  initialTab,
}: {
  data: ProjectReportData;
  initialTab?: string;
}) {
  const [tab, setTabState] = useState<TabId>(
    TAB_DEFS.some((t) => t.id === initialTab) ? (initialTab as TabId) : "overview",
  );

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

  const setTab = useCallback(
    (t: TabId) => {
      setTabState(t);
      syncUrl({ rtab: t === "overview" ? null : t });
      // Recharts' ResponsiveContainer measures on resize — nudge it after
      // a hidden panel becomes visible again.
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    },
    [syncUrl],
  );

  const panelCls = (id: TabId) =>
    "stats-tabpanel" + (tab === id ? " is-active" : "");

  return (
    <div className="rpt-shell">
      <nav className="stats-tabs rpt-tabs" role="tablist" aria-label="תצוגות דוח">
        {TAB_DEFS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`rpt-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`rpt-panel-${t.id}`}
            className={"stats-tab" + (tab === t.id ? " is-active" : "")}
            onClick={() => setTab(t.id)}
          >
            <span aria-hidden>{t.icon}</span> {t.label}
          </button>
        ))}
      </nav>

      <div
        id="rpt-panel-overview"
        role="tabpanel"
        aria-labelledby="rpt-tab-overview"
        className={panelCls("overview")}
      >
        <FreezeWhenHidden active={tab === "overview"}>
          <ReportOverviewTab data={data} />
        </FreezeWhenHidden>
      </div>
      <div
        id="rpt-panel-trends"
        role="tabpanel"
        aria-labelledby="rpt-tab-trends"
        className={panelCls("trends")}
      >
        <FreezeWhenHidden active={tab === "trends"}>
          <ReportTrendsTab data={data} />
        </FreezeWhenHidden>
      </div>
    </div>
  );
}
