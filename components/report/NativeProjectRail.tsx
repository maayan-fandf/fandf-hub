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
import ReportHeader, { LandingPreview } from "@/components/report/ReportHeader";
import GoogleAnalyticsMark from "@/components/GoogleAnalyticsMark";
import ReportOverviewTab from "@/components/report/ReportOverviewTab";
import ReportChannelsTab, {
  type PacingDismissal,
  type ReportAdLinks,
} from "@/components/report/ReportChannelsTab";
import ReportCreativesTab from "@/components/report/ReportCreativesTab";
import ReportTrendsTab from "@/components/report/ReportTrendsTab";
import ContractsSection from "@/components/report/ContractsSection";

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
  ga4Node,
  ga4ReportNode,
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
  /** Live GA4 traffic on the landing page ("עכשיו"). Leads the אנליטיקס
   *  section, above ga4ReportNode — moved there from סקירת פעילות on
   *  2026-08-26 (owner request) so all the Google Analytics data on the
   *  page lives under the Google Analytics heading. Client-visible,
   *  unlike clarityNode. */
  ga4Node?: ReactNode;
  /** Period-scoped GA4 — the body of the אנליטיקס rail section, which
   *  sits between קמפיינים and מגמות. */
  ga4ReportNode?: ReactNode;
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
        ? getProjectAdLinks(projectName).catch((e) => {
            // Swallowing this silently is exactly how the ערוצים quick-links
            // (דוח ביצועים / Google Ads / Facebook Ads) disappear with no
            // trace: every other part of the tab still renders, so nothing
            // reads as broken and the row just isn't there. Log it so the
            // next disappearance is diagnosable from the server output.
            console.error(
              `[NativeProjectRail] projectAdLinks failed for "${projectName}" — quick-links row will be hidden:`,
              e instanceof Error ? e.message : String(e),
            );
            return null;
          })
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
  //
  // `previews` rides along for a stronger reason than tidiness: a Meta
  // ad-preview link only resolves for a viewer holding a Business Manager
  // session on that ad account, so to a client it is a link to a Facebook
  // error page. Never ship it to one.
  if (clientView && data?.creatives) {
    data = {
      ...data,
      creatives: {
        ...data.creatives,
        fb: {
          ...data.creatives.fb,
          topAds: data.creatives.fb.topAds.map((a) => ({
            ...a,
            history: null,
            previews: undefined,
            // The 🗄️ warehouse-fallback marker is ad-ops plumbing — it tells
            // us a Supermetrics tab is down. A client should just see the
            // creative; the image is the same either way.
            imageFromWarehouse: undefined,
            imageLastSeen: undefined,
          })),
        },
      },
    };
  }

  // A media-workbook project (דיגיתל שלי): its own sheet is the report, and
  // its creatives mostly predate the assets tab's 60-day window.
  const mediaLed = Boolean(mediaNode);

  // Ad-preview links exist to stand in for a creative that can't be rendered.
  // On a media-workbook project that is most cards, so it keeps the full list
  // and renders the row of them under each card.
  //
  // Everywhere else this used to drop them ENTIRELY, on the reasoning that the
  // card already shows its image. That stopped being true when the
  // `facebook-ads-assets 365` tab went empty: the warehouse fallback supplies
  // a signed fbcdn URL for video creatives, it 403s once the signature
  // expires, and the card falls to "📷 אין תצוגה" — precisely when a preview
  // link is the only route left to the creative. Stripping it here meant
  // FbAdImage's empty state could never offer one (אחוזת אפרידר, 3 of 4
  // cards).
  //
  // So keep ONE. The empty state only ever uses previews[0], and a single URL
  // per card is the payload the original note was guarding against — it
  // objected to 1–6 of them, not to one.
  if (!mediaLed && data?.creatives) {
    data = {
      ...data,
      creatives: {
        ...data.creatives,
        fb: {
          ...data.creatives.fb,
          topAds: data.creatives.fb.topAds.map((a) => ({
            ...a,
            // undefined (not []) when there is none, and still undefined for a
            // client viewer — the strip above already cleared it, and a Meta
            // preview link resolves to an error page without a Business
            // Manager session.
            previews: a.previews?.length ? a.previews.slice(0, 1) : undefined,
          })),
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

  // A media-workbook client (דיגיתל שלי) reports from the media team's own
  // sheet, and only part of its spend carries a campaign ID at all — so the
  // platform-wide rollups would present a partial picture as if it were the
  // headline. Those three sections are therefore dropped for these projects
  // and the rail keeps just משימות והודעות / ביצועי מדיה / קמפיינים /
  // פריסת מדיה. קמפיינים survives because the creative cards are the one
  // platform view the workbook has no equivalent for.
  // Pushed ahead of the campaign sections so ביצועי מדיה leads the ביצועים
  // group — sections render in push order within a group, and on these
  // projects the workbook is the headline, not the platform data.
  if (mediaNode) {
    sections.push({
      id: "media",
      group: "perf",
      label: "ביצועי מדיה",
      icon: "📣",
      content: mediaNode,
    });
  }

  if (data) {
    if (!mediaLed) {
      sections.push({
        id: "overview",
        group: "perf",
        label: "סקירת פעילות",
        icon: "🧭",
        content: (
          <>
            <ReportHeader data={data} />
            <ReportOverviewTab data={data} clientView={clientView} />
            {/* Landing-page screenshots. These used to sit directly above
                the GA4 live-traffic card so the picture of the page and
                that page's visitor numbers read together; the live card
                moved to אנליטיקס on 2026-08-26, so the pairing is now
                across sections. Kept here rather than inside Ga4LiveSection
                so they still show on projects whose GA property can't be
                resolved. */}
            {data.landingUrl && (
              <LandingPreview url={data.landingUrl} project={data.project} />
            )}
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
    }
    sections.push({
      id: "campaigns",
      group: "perf",
      label: "קמפיינים",
      // 🎨 rather than 📣 — ביצועי מדיה already owns 📣, and on a media-led
      // project the two sit adjacent in the same group.
      icon: mediaLed ? "🎨" : "📣",
      content: (
        <>
          {/* Ad-preview links only where the creative can't be rendered —
              see the prop's doc block. On a normal project the card already
              shows the image, so they'd be clutter. */}
          {/* פילוח פייסבוק goes INTO the tab rather than after it — appended
              here it rendered below the Google keyword table, three Google
              blocks away from the Facebook numbers it breaks down. */}
          <ReportCreativesTab
            data={data}
            showPreviews={mediaLed}
            fbNode={campaignsFbNode}
          />
        </>
      ),
    });
    // אנליטיקס sits between קמפיינים and מגמות: campaigns say what we
    // bought, this says who actually arrived, trends say where it is
    // heading. Pushed outside the !mediaLed guard below because it does
    // not depend on platform data at all — it reads GA directly — but it
    // is still only ever non-null for real-estate projects (page.tsx).
    // Either node alone is enough to earn the section. Guarding on
    // ga4ReportNode only would have made the live card vanish outright on
    // a project that has realtime traffic but no period report, which is
    // worse than the section it used to live in being the wrong one.
    if (ga4ReportNode || ga4Node) {
      sections.push({
        id: "analytics",
        group: "perf",
        label: "אנליטיקס",
        // The real GA mark rather than an emoji — this section is
        // entirely Google Analytics data, and 📊 was already doing
        // generic duty elsewhere in the rail.
        icon: <GoogleAnalyticsMark size={15} />,
        // Live first, then the period report: "who is on the page right
        // now" is the lead-in to "who came over the period".
        content: (
          <>
            {ga4Node}
            {ga4ReportNode}
          </>
        ),
      });
    }
    if (!mediaLed) {
      sections.push({
        id: "trends",
        group: "perf",
        label: "מגמות",
        icon: "📈",
        content: <ReportTrendsTab data={data} />,
      });
    }
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
  // חוזים — what the sales are made of: which channels close, who closes
  // them, how long it takes. Shown to clients too since 2026-08-31 (owner
  // decision): these are the buyers of their own project. The endpoint
  // behind it still authorises per project, so a client opening this on a
  // project they are not listed on gets a 403 and the section's own empty
  // state rather than someone else's customers. Needs the report window,
  // hence the data guard.
  if (data) {
    sections.push({
      id: "contracts",
      group: "leads",
      label: "חוזים",
      icon: "📜",
      content: (
        <ContractsSection
          project={data.project}
          company={data.company}
          from={data.window.startIso}
          to={data.window.endIso}
        />
      ),
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
      // A media-workbook project lands on its own workbook, always. The
      // `!data` guard this replaces was written when such a project had no
      // campaign ID and therefore no platform data — the media card was the
      // only thing to land on. Give one a campaign ID (דיגיתל שלי, 2026-08-12)
      // and `data` turns truthy, which silently demoted the media card to a
      // nav click and dropped the client on a generic platform overview.
      // For these projects the media team's hand-kept workbook IS the report;
      // the platform sections are supplementary, so presence of `data` must
      // not change where you land.
      defaultSection={mediaNode ? "media" : "overview"}
      initialSection={initialSection}
      triage={triage}
    />
  );
}
