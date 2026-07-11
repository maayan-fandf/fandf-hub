import type { ReactNode } from "react";
import { driveFolderOwner } from "@/lib/sa";
import { getProjectReportData } from "@/lib/reportData";
import { listAlertDismissals } from "@/lib/alertDismissals";
import { getProjectAdLinks } from "@/lib/appsScript";
import ProjectRailShell, {
  type RailSection,
  type RailGroup,
  type RailTriage,
} from "@/components/report/ProjectRailShell";
import ReportHeader from "@/components/report/ReportHeader";
import ReportOverviewTab from "@/components/report/ReportOverviewTab";
import ReportChannelsTab, {
  type PacingDismissal,
  type ReportAdLinks,
} from "@/components/report/ReportChannelsTab";
import ReportCreativesTab from "@/components/report/ReportCreativesTab";
import ReportTrendsTab from "@/components/report/ReportTrendsTab";

/**
 * Server assembler for the native project page's vertical-nav rail. Fetches
 * the report data ONCE (mirroring ProjectReportSection) and dissolves the
 * report's five tabs into top-level rail sections (סקירת פעילות / ערוצים /
 * קמפיינים / מגמות), then interleaves them with the non-report sections
 * (משימות, התראות, CRM, פריסות, מחירים) which the page renders and passes
 * in as nodes. Role filtering happens on the page (client-hidden sections
 * are simply not passed), so the client shell only ever holds allowed
 * content.
 */
export default async function NativeProjectRail({
  projectName,
  period,
  company = "",
  canEditBudget = false,
  initialSection,
  tasksNode,
  alertsNode,
  crmNode,
  objNode,
  prisotNode,
  pricesNode,
  clarityNode,
  tasksBadge = 0,
}: {
  projectName: string;
  period: string;
  company?: string;
  canEditBudget?: boolean;
  initialSection?: string;
  /** משימות + הודעות (tasks queue + discussion). Always present. */
  tasksNode: ReactNode;
  /** התראות — Suspense-wrapped alerts. Null for clients / non-real-estate. */
  alertsNode?: ReactNode;
  crmNode?: ReactNode;
  /** התנגדויות ומסע — objection distribution + journey analyses (the CRM
   *  card's "analysis" view). */
  objNode?: ReactNode;
  prisotNode?: ReactNode;
  pricesNode?: ReactNode;
  /** דף נחיתה insights (Clarity) — folded under סקירת פעילות when present. */
  clarityNode?: ReactNode;
  tasksBadge?: number;
}) {
  const pacingDismissals: Record<string, PacingDismissal> = {};
  let adLinks: ReportAdLinks | null = null;
  let data = null;
  try {
    const [d, dismissals, links] = await Promise.all([
      getProjectReportData(driveFolderOwner(), projectName, period, company),
      listAlertDismissals().catch(
        () => ({}) as Awaited<ReturnType<typeof listAlertDismissals>>,
      ),
      canEditBudget
        ? getProjectAdLinks(projectName).catch(() => null)
        : Promise.resolve(null),
    ]);
    data = d;
    if (links) adLinks = { gAdsUrl: links.gAdsUrl, fbAdsUrl: links.fbAdsUrl };
    for (const [key, v] of Object.entries(dismissals)) {
      if (!key.includes("|pacing-variance|")) continue;
      pacingDismissals[key] = {
        snooze_until: v.snooze_until || "",
        dismissed_at: v.dismissed_at || "",
        reason: v.reason || "",
      };
    }
  } catch {
    data = null;
  }

  const groups: RailGroup[] = [
    { id: "work", label: "עבודה" },
    { id: "perf", label: "ביצועים" },
    { id: "leads", label: "לקוחות ולידים" },
    { id: "plan", label: "תכנון" },
  ];

  const sections: RailSection[] = [];
  const triage: RailTriage[] = [];

  sections.push({
    id: "tasks",
    group: "work",
    label: "משימות והודעות",
    icon: "📋",
    badge: tasksBadge > 0 ? { text: String(tasksBadge), tone: "accent" } : null,
    content: tasksNode,
  });
  if (alertsNode) {
    sections.push({
      id: "alerts",
      group: "work",
      label: "התראות",
      icon: "🔔",
      content: alertsNode,
    });
  }

  if (data) {
    sections.push({
      id: "overview",
      group: "perf",
      label: "סקירת פעילות",
      icon: "🧭",
      content: (
        <>
          <ReportHeader data={data} />
          <ReportOverviewTab data={data} />
          {clarityNode}
        </>
      ),
    });
    sections.push({
      id: "channels",
      group: "perf",
      label: "ערוצים",
      icon: "📊",
      content: (
        <ReportChannelsTab
          data={data}
          pacingDismissals={pacingDismissals}
          canEditBudget={canEditBudget}
          adLinks={adLinks}
        />
      ),
    });
    sections.push({
      id: "campaigns",
      group: "perf",
      label: "קמפיינים",
      icon: "📣",
      content: <ReportCreativesTab data={data} />,
    });
    sections.push({
      id: "trends",
      group: "perf",
      label: "מגמות",
      icon: "📈",
      content: <ReportTrendsTab data={data} />,
    });
  } else {
    // No campaign-ID / report fetch failed — still give the section so the
    // rail isn't missing its spine; it explains the gap.
    sections.push({
      id: "overview",
      group: "perf",
      label: "סקירת פעילות",
      icon: "🧭",
      content: (
        <div className="rpt-empty">
          אין לפרויקט הזה מזהה קמפיינים (Keys → campaign ID), אז אין נתוני
          פלטפורמות להצגה.
        </div>
      ),
    });
  }

  if (crmNode) {
    sections.push({
      id: "crm",
      group: "leads",
      label: "CRM",
      icon: "🧩",
      content: crmNode,
    });
  }
  if (objNode) {
    sections.push({
      id: "objections",
      group: "leads",
      label: "התנגדויות ומסע",
      icon: "💬",
      content: objNode,
    });
  }
  if (prisotNode) {
    sections.push({
      id: "prisot",
      group: "plan",
      label: "פריסות",
      icon: "🗂️",
      content: prisotNode,
    });
  }
  if (pricesNode) {
    sections.push({
      id: "prices",
      group: "plan",
      label: "מחירים בפרסום",
      icon: "💰",
      content: pricesNode,
    });
  }

  return (
    <ProjectRailShell
      groups={groups}
      sections={sections}
      defaultSection="overview"
      initialSection={initialSection}
      triage={triage}
    />
  );
}
