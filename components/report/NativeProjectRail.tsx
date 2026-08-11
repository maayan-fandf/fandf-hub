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
  clientView = false,
  initialSection,
  tasksNode,
  alertsNode,
  crmNode,
  objNode,
  campaignsFbNode,
  prisotNode,
  pricesNode,
  clarityNode,
  mediaNode,
  mediaPlanNode,
  tasksBadge = 0,
}: {
  projectName: string;
  period: string;
  company?: string;
  canEditBudget?: boolean;
  /** Client-stripped render: negative-signal / diagnosis / ad-ops chrome is
   *  hidden (via the `rpt-clientview` class the page sets on <main>), and any
   *  budget-edit / ad-manager deep-link controls are force-disabled here so a
   *  client (or an internal user previewing the client view) never sees them.
   *  The negative-element hiding itself is CSS-driven — see globals.css. */
  clientView?: boolean;
  initialSection?: string;
  /** משימות + הודעות (tasks queue + discussion). Always present. */
  tasksNode: ReactNode;
  /** התראות — Suspense-wrapped alerts. Null for clients / non-real-estate. */
  alertsNode?: ReactNode;
  crmNode?: ReactNode;
  /** התנגדויות ומסע — objection distribution + journey analyses (the CRM
   *  card's "analysis" view). */
  objNode?: ReactNode;
  /** Facebook/Meta UTM breakdown (CRM card's "campaigns" view) — appended to
   *  the קמפיינים section. Renders nothing if the funnel has no fbBreakdown. */
  campaignsFbNode?: ReactNode;
  prisotNode?: ReactNode;
  pricesNode?: ReactNode;
  /** דף נחיתה insights (Clarity) — folded under סקירת פעילות when present. */
  clarityNode?: ReactNode;
  /** ביצועי מדיה — the non-real-estate reach/installs card. Mutually
   *  exclusive with the CRM nodes in practice: a project either has a
   *  sales funnel or it doesn't. */
  mediaNode?: ReactNode;
  /** פריסת מדיה — the forward plan behind mediaNode. */
  mediaPlanNode?: ReactNode;
  tasksBadge?: number;
}) {
  // A client (or an internal user previewing the client view) never gets the
  // budget-edit / ad-manager deep-link controls, so drop the ad-links fetch
  // and the edit gate entirely in that mode.
  const effectiveCanEdit = clientView ? false : canEditBudget;
  const pacingDismissals: Record<string, PacingDismissal> = {};
  let adLinks: ReportAdLinks | null = null;
  let data = null;
  try {
    const [d, dismissals, links] = await Promise.all([
      getProjectReportData(driveFolderOwner(), projectName, period, company),
      listAlertDismissals().catch(
        () => ({}) as Awaited<ReturnType<typeof listAlertDismissals>>,
      ),
      effectiveCanEdit
        ? getProjectAdLinks(projectName).catch(() => null)
        : Promise.resolve(null),
    ]);
    data = d;
    if (links)
      adLinks = {
        gAdsUrl: links.gAdsUrl,
        fbAdsUrl: links.fbAdsUrl,
        sheetUrl: links.sheetTabUrl || "",
      };
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

  // CRM-vs-pixel numbers are an internal diagnostic (broken tracking /
  // double-counting), not something a client should read. Strip them from
  // the payload rather than hiding them in CSS like the other negatives —
  // this way they never reach a client's browser at all, and the לידים
  // cell's tooltip + ⚠️ simply have nothing to render.
  if (clientView && data) {
    data = {
      ...data,
      channels: data.channels.map((c) => ({ ...c, pixelLeads: undefined })),
    };
  }

  // The per-ad history panel is an internal ad-ops affordance (out-of-window
  // spend + past תואמו/בוצעו). Same rule as pixelLeads above: drop it from the
  // PAYLOAD, not just from the CSS — otherwise the numbers sit in the RSC
  // flight payload and in view-source for every client. The .rpt-clientview
  // display:none entry is defence in depth, not the gate.
  if (clientView && data?.creatives) {
    data = {
      ...data,
      creatives: {
        ...data.creatives,
        fb: {
          ...data.creatives.fb,
          topAds: data.creatives.fb.topAds.map((a) => ({ ...a, history: null })),
        },
      },
    };
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
          canEditBudget={effectiveCanEdit}
          adLinks={adLinks}
        />
      ),
    });
    sections.push({
      id: "campaigns",
      group: "perf",
      label: "קמפיינים",
      icon: "📣",
      content: (
        <>
          <ReportCreativesTab data={data} />
          {campaignsFbNode}
        </>
      ),
    });
    sections.push({
      id: "trends",
      group: "perf",
      label: "מגמות",
      icon: "📈",
      content: <ReportTrendsTab data={data} />,
    });
  } else if (!mediaNode) {
    // No campaign-ID / report fetch failed — still give the section so the
    // rail isn't missing its spine; it explains the gap. Suppressed when a
    // media card is present: that project reports from its own workbook, so
    // the missing campaign ID is expected, not a gap worth announcing.
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

  if (mediaNode) {
    sections.push({
      id: "media",
      group: "perf",
      label: "ביצועי מדיה",
      icon: "📣",
      content: mediaNode,
    });
  }
  if (mediaPlanNode) {
    sections.push({
      id: "media-plan",
      group: "plan",
      label: "פריסת מדיה",
      icon: "🗂️",
      content: mediaPlanNode,
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
      // A media-workbook project has no "overview" section at all, so
      // landing on it would show the rail's not-found fallback.
      defaultSection={!data && mediaNode ? "media" : "overview"}
      initialSection={initialSection}
      triage={triage}
    />
  );
}
