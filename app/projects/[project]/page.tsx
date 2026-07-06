export async function generateMetadata({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project } = await params;
  return { title: decodeURIComponent(project) };
}

import Link from "next/link";
import { Suspense } from "react";
import {
  getAvailableMonths,
  getProjectComments,
  getMyMentions,
  getMyProjects,
  getMorningFeed,
  tasksList,
  tasksPeopleList,
  type CommentItem,
  type MentionItem,
  type MorningProject,
} from "@/lib/appsScript";
import DashboardMonthOverridePicker from "@/components/DashboardMonthOverridePicker";
import LatestPrisotCard from "@/components/LatestPrisotCard";
import CrmFunnelCard from "@/components/CrmFunnelCard";
import ClarityInsightsSection from "@/components/ClarityInsightsSection";
import ProjectPriceCheckSection from "@/components/ProjectPriceCheckSection";
import ClientPrisaApprovalPrompt from "@/components/ClientPrisaApprovalPrompt";
import PageHeaderShrinkObserver from "@/components/PageHeaderShrinkObserver";
import { getCrmFunnelForProject } from "@/lib/crmData";
import { isRealEstateType } from "@/lib/keys";
import { computeCrmAlerts } from "@/lib/crmAlerts";
import { listAlertDismissals, applyDismissalsToSignals } from "@/lib/alertDismissals";
import { getAllClientsCurrentForProject, type AllClientsRow } from "@/lib/allClients";
import { driveFolderOwner } from "@/lib/sa";
import ClientChatComposer from "@/components/ClientChatComposer";
import TasksQueue from "@/components/TasksQueue";
import Avatar from "@/components/Avatar";
import MetricsIframe from "@/components/MetricsIframe";
import CardActions from "@/components/CardActions";
import CommentBodyExpandable from "@/components/CommentBodyExpandable";
import { personDisplayName } from "@/lib/personDisplay";
import ThreadReplies from "@/components/ThreadReplies";
import MorningSignalRow from "@/components/MorningSignalRow";
import ProjectFilterBar from "@/components/ProjectFilterBar";
import OutOfScopeBanner from "@/components/OutOfScopeBanner";
import { isPersonOnProject } from "@/lib/scope";
import { getScopedPerson } from "@/lib/scope-server";
import {
  findProjectFolderUrlCached,
  getSharedDriveName,
} from "@/lib/driveFolders";
import { buildLocalDrivePaths } from "@/lib/localDrivePath";
import { currentUserEmail } from "@/lib/appsScript";
import { viewerCanEditComment as viewerCanEdit } from "@/lib/commentPermissions";
import CopyLocalPathButton from "@/components/CopyLocalPathButton";
import GoogleDriveIcon from "@/components/GoogleDriveIcon";

export const dynamic = "force-dynamic";

type Params = { project: string };
type Search = {
  resolved?: string;
  person?: string;
  /** Discussion section view — "all" shows the project-wide feed,
   *  "mine" filters to threads where I'm tagged. Absent = auto-pick:
   *  flips to "mine" when the user has open mentions on this project,
   *  otherwise "all". User-driven toggle clicks always set the param
   *  explicitly so refresh / back-button preserve the choice. */
  view?: string;
  /** Outer discussion channel — "internal" (Google Chat-backed,
   *  internal team only) or "client" (hub Comments, internal +
   *  client). Default is role-aware: internal users land on
   *  "internal", clients (and unknown roles) on "client". User-
   *  driven tab clicks set the param explicitly. */
  channel?: string;
  /** Company scope. Only meaningful when the project name isn't
   *  globally unique (today: only "כללי"). When supplied, the
   *  page resolves projectMeta + chatSpaceUrl + Drive folder etc.
   *  scoped to this company. Without it, falls back to the legacy
   *  "first project with this name in the user's roster" behavior
   *  for backwards compatibility with old links. */
  company?: string;
  /** Rewinds the embedded dashboard to a specific calendar month —
   *  "YYYY-MM". Threaded into the iframe URL so the picker change
   *  triggers a clean page+iframe re-render with month-override
   *  applied at the data layer. Empty/invalid → live mode. */
  monthOverride?: string;
  /** Free CRM-funnel date range (`?from=YYYY-MM-DD&to=YYYY-MM-DD`). When
   *  both are valid it supersedes monthOverride for the CRM funnel card —
   *  channel cost is pro-rated to the selected days. */
  from?: string;
  to?: string;
};

export default async function ProjectOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { project: projectParam } = await params;
  const projectName = decodeURIComponent(projectParam);
  // `?resolved=1` flips the three preview sections below from open-only
  // to open+resolved. Mirrors the Inbox "הצג סגורים" toggle so the
  // pattern is uniform across the hub.
  const sp = await searchParams;
  const showResolved = sp.resolved === "1";
  // `?company=X` disambiguates when the project name isn't unique
  // (today only `כללי` collides). When present, all project lookups
  // below scope by both name AND company. When absent, legacy first-
  // match-by-name kicks in — works fine for unique names, falls
  // through to "the first one in the user's roster" for collisions.
  const companyScope = (sp.company || "").trim();
  // Person scope (cookie + `?person=X` ephemeral override). Used only to
  // decide whether to show the out-of-scope banner below — we deliberately
  // still render the full project page, since deep-links from email/chat
  // should always resolve.
  const scopedPerson = await getScopedPerson(sp.person);

  // Fire API calls in parallel. Each validates access independently, so
  // an unauthorized caller gets consistent errors. Legacy getProjectTasks
  // (comment-mention Google-Tasks feed) was dropped — the work-management
  // tasks system owns the "משימות" section now.
  //
  // Drive folder lookup chains off the projects list (needs `company`)
  // — we kick off `getMyProjects` as a promise variable and derive the
  // Drive call from it via `.then()`, so both land in the same parallel
  // batch instead of serializing after it. Net: ~300–600ms saved on
  // cold loads since the Drive call no longer waits for the full
  // batch to resolve.
  //
  // `getMorningFeed` is intentionally NOT in this batch — it's the
  // last Apps-Script-backed call on this page (~1–3s cold) and feeds
  // an alerts section below the משימות cards. It's now streamed in
  // via <Suspense> further down so the משימות / תיוגים / הערות cards
  // don't wait for it.
  const meP = currentUserEmail().catch(() => "");
  const projectsP = getMyProjects().catch(() => null);
  const driveFolderP = projectsP.then(async (data) => {
    // Same disambiguation rule as the projectMeta lookup further down:
    // prefer (name, company) match when companyScope is supplied; fall
    // back to first-match-by-name otherwise for legacy links that
    // don't carry company.
    const company =
      data?.projects.find((p) =>
        companyScope
          ? p.name === projectName && p.company === companyScope
          : p.name === projectName,
      )?.company ?? "";
    if (!company) return { folderId: null, viewUrl: null };
    return findProjectFolderUrlCached(company, projectName);
  });
  const sharedDriveP = meP.then((me) =>
    me ? getSharedDriveName(me).catch(() => "") : "",
  );

  const [
    commentsRes,
    internalCommentsRes,
    mentionsRes,
    projectsRes,
    workTasksRes,
    peopleRes,
    driveFolderRes,
    sharedDriveRes,
  ] = await Promise.allSettled([
    // Two scoped reads. They funnel through the same React-cache()'d
    // Firestore shape (one round-trip), then filter in memory — the
    // extra call is ~free. For a non-F&F caller the "internal" read
    // returns empty by the reader's hard rule, so this is safe to run
    // unconditionally.
    getProjectComments(projectName, 15, "shared"),
    getProjectComments(projectName, 15, "internal"),
    // §11 — scope the mentions read to this project (page filters to it
    // anyway). Inbox / badge / tasks page keep calling getMyMentions()
    // with no arg (all-projects).
    getMyMentions(projectName),
    projectsP,
    // Pass company when supplied — tasksListDirect honors `filters.company`
    // (lib/tasksDirect.ts:399), so kullit tasks under company X don't
    // bleed into the kullit page resolved as company Y.
    tasksList(
      companyScope
        ? { project: projectName, company: companyScope }
        : { project: projectName },
    ),
    tasksPeopleList(),
    driveFolderP,
    sharedDriveP,
  ]);

  const commentsData =
    commentsRes.status === "fulfilled" ? commentsRes.value : null;
  const internalCommentsData =
    internalCommentsRes.status === "fulfilled"
      ? internalCommentsRes.value
      : null;
  const mentionsData =
    mentionsRes.status === "fulfilled" ? mentionsRes.value : null;
  const projectsData =
    projectsRes.status === "fulfilled" ? projectsRes.value : null;
  const workTasksData =
    workTasksRes.status === "fulfilled" ? workTasksRes.value : null;
  const peopleData =
    peopleRes.status === "fulfilled" ? peopleRes.value : null;
  const driveFolderResolved =
    driveFolderRes.status === "fulfilled" ? driveFolderRes.value : null;
  const sharedDriveName =
    sharedDriveRes.status === "fulfilled" ? sharedDriveRes.value : "";

  // Disambiguate by (name, company) when companyScope is set so the
  // page's chatSpaceUrl + Drive folder + dashboard URL all resolve to
  // the right company. Without companyScope, fall back to first-by-name
  // for backwards compatibility — works fine when the name is unique
  // (i.e. every project except `כללי`).
  const projectMeta = projectsData?.projects.find((p) =>
    companyScope
      ? p.name === projectName && p.company === companyScope
      : p.name === projectName,
  );
  // Out-of-scope check: if a person-scope is active and the requested
  // project's roster doesn't include them, render a banner. We only
  // assert "out of scope" when we have both a scope AND projectMeta
  // (otherwise it's indeterminate — stay silent rather than falsely
  // flagging).
  const isOutOfScope =
    !!scopedPerson &&
    !!projectMeta &&
    !isPersonOnProject(projectMeta, scopedPerson);
  // Prefer projectMeta.company, but fall back to the URL's ?company= when
  // projectMeta is null (e.g. an admin viewing a project that isn't in
  // their personal roster). Without this fallback, the dashboard iframe
  // URL would have no company param at all and the כללי-mode pivot in
  // the Apps Script side wouldn't trigger.
  const companyForDashboard =
    projectMeta?.company ?? (companyScope || "");
  // The logged-in user's email. MUST come from the session (`meP` =
  // currentUserEmail), NOT projectsData.email — the latter is "" whenever
  // getMyProjects() is slow or fails (it's `.catch(() => null)`), which
  // silently flipped the ✏️ edit gate off on the user's OWN messages and
  // mis-set isInternalUser to false. Reported by Maayan 2026-06-25: his
  // own comment showed no edit option on a load where the projects read
  // didn't return. Session email is always present (the page requires
  // auth) and is the same value projectsData.email carries when it works.
  const userEmail = (await meP) || projectsData?.email || "";

  // Auto-dismiss this project's DISCUSSION notifications (comment_reply /
  // mention / chat_mention) when the user opens the page — the discussion
  // + their tags are right here, so a ping they've now seen (and usually
  // replied to) shouldn't keep nagging the bell + /notifications. Mirrors
  // the markReadByTask auto-dismiss on /tasks/[id]. Fire-and-forget, kicked
  // off early so it runs concurrently with the page's data fetches; errors
  // swallowed (a missed dismissal is a UX nit, not a correctness bug). Task
  // pings are left alone — they clear on the task detail page. Reported by
  // Maayan 2026-06-25: he'd seen + replied to messages but the התראות kept
  // prompting action because nothing cleared them on view.
  if (userEmail) {
    void import("@/lib/notifications").then((m) =>
      m.markReadByProjectDiscussion(userEmail, projectName).catch(() => {}),
    );
  }

  // Project-type gate (2026-05-27). All real-estate-only surfaces on
  // this page — the Apps Script dashboard iframe, the CRM funnel
  // card, the Clarity insights, the FB/Google Ads deep-link buttons,
  // any pacing chrome — collapse to nothing for non-real-estate
  // projects (e.g. the internal צוות F&F's כללי). Tasks, comments,
  // files, the chat space stay because they're universal. Empty /
  // missing project_type falls back to "real estate" so existing
  // projects keep behaving as before. See lib/keys.ts for details.
  const isRealEstateProject = isRealEstateType(projectMeta?.projectType);

  // Resolve the project's Drive folder URL — the Drive lookup itself
  // ran in parallel with the data batch above (chained off projectsP),
  // so this block is just URL fallback. driveFolderResolved.viewUrl
  // is null when the project's folder hasn't been created yet (no
  // tasks ever saved with USE_SA_TASKS_WRITES); fall back to a global
  // Drive search by project name in that case.
  const driveFolderUrl =
    driveFolderResolved?.viewUrl ||
    "https://drive.google.com/drive/search?q=" +
      encodeURIComponent(projectName);

  // Per-project "תיקיה משותפת" — the Drive folder that's explicitly
  // shared with every email in Keys col E. Resolved (and created /
  // permission-synced if needed) on every page load — the helper is
  // cached at 5 min so the steady-state cost is one Drive read. For
  // clients, the project header's Drive button points here instead
  // of the project root (which lives in an internal-only Shared
  // Drive they can't open). Staff still get the project root.
  let clientSharedFolderUrl: string | null = null;
  const projectClientEmails = projectMeta?.roster?.clientEmails ?? [];
  if (projectMeta && companyForDashboard) {
    try {
      const { ensureProjectSharedFolder } = await import(
        "@/lib/driveSharedFolder"
      );
      const ref = await ensureProjectSharedFolder(
        companyForDashboard,
        projectName,
        projectClientEmails,
      );
      clientSharedFolderUrl = ref.viewUrl;
    } catch (e) {
      console.log(
        "[projects/page] ensureProjectSharedFolder failed:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  // Build the Drive-Desktop local path for both Windows and macOS.
  // CopyLocalPathButton picks the right one client-side via UA
  // detection.
  const localPaths = buildLocalDrivePaths({
    driveName: sharedDriveName,
    company: companyForDashboard,
    project: projectName,
    userEmail,
  });
  const dashboardBaseUrl = process.env.DASHBOARD_URL ?? "";
  // monthOverride is read from search params; format-validated again in
  // buildDashboardUrl so a malformed link doesn't poison the iframe URL.
  const monthOverride =
    typeof sp.monthOverride === "string" && /^\d{4}-\d{2}$/.test(sp.monthOverride)
      ? sp.monthOverride
      : "";
  // Free CRM-funnel date range — both bounds must be valid ISO dates and
  // from ≤ to, else ignored. Supersedes monthOverride for the funnel card.
  const isoDate = (v: unknown): string =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
  const crmFrom = isoDate(sp.from);
  const crmTo = isoDate(sp.to);
  const crmDateRange =
    crmFrom && crmTo && crmFrom <= crmTo ? { from: crmFrom, to: crmTo } : undefined;
  // The embedded report reuses its `monthOverride` slot to carry EITHER a
  // single month ("YYYY-MM") OR a free range ("YYYY-MM-DD..YYYY-MM-DD") — it
  // parses both. So the iframe URL passes the range here when one is active
  // (mutually exclusive with monthOverride, which the picker clears).
  const dashboardPeriod = crmDateRange
    ? `${crmDateRange.from}..${crmDateRange.to}`
    : monthOverride;
  // `כללי` (catch-all project) has no campaign-ID slug in Keys, so a
  // regular `project=כללי` filter hits 0 ALL CLIENTS rows and the iframe
  // renders empty. The Apps Script side (doGet / _iframeHandle_ /
  // _hubApiHandle_) recognises the `project=כללי` + `company=X` combo as
  // a pivot trigger: drop the project filter, use company-portfolio mode
  // instead. We keep project=כללי in the URL so the trigger fires — the
  // pivot happens server-side, not here.
  const isKullitProject = projectName === "כללי";
  // `authuser` hints Google to load the iframe under *this* account if the
  // browser is signed into multiple Google accounts. If it's signed into the
  // wrong one (or none), Google will redirect to its sign-in flow with our
  // email pre-filled — still better than a silent "can't open" error.
  const dashboardFilteredUrl = dashboardBaseUrl
    ? buildDashboardUrl(dashboardBaseUrl, {
        company: companyForDashboard,
        project: projectName,
        authuser: userEmail,
        monthOverride: dashboardPeriod,
      })
    : "";
  // Iframe URL selection:
  //   - Internal @fandf.co.il users → legacy embed URL on the USER_ACCESSING
  //     dashboard. Runs under their Google session, so the comment drawer,
  //     AI summaries, alert dismissal, admin summary, sheet/ads links, and
  //     every other google.script.run feature keep working.
  //   - External clients (non-fandf domains) → hub-proxied `/api/dashboard/
  //     <project>` route. The hub server fetches the Apps Script HTML
  //     server-to-server (no browser cookies, so Google's `/u/N/` multi-
  //     account rerouting can't apply) and serves it at hub origin. Read-
  //     only snapshot; IFRAME_MODE=true on the Apps Script side skips all
  //     google.script.run calls. See app/api/dashboard/[project]/route.ts.
  const isInternalUser = userEmail.toLowerCase().endsWith("@fandf.co.il");
  // Client view-mode: gate every task-management surface (header
  // "+ משימה חדשה" button, the 📋 section, the convert-to-task icon
  // on each comment). Clients use the hub purely as a discussion +
  // metrics surface; tasks live on the F&F internal side.
  const isClientUser =
    !!projectsData?.isClient &&
    !projectsData?.isAdmin &&
    !projectsData?.isStaff &&
    !isInternalUser;
  // Resolve the active channel here so we can gate page-level chrome
  // (the resolved-filter pill below) against it. DiscussionSection
  // re-derives this internally — keep the rules in sync if they
  // change.
  // Non-F&F users only ever have the shared channel — the internal and
  // tasks channels are F&F-only, so a hand-crafted ?channel=internal
  // from a client must NOT resolve to "internal" (the data layer also
  // refuses, this is the UI half of the same invariant). Keep this in
  // sync with the identical gate inside DiscussionSection.
  const activeChannel: "internal" | "client" | "tasks" = !isInternalUser
    ? "client"
    : sp.channel === "internal"
      ? "internal"
      : sp.channel === "client"
        ? "client"
        : sp.channel === "tasks"
          ? "tasks"
          : "internal";
  const legacyEmbedUrl = dashboardBaseUrl
    ? buildDashboardUrl(dashboardBaseUrl, {
        company: companyForDashboard,
        project: projectName,
        authuser: userEmail,
        embed: true,
        monthOverride: dashboardPeriod,
        clientView: isClientUser,
      })
    : "";
  // External-client proxy URL — append monthOverride as a query param so the
  // proxy route can forward it upstream to renderDashboardHtml. For כללי
  // the proxy route also needs to see the `company` param so its upstream
  // call to renderDashboardHtml carries it through to the Apps Script
  // company-mode pivot. clientView is forwarded similarly so the dashboard
  // hides its negative-signal surfaces (see dashboard-clasp Index.html).
  const proxyEmbedParams = new URLSearchParams();
  if (dashboardPeriod) proxyEmbedParams.set("monthOverride", dashboardPeriod);
  if (isKullitProject && companyForDashboard) {
    proxyEmbedParams.set("company", companyForDashboard);
  }
  if (isClientUser) proxyEmbedParams.set("clientView", "1");
  const proxyEmbedQs = proxyEmbedParams.toString();
  const proxyEmbedUrl = `/api/dashboard/${encodeURIComponent(projectName)}${proxyEmbedQs ? `?${proxyEmbedQs}` : ""}`;
  const dashboardEmbedUrl = isInternalUser ? legacyEmbedUrl : proxyEmbedUrl;
  // "Open in new tab" link next to the metrics section. Internal users get
  // the raw USER_ACCESSING /exec URL (preserves interactivity); external
  // clients can't load that — route them to the proxy instead so the link
  // still works from their browser.
  const dashboardOpenUrl = isInternalUser ? dashboardFilteredUrl : proxyEmbedUrl;

  // If a core call failed, it's likely an access-denied — show the first error.
  const firstError =
    commentsRes.status === "rejected"
      ? extractError(commentsRes.reason)
      : workTasksRes.status === "rejected"
        ? extractError(workTasksRes.reason)
        : null;

  // Shared (client-visible) vs internal (F&F-only) discussion. The two
  // channels render with the SAME components — they only differ by
  // which scoped slice they get and what the composer posts. For a
  // non-F&F caller the internal slices are already empty (reader rule),
  // and the internal channel never renders for them anyway.
  const comments = commentsData?.comments ?? [];
  const internalComments = internalCommentsData?.comments ?? [];
  const myMentionsOnProject =
    mentionsData?.mentions.filter((m) => m.project === projectName) ?? [];
  const sharedMentions = myMentionsOnProject.filter(
    (m) => m.scope !== "internal",
  );
  const internalMentions = myMentionsOnProject.filter(
    (m) => m.scope === "internal",
  );
  const workTasks = workTasksData?.tasks ?? [];

  // Open work-tasks: anything not in a terminal state. Matches the queue's
  // default (done / cancelled fall out; draft, awaiting_approval,
  // awaiting_clarification, in_progress all count).
  const openWorkTasks = workTasks.filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  ).length;
  const totalComments = commentsData?.total ?? 0;
  const internalTotal = internalCommentsData?.total ?? 0;
  const openMentions = sharedMentions.filter((m) => !m.resolved).length;
  const internalOpenMentions = internalMentions.filter(
    (m) => !m.resolved,
  ).length;

  // Resolved-item count for the filter-bar "(N)" badge — computed for
  // the CURRENTLY ACTIVE channel so the pill reflects what's hidden in
  // the surface the user is actually looking at. Only top-level comments
  // are countable here (replies inherit their parent's resolved state).
  const resolvedFor = (
    cs: typeof comments,
    ms: typeof myMentionsOnProject,
  ): number =>
    ms.filter((m) => m.resolved).length +
    cs.filter((c) => !c.parent_id && c.resolved).length;
  const resolvedCount =
    activeChannel === "internal"
      ? resolvedFor(internalComments, internalMentions)
      : resolvedFor(comments, sharedMentions);

  return (
    <main className="container project-main">
      {/* Header + the client approve-prompt share ONE sticky wrapper so both
          stay pinned on scroll — the header no longer scrolls away, and the
          prompt sits beneath it (not riding over it). For internal viewers
          the wrapper is inert; the header keeps its own sticky. */}
      <div className="project-top-stack">
      <header className="page-header">
        {/* Tiny client-side scroll watcher: toggles `is-scrolled` on
            this header once the user scrolls past ~80px. CSS handles
            the shrink (h1 font-size + subtitle hide + tighter padding)
            on desktop. No-op on mobile (sticky disabled there). */}
        <PageHeaderShrinkObserver />
        <div>
          <h1>
            <span className="emoji" aria-hidden>🏢</span>
            {projectName}
          </h1>
          <div className="subtitle">
            <Link href="/">→ כל הפרויקטים</Link>
          </div>
        </div>
        <div className="header-actions">
          {/* Primary action: open the proper task creator scoped to
              this project. Lands on /tasks/new with the project pre-
              selected via search param. Hidden for client users —
              they can't create tasks; their only write surface is
              the client-tab message composer. */}
          {!isClientUser && (
            <Link
              href={`/tasks/new?project=${encodeURIComponent(projectName)}`}
              className="btn-primary btn-sm"
              title="פתח את יוצר המשימות עם הפרויקט מוגדר מראש"
            >
              + משימה חדשה
            </Link>
          )}
          {/* Month-override picker — page-level filter that gates the
              dashboard iframe + CRM funnel card + Clarity section all
              at once. Available to clients too (2026-06-04 per Maayan)
              — letting them rewind to a past month is a legitimate
              read use case, and the picker's UI doesn't expose any
              internal-only data. */}
          {dashboardEmbedUrl && isRealEstateProject && (
            <Suspense fallback={null}>
              <DashboardMonthOverrideSlot current={monthOverride} />
            </Suspense>
          )}
          {/* "+ הודעה ללקוח" used to live here next to "+ משימה חדשה",
              but with the channel split it only ever writes to the
              client-tab discussion. Moved into the לקוח tab so users
              see the action in the right context. The page header
              now carries only project-wide actions (tasks, Drive,
              local-path, Chat). */}
          {/* Drive button — clients land in the per-project shared
              folder (the only path they have explicit Drive perms to);
              staff/admin land in the project root in the Shared Drive
              so they can navigate the full hierarchy. The shared
              folder is auto-created + permission-synced when this
              page renders for any user (cached 5 min), so it's always
              there by the time a client clicks. */}
          <a
            className="btn-ghost btn-sm btn-with-drive-icon"
            href={
              isClientUser && clientSharedFolderUrl
                ? clientSharedFolderUrl
                : driveFolderUrl
            }
            target="_blank"
            rel="noreferrer"
            title={
              isClientUser && clientSharedFolderUrl
                ? `פתח את התיקיה המשותפת — ${projectName} תיקיה משותפת`
                : driveFolderUrl.includes("drive.google.com/drive/search")
                  ? "פתח חיפוש Drive עבור הפרויקט"
                  : "פתח את תיקיית הפרויקט ב-Drive"
            }
          >
            <GoogleDriveIcon size="1.05em" /> Drive
          </a>
          {localPaths.windows && (
            <CopyLocalPathButton
              path={localPaths.windows}
              pathMac={localPaths.mac}
              title="העתק נתיב מקומי — Drive Desktop"
            />
          )}
        </div>
      </header>
      {isClientUser && isRealEstateProject && (
        <Suspense fallback={null}>
          <ClientPrisaApprovalPrompt
            subjectEmail={userEmail}
            company={companyForDashboard}
            project={projectName}
          />
        </Suspense>
      )}
      </div>

      {firstError && (
        <div className="error">
          <strong>שגיאה בטעינת הפרויקט.</strong>
          <br />
          {firstError}
        </div>
      )}

      {isOutOfScope && <OutOfScopeBanner person={scopedPerson} />}

      {/* Resolved-state filter — both the internal and shared channels
          are hub Comments now, so the toggle is meaningful on both
          (the old Google-Chat internal tab had no resolved state, which
          is why this used to be client-only). The tasks channel has no
          resolved filter. Hidden when nothing is resolved yet AND the
          user isn't already in show-resolved mode. */}
      {(activeChannel === "client" || activeChannel === "internal") &&
        (resolvedCount > 0 || showResolved) && (
          <ProjectFilterBar
            showResolved={showResolved}
            resolvedCount={resolvedCount}
          />
        )}

      {/* Section order intentionally matches the stats row above (tasks /
          mentions / comments) so each column lines up with its count tile
          when the grid renders in RTL. The 📋 משימות section is hidden
          entirely for clients — they don't see task management. */}
      <div className="project-sections">
        {!isClientUser && (
          <section className="project-section">
            <div className="section-head">
              <h2>
                📋 משימות
                <span className="section-count">{openWorkTasks}</span>
              </h2>
              <Link
                className="section-link"
                href={`/tasks?project=${encodeURIComponent(projectName)}&mine=0`}
              >
                פתח את כל המשימות ←
              </Link>
            </div>
            <p className="section-subtitle">
              משימות עבודה פתוחות, מקובצות לפי סטטוס. לחץ על שם המשימה לפרטים.
            </p>
            <TasksQueue
              tasks={workTasks}
              groupByCompany={false}
              hideOther
              compact
              people={peopleData?.people ?? []}
              driveName={sharedDriveName}
              userEmail={userEmail}
              emptyMessage="🎉 אין משימות פתוחות בפרויקט זה."
            />
          </section>
        )}

        <DiscussionSection
          sharedComments={comments}
          sharedMentions={sharedMentions}
          sharedTotal={totalComments}
          sharedOpenMentions={openMentions}
          internalComments={internalComments}
          internalMentions={internalMentions}
          internalTotal={internalTotal}
          internalOpenMentions={internalOpenMentions}
          projectName={projectName}
          showResolved={showResolved}
          requestedView={sp.view}
          requestedChannel={sp.channel}
          isInternalUser={isInternalUser}
          isClientUser={isClientUser}
          userEmail={userEmail}
          people={peopleData?.ok ? peopleData.people : []}
        />
      </div>

      {/* Alerts section — pacing/budget/deadline/paused-budget signals for
          this project only. Same dismiss/snooze/revisit behavior as the
          morning page; dismissals are team-wide.
          Internal-only — these are operational warnings (audience
          mismatch, paused budget, ramp-up suggestions) that clients
          shouldn't see surfaced in their own view of the project.
          Streamed via <Suspense> so the slow Apps-Script-backed
          getMorningFeed call (~1–3s cold) doesn't block the משימות /
          תיוגים / הערות sections above from rendering. */}
      {!isClientUser && isRealEstateProject && (
        <Suspense fallback={null}>
          <ProjectAlertsSection
            projectName={projectName}
            company={companyForDashboard}
            monthOverride={monthOverride}
          />
        </Suspense>
      )}

      {/* Dashboard iframe, inline under the comment/task cards. Spans the
          full container width. No standalone page header — the section
          heading is enough.
          Project-type gate: only render for real-estate projects.
          Non-real-estate (e.g. צוות F&F) has no campaign/funnel data
          and the iframe would show an empty Apps Script report. */}
      {isRealEstateProject && dashboardEmbedUrl && (
        <section className="project-section project-section-metrics">
          {/* Section head is absolutely positioned over the iframe's
              top-left corner. The iframe's own header lives directly
              underneath (project name on the right, גיליון/Facebook/
              Google chips on the left). Keep this pill icon-only so it
              doesn't cover the chip on the left — aria-label carries
              the "מטריקות" semantic for screen readers. */}
          <div className="section-head" title="📊 מטריקות">
            <h2 aria-label="מטריקות">📊</h2>
            <div className="section-head-actions">
              <a
                className="section-link section-link-icon"
                href={dashboardOpenUrl}
                target="_blank"
                rel="noreferrer"
                title="פתח את הדשבורד בכרטיסייה חדשה"
                aria-label="פתח את הדשבורד בכרטיסייה חדשה"
              >
                ↗
              </a>
            </div>
          </div>
          <MetricsIframe
            src={dashboardEmbedUrl}
            projectName={projectName}
            expectedEmail={userEmail}
          />
        </section>
      )}

      {/* CRM funnel — per-lead status & meetings pulled from the
          external "Consolidated" workbook (BMBY + Sehel). Sits below the
          dashboard iframe because it answers "what happened AFTER the
          lead came in" while the dashboard above shows "how leads got
          here". Surfaced for clients too — they care about their own
          funnel and the card shows downstream-of-our-ads activity,
          not internal F&F performance signals.
          Renders null when the project's Keys row has no `CRM` mapping
          or the source tab has no matching rows.
          Project-type gate: only real-estate projects have a CRM
          funnel concept; non-real-estate (e.g. internal F&F) skips. */}
      {isRealEstateProject && (
        <Suspense fallback={null}>
          <CrmFunnelCard
            company={companyForDashboard}
            project={projectName}
            monthFilter={monthOverride}
            dateRange={crmDateRange}
          />
        </Suspense>
      )}

      {/* Landing-page behavior insights — Clarity API + Claude-generated
          Hebrew narrative. Internal-only (mirrors the LatestPrisotCard
          gate). Renders null on any failure so the page silently
          degrades; Suspense keeps the API chain off the critical
          render path. `monthFilter` is threaded through so the section
          can self-hide when the user has rewound the page to a past
          month — Clarity's API only returns the trailing 3 days
          (numOfDays=3 hardcoded in lib/clarity.ts), so we can't
          honestly show "April 2026 Clarity data" — hiding the section
          is the truthful UX.
          Project-type gate: real-estate landing pages only; nothing
          to analyze on an internal-discussions project. */}
      {isRealEstateProject && !isClientUser && (
        <Suspense fallback={null}>
          <ClarityInsightsSection
            subjectEmail={userEmail}
            project={projectName}
            monthFilter={monthOverride}
          />
        </Suspense>
      )}

      {/* Latest פריסה (spread / deployment sheet) — the most-recently-
          updated Google Sheet inside `<project>/פריסות/`. Now visible to
          clients too (2026-07-05, per Maayan): they see the rendered plan
          and can approve it in place — LatestPrisotCard strips the internal
          approval-workflow chrome for clients and offers a single "אשר
          פריסה" action instead (locks the sheet as the approved version).
          Renders as null when the folder doesn't exist or has no
          sheets, so projects that don't follow the convention silently
          degrade. Suspense keeps the Drive lookup off the critical
          render path.
          Project-type gate: only real-estate projects have פריסות.
          Owner moved this from above the iframe to right above
          "מחירים מפורסמים" 2026-06-04 — both are bottom-of-page
          reference shelves, makes sense to group them. */}
      {isRealEstateProject && (
        <Suspense fallback={null}>
          <LatestPrisotCard
            subjectEmail={userEmail}
            company={companyForDashboard}
            project={projectName}
            clientEmails={projectClientEmails}
            people={peopleData?.ok ? peopleData.people : []}
            isClientUser={isClientUser}
          />
        </Suspense>
      )}

      {/* "מחירים מפורסמים" — 4-surface advertised-price snapshot at the
          bottom of the page. Now visible to clients too (2026-07-05, per
          Maayan): ProjectPriceCheckSection strips the internal ad-ops
          chrome for clients (FB/Google Ads deep-links, "מודעות מושהות"
          chips, the mismatch/QA pill) and keeps the published prices +
          landing/Yad2 links + room inventory. The report's
          projectPriceCheck endpoint enforces the caller's own per-project
          access (col E) server-side. Real-estate-only (non-real-estate
          projects don't have a "starting from" price concept). Self-hides
          when the project has zero surfaces with usable input — so on
          fresh projects with no scrape + no live ad copy the section
          stays hidden rather than rendering an empty shelf. Suspense
          keeps the Apps-Script call off the critical render path. */}
      {isRealEstateProject && (
        <Suspense fallback={null}>
          <ProjectPriceCheckSection
            projectName={projectName}
            isClientUser={isClientUser}
          />
        </Suspense>
      )}
    </main>
  );
}

/* ─── Sections ───────────────────────────────────────────────────── */

/**
 * Async server component for the alerts row. Lives below the project
 * cards and is wrapped in <Suspense> so its data fetch (the
 * Apps-Script-backed getMorningFeed, ~1–3s cold, ~5ms warm via the
 * 60s unstable_cache wrapper) doesn't block the rest of the page.
 *
 * Returns nothing visible while in flight (fallback=null) and nothing
 * visible if the project has no current signals — keeps the layout
 * shift to a minimum.
 */
async function ProjectAlertsSection({
  projectName,
  company,
  monthOverride,
}: {
  projectName: string;
  company: string;
  monthOverride: string;
}) {
  // Parallel fetch — Apps-Script-backed dashboard alerts AND the
  // hub-side inputs to computeCrmAlerts. The CRM funnel is fetched
  // twice: month-filtered for the cohort-specific signals
  // (stale-leads relies on funnel.staleLeads which is project-wide
  // either way, but the filtered call is what the CRM card on this
  // page also reads), and all-time for creative-mismatch's objection
  // dominance check (one month of CRM rows is too sparse — channel
  // objection profiles are slow-moving characteristics computed over
  // a wider window). Both rely on the same cached raw Sheets read.
  const [alertsData, crmFunnel, crmFunnelAllTime, allClientsRows, crmDismissals] = await Promise.all([
    getMorningFeed({ project: projectName }).catch(() => null),
    company
      ? getCrmFunnelForProject({ company, project: projectName, monthFilter: monthOverride })
          .catch(() => null)
      : Promise.resolve(null),
    company
      ? getCrmFunnelForProject({ company, project: projectName, noFilter: true })
          .catch(() => null)
      : Promise.resolve(null),
    getAllClientsCurrentForProject({
      subjectEmail: driveFolderOwner(),
      project: projectName,
    }).catch(() => [] as AllClientsRow[]),
    // Dismissal store joins the parallel batch — it was previously a
    // serial Firestore round-trip AFTER the batch, delaying alert
    // render inside this Suspense boundary by ~150-300ms (speed pass
    // 2026-06-10). Hub-side CRM alerts don't get dismissal state from
    // the report's feed, so the shared store is applied here
    // (best-effort — an outage shows them un-dismissed).
    listAlertDismissals().catch(() => ({})),
  ]);
  const dashboardProject: MorningProject | null = alertsData?.projects[0] ?? null;
  const dashboardSignals = dashboardProject?.signals ?? [];
  const rawCrmSignals = computeCrmAlerts({
    funnel: crmFunnel,
    funnelAllTime: crmFunnelAllTime,
    allClients: allClientsRows,
    projectSlug: dashboardProject?.slug || projectName,
  });
  const crmSignals = applyDismissalsToSignals(rawCrmSignals, crmDismissals);
  const allSignals = [...dashboardSignals, ...crmSignals];
  if (allSignals.length === 0) return null;
  return (
    <section className="project-section">
      <div className="section-head">
        <h2>
          🔔 התראות
          <span className="section-count">{allSignals.length}</span>
        </h2>
        <Link className="section-link" href="/morning">
          כל ההתראות ←
        </Link>
      </div>
      <ul className="morning-signal-list">
        {allSignals.map((s, i) => (
          <MorningSignalRow key={i} signal={s} projectName={projectName} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Discussion section. Outer tabs split the conversation surface by
 * audience — all three are now hub-native (Firestore) and render with
 * the SAME components, so they look and behave identically:
 *   🔒 פנימי  — internal hub discussion (F&F only; the client never
 *               sees it). Full composer / mentions / resolve / edit.
 *   🤝 משותף  — shared hub discussion (visible to the client too).
 *               Same surface as פנימי, just a different audience.
 *   📋 משימות — read-only aggregation of the open tasks' discussions.
 *
 * (The פנימי channel used to be a read-only Google Chat mirror; Chat
 * was de-scoped, so it's now a first-class hub channel scoped
 * "internal" — identical UX to משותף.)
 *
 * Each tab keeps its own inner toggle (הכל / 🏷️ תיוגים שלי).
 *
 * Default channel is role-aware: F&F users land on "internal" (their
 * day-to-day), clients are HARD-pinned to "client" (they have no
 * internal/tasks channel at all).
 */
function DiscussionSection({
  sharedComments,
  sharedMentions,
  sharedTotal,
  sharedOpenMentions,
  internalComments,
  internalMentions,
  internalTotal,
  internalOpenMentions,
  projectName,
  showResolved,
  requestedView,
  requestedChannel,
  isInternalUser,
  isClientUser,
  userEmail,
  people,
}: {
  /** Client-visible (`scope:"shared"`) slice. */
  sharedComments: CommentItem[];
  sharedMentions: MentionItem[];
  sharedTotal: number;
  sharedOpenMentions: number;
  /** F&F-only (`scope:"internal"`) slice. Already empty for non-F&F
   *  callers (reader rule) and never rendered for them. */
  internalComments: CommentItem[];
  internalMentions: MentionItem[];
  internalTotal: number;
  internalOpenMentions: number;
  projectName: string;
  showResolved: boolean;
  requestedView: string | undefined;
  requestedChannel: string | undefined;
  isInternalUser: boolean;
  /** True when the viewer is a client (col-E only). Drops the
   *  convert-to-task icon on every comment / mention card. */
  isClientUser: boolean;
  userEmail: string;
  /** People list used to resolve channel-row author emails to Hebrew
   *  names. Optional; falls back to email-prefix on miss. */
  people: import("@/lib/appsScript").TasksPerson[];
}) {
  // Hard gate: a non-F&F viewer can ONLY ever be on "client". Mirrors
  // the page-level activeChannel gate AND the data-layer rule, so a
  // hand-crafted ?channel=internal can never surface internal data.
  const channel: "internal" | "client" | "tasks" = !isInternalUser
    ? "client"
    : requestedChannel === "internal"
      ? "internal"
      : requestedChannel === "client"
        ? "client"
        : requestedChannel === "tasks"
          ? "tasks"
          : "internal";

  // Build hrefs for the outer tab — preserve other params (view,
  // resolved) so flipping channels doesn't reset the inner state.
  const channelHref = (next: "internal" | "client" | "tasks") => {
    const qs = new URLSearchParams();
    if (showResolved) qs.set("resolved", "1");
    if (requestedView) qs.set("view", requestedView);
    qs.set("channel", next);
    return `/projects/${encodeURIComponent(projectName)}?${qs.toString()}`;
  };

  return (
    <section className="project-section project-section-wide">
      {/* Tab strip is for STAFF only. Clients only have one channel
          (the shared one), so a tab strip with a single entry is
          visual noise — they go straight into the message list. */}
      {isInternalUser && (
        <div className="discussion-channel-tabs" role="tablist">
          <Link
            role="tab"
            aria-selected={channel === "internal"}
            href={channelHref("internal")}
            title="פנימי — צוות F&F בלבד; הלקוח לא רואה"
            className={`discussion-channel-tab ${channel === "internal" ? "is-active" : ""}`}
          >
            🔒 פנימי
            <span className="discussion-channel-tab-hint">צוות</span>
          </Link>
          <Link
            role="tab"
            aria-selected={channel === "client"}
            href={channelHref("client")}
            title="משותף — נצפה גם ע״י הלקוח"
            className={`discussion-channel-tab ${channel === "client" ? "is-active" : ""}`}
          >
            🤝 משותף
            <span className="discussion-channel-tab-hint">לקוח</span>
          </Link>
          <Link
            role="tab"
            aria-selected={channel === "tasks"}
            href={channelHref("tasks")}
            title="דיוני משימות — צבירת כל ההערות על המשימות הפתוחות בפרויקט"
            className={`discussion-channel-tab ${channel === "tasks" ? "is-active" : ""}`}
          >
            📋 משימות
            <span className="discussion-channel-tab-hint">פתוחות</span>
          </Link>
        </div>
      )}
      {channel === "tasks" ? (
        <TasksChannel
          subjectEmail={userEmail}
          projectName={projectName}
          people={people}
        />
      ) : channel === "internal" ? (
        <HubChannel
          channel="internal"
          comments={internalComments}
          mentions={internalMentions}
          totalComments={internalTotal}
          openMentions={internalOpenMentions}
          projectName={projectName}
          showResolved={showResolved}
          requestedView={requestedView}
          isClientUser={isClientUser}
          userEmail={userEmail}
          people={people}
        />
      ) : (
        <HubChannel
          channel="client"
          comments={sharedComments}
          mentions={sharedMentions}
          totalComments={sharedTotal}
          openMentions={sharedOpenMentions}
          projectName={projectName}
          showResolved={showResolved}
          requestedView={requestedView}
          isClientUser={isClientUser}
          userEmail={userEmail}
          people={people}
        />
      )}
    </section>
  );
}

/**
 * Aggregated task-discussion feed for the project. Pulls every
 * comment posted on a still-open task in this project into one
 * chronological feed. Read-only; converting / replying still happens
 * on each task's own discussion section (each row links there).
 */
async function TasksChannel({
  subjectEmail,
  projectName,
  people,
}: {
  subjectEmail: string;
  projectName: string;
  people: import("@/lib/appsScript").TasksPerson[];
}) {
  const { projectOpenTasksDiscussionDirect } = await import(
    "@/lib/commentsDirect"
  );
  const data = await projectOpenTasksDiscussionDirect(
    subjectEmail,
    projectName,
  ).catch((e: unknown) => {
    console.log(
      "[projects] tasks-channel fetch failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  });

  if (!data) {
    return (
      <p className="discussion-empty muted">
        לא ניתן לטעון את דיוני המשימות.
      </p>
    );
  }
  if (data.feed.length === 0) {
    return (
      <>
        <div className="section-head section-head-inner">
          <p className="section-subtitle">
            {data.open_task_count === 0
              ? "אין משימות פתוחות בפרויקט הזה."
              : `אין דיון פעיל ב-${data.open_task_count} המשימות הפתוחות.`}
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="section-head section-head-inner">
        <p className="section-subtitle">
          {data.feed.length} הודעות אחרונות מתוך {data.open_task_count} משימות
          פתוחות בפרויקט
        </p>
      </div>
      <ul className="tasks-channel-feed">
        {data.feed.map((item) => (
          <li key={item.comment_id} className="tasks-channel-item">
            <Link
              href={`/tasks/${encodeURIComponent(item.task_id)}`}
              className="tasks-channel-task-chip"
              title={`פתח את המשימה — ${item.task_title || item.task_id}`}
            >
              📋 {item.task_title || item.task_id}
            </Link>
            <div className="tasks-channel-body">
              <div className="tasks-channel-meta">
                <span className="tasks-channel-author">
                  {personDisplayName(item.author_email, people) ||
                    item.author_name ||
                    item.author_email.split("@")[0]}
                </span>
                <span className="tasks-channel-time" title={item.timestamp}>
                  {formatRelativeIso(item.timestamp)}
                </span>
                {item.resolved && (
                  <span className="tasks-channel-resolved-pill" title="נפתר">
                    ✓
                  </span>
                )}
              </div>
              <div className="tasks-channel-text">
                {(item.body || "").split("\n").map((line, i) => (
                  <p key={i} dir="auto">{line}</p>
                ))}
              </div>
              <div className="tasks-channel-actions">
                <Link
                  href={item.deep_link.replace(
                    /^https?:\/\/[^/]+/,
                    "",
                  )}
                  className="tasks-channel-link"
                >
                  פתח את התגובה ←
                </Link>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Hebrew-friendly relative-time helper for the tasks-channel feed.
 *  Falls back to a date string for items older than a week. */
function formatRelativeIso(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "לפני רגע";
  if (m < 60) return `לפני ${m} דקות`;
  const h = Math.floor(m / 60);
  if (h < 24) return `לפני ${h} שעות`;
  const d = Math.floor(h / 24);
  if (d < 7) return `לפני ${d} ימים`;
  return iso.slice(0, 10);
}

/**
 * Hub-native discussion channel — drives BOTH the internal (F&F-only)
 * and the shared (client-visible) tabs. The two are intentionally the
 * SAME component: identical toggle, list, composer, empty states — the
 * only differences are which scoped slice it's handed and the `scope`
 * the composer posts with. That's what makes the internal and external
 * chats homogeneous. Inner toggle (הכל / 🏷️ תיוגים שלי) operates on
 * hub Comments rows.
 */
function HubChannel({
  channel,
  comments,
  mentions,
  totalComments,
  openMentions,
  projectName,
  showResolved,
  requestedView,
  isClientUser,
  userEmail,
  people,
}: {
  /** Which audience this instance renders. Drives the composer scope
   *  and keeps `?channel=` sticky across the inner toggle. */
  channel: "internal" | "client";
  comments: CommentItem[];
  mentions: MentionItem[];
  totalComments: number;
  openMentions: number;
  projectName: string;
  showResolved: boolean;
  requestedView: string | undefined;
  isClientUser: boolean;
  /** Current viewer's email — forwarded to the previews for the ✏️ edit
   *  gate (author or admin only). */
  userEmail: string;
  /** Roster threaded down through CommentsPreview / MentionsPreview /
   *  CommentBody so `@email` mentions render as the person's Hebrew
   *  display name. */
  people: import("@/lib/appsScript").TasksPerson[];
}) {
  const view: "all" | "mine" =
    requestedView === "all"
      ? "all"
      : requestedView === "mine"
        ? "mine"
        : openMentions > 0
          ? "mine"
          : "all";

  // Thread roots the user is mentioned in. Used by the "all" view to
  // mark items with the accent border + chip without flipping views.
  const mentionedThreadIds = new Set(
    mentions.map((m) => m.thread_root_id || m.parent_id || m.comment_id),
  );

  // Toggle hrefs preserve every other search param so e.g. ?resolved=1
  // doesn't reset when flipping views, and the outer ?channel sticks to
  // THIS channel so the inner toggle never bounces the user to another
  // tab. Server-rendered <Link>s — no JS, refresh-safe by construction.
  const buildHref = (nextView: "all" | "mine") => {
    const qs = new URLSearchParams();
    if (showResolved) qs.set("resolved", "1");
    qs.set("channel", channel);
    qs.set("view", nextView);
    return `/projects/${encodeURIComponent(projectName)}?${qs.toString()}`;
  };

  return (
    <>
      <div className="section-head section-head-inner">
        <div className="discussion-head-tools">
          <div className="tasks-view-toggle" role="tablist">
            <Link
              role="tab"
              aria-selected={view === "all"}
              href={buildHref("all")}
              className={`tasks-view-toggle-btn ${view === "all" ? "is-active" : ""}`}
            >
              הכל
              <span className="discussion-toggle-count">
                {totalComments}
              </span>
            </Link>
            <Link
              role="tab"
              aria-selected={view === "mine"}
              href={buildHref("mine")}
              className={`tasks-view-toggle-btn ${view === "mine" ? "is-active" : ""}`}
            >
              🏷️ תיוגים שלי
              {openMentions > 0 && (
                <span className="discussion-toggle-count">{openMentions}</span>
              )}
            </Link>
          </div>
          <Link
            className="section-link"
            href={`/projects/${encodeURIComponent(projectName)}/timeline`}
          >
            ציר זמן ←
          </Link>
        </div>
      </div>
      <p className="section-subtitle">
        {view === "mine"
          ? showResolved
            ? "כל התיוגים בפרויקט (פתוחים וסגורים)"
            : "שרשורים שבהם תויגת ועוד לא סגרת"
          : showResolved
            ? "כל ההערות בפרויקט (פתוחות וסגורות)"
            : "פעילות בפרויקט — הערות פתוחות"}
      </p>
      {view === "mine" ? (
        <MentionsPreview
          mentions={mentions}
          showResolved={showResolved}
          isClientUser={isClientUser}
          userEmail={userEmail}
          people={people}
        />
      ) : (
        <CommentsPreview
          comments={comments}
          projectName={projectName}
          showResolved={showResolved}
          mentionedThreadIds={mentionedThreadIds}
          isClientUser={isClientUser}
          userEmail={userEmail}
          people={people}
        />
      )}
      {view === "all" && totalComments > comments.length && (
        <div className="section-foot">
          מציג {comments.length} מתוך {totalComments}
        </div>
      )}
      {/* Composer at the bottom — mirrors the internal Chat tab's
          inline composer position so both surfaces feel the same.
          Rendered in both view modes ("הכל" and "תיוגים שלי"): users
          should be able to post regardless of which filter they have
          on. (Previous gate to view==="all" hid the composer whenever
          the page auto-flipped to "תיוגים שלי" because the user had
          open mentions — broke the chat-feeling on busy projects.) */}
      <div className="discussion-client-foot">
        <ClientChatComposer
          project={projectName}
          isClientUser={isClientUser}
          scope={channel === "internal" ? "internal" : "shared"}
        />
      </div>
    </>
  );
}

function CommentsPreview({
  comments,
  projectName,
  showResolved,
  mentionedThreadIds,
  isClientUser,
  userEmail,
  people,
}: {
  comments: CommentItem[];
  projectName: string;
  showResolved: boolean;
  /** Comment ids of thread roots the user is @-mentioned in (top-level
   *  or any reply). Marked with an accent border + 🏷️ chip in the
   *  card head when present. Empty/undefined = no decoration. */
  mentionedThreadIds?: Set<string>;
  /** When true, hide the "convert to task" affordance on each card —
   *  clients can't create tasks. */
  isClientUser?: boolean;
  /** Current viewer's email — drives the per-comment ✏️ edit gate
   *  (author or admin only). */
  userEmail: string;
  /** Roster forwarded to CommentBody so mention tokens render Hebrew
   *  names. Optional — falls back to email-prefix when missing. */
  people?: import("@/lib/appsScript").TasksPerson[];
}) {
  // Only top-level threads render in the preview; replies are reached via
  // the inline ThreadReplies control on each thread. When showResolved is
  // on, resolved threads are rendered inline (faded via .is-resolved).
  const topLevel = comments.filter((c) => !c.parent_id);
  const visible = showResolved ? topLevel : topLevel.filter((c) => !c.resolved);
  const resolvedCount = topLevel.filter((c) => c.resolved).length;
  const top = visible.slice(0, 8);

  if (top.length === 0 && resolvedCount === 0) {
    return (
      <div
        className={`empty-small${
          isClientUser ? " discussion-empty-state" : ""
        }`}
      >
        {isClientUser ? (
          <>
            <span className="discussion-empty-emoji" aria-hidden>
              👋
            </span>
            <span className="discussion-empty-title">
              יש שאלה, בקשה או עדכון?
            </span>
            <span className="discussion-empty-sub">
              כתבו לנו כאן והצוות יחזור אליכם בהקדם.
            </span>
          </>
        ) : (
          <>💭 אין הערות בפרויקט זה עדיין.</>
        )}
      </div>
    );
  }

  // Resolved threads (within the fetched window) are revealed INLINE via a
  // native <details> below the open ones — the owner found the old "jump
  // to the timeline" link unintuitive. Same markup as the open threads, so
  // the thread <li> is factored into one renderer used by both lists.
  const resolvedThreads = topLevel.filter((c) => c.resolved);
  const resolvedNoun = resolvedCount === 1 ? "הערה פתורה" : "הערות פתורות";

  const renderThread = (c: CommentItem) => {
    const isMentioned = mentionedThreadIds?.has(c.comment_id) ?? false;
    return (
      <li
        key={c.comment_id}
        id={`thread-${c.comment_id}`}
        className={`chat-thread discussion-client-thread ${
          c.resolved ? "is-resolved" : ""
        } ${isMentioned ? "is-mentioned" : ""}`}
      >
        <Avatar
          name={c.author_email}
          title={c.author_name || c.author_email}
          size={26}
        />
        <div className="chat-message-body">
          <div className="chat-message-head">
            <span className="chat-message-author">
              {c.author_name || c.author_email}
            </span>
            {isMentioned && (
              <span className="chip chip-mention" title="תויגת בשרשור הזה">
                🏷️ אותך
              </span>
            )}
            <span className="chat-message-time" title={c.timestamp}>
              {formatRelative(c.timestamp)}
            </span>
            {c.edited_at && (
              <span
                className="chip chip-muted"
                title={`נערך ${formatRelative(c.edited_at)}`}
              >
                📝 נערך
              </span>
            )}
          </div>
          <CommentBodyExpandable
            body={c.body}
            truncateChars={220}
            className="chat-message-text"
            people={people}
          />
          {/* Replies render BELOW the comment body (chat order: the
              message first, then the thread under it), not in the
              header. */}
          <ThreadReplies
            parentCommentId={c.comment_id}
            project={c.project}
            count={c.reply_count}
            people={people}
          />
          <div className="discussion-client-actions">
            <CardActions
              commentId={c.comment_id}
              project={c.project}
              resolved={c.resolved}
              body={c.body}
              deleteItemLabel="את התגובה"
              canConvertToTask={!isClientUser}
              canEdit={viewerCanEdit(c.author_email, userEmail)}
              allowEditWhenResolved
            />
          </div>
        </div>
      </li>
    );
  };

  return (
    <ul className="chat-message-list discussion-client-list">
      {top.length === 0 && (
        <li className="discussion-no-open-note">✅ אין הערות פתוחות.</li>
      )}
      {top.map((c) => renderThread(c))}
      {resolvedCount > 0 && !showResolved && (
        <li className="discussion-resolved-reveal-row">
          <details className="discussion-resolved-reveal">
            <summary className="discussion-resolved-summary">
              <span className="discussion-resolved-summary-show">
                + הצג {resolvedCount} {resolvedNoun}
              </span>
              <span className="discussion-resolved-summary-hide">
                הסתר {resolvedNoun}
              </span>
            </summary>
            <ul className="chat-message-list discussion-client-list discussion-resolved-list">
              {resolvedThreads.map((c) => renderThread(c))}
            </ul>
          </details>
        </li>
      )}
    </ul>
  );
}

function MentionsPreview({
  mentions,
  showResolved,
  isClientUser,
  userEmail,
  people,
}: {
  mentions: MentionItem[];
  showResolved: boolean;
  isClientUser?: boolean;
  /** Current viewer's email — drives the per-mention ✏️ edit gate
   *  (author or admin only). */
  userEmail: string;
  /** Roster forwarded to CommentBody so mention tokens render Hebrew
   *  names. Optional. */
  people?: import("@/lib/appsScript").TasksPerson[];
}) {
  // Filter behavior mirrors the page-level filter bar: default hides
  // resolved; toggle on to include them inline (fades via .is-resolved).
  const visible = showResolved
    ? mentions
    : mentions.filter((m) => !m.resolved);
  const resolvedCount = mentions.filter((m) => m.resolved).length;
  const top = visible.slice(0, 5);
  if (top.length === 0 && resolvedCount === 0) {
    return (
      <div className="empty-small">
        🌿 לא תויגת בפרויקט זה.
      </div>
    );
  }

  // Resolved tags are revealed INLINE (native <details>) below the open
  // ones rather than bouncing to the inbox — mirrors the CommentsPreview
  // "הצג N הערות פתורות" reveal. Same markup as the open mentions, so the
  // mention <li> is factored into one renderer.
  const resolvedMentions = mentions.filter((m) => m.resolved);
  const resolvedNoun = resolvedCount === 1 ? "תיוג פתור" : "תיוגים פתורים";

  const renderMention = (m: MentionItem) => {
    // Resolve/delete target the thread root — only top-level comments are
    // resolvable/deletable. Falls back to comment_id for older API
    // responses that don't include thread_root_id.
    const actionTarget = m.thread_root_id || m.parent_id || m.comment_id;
    return (
      <li
        key={m.comment_id}
        id={`thread-${actionTarget}`}
        className={`chat-thread discussion-client-thread ${
          m.resolved ? "is-resolved" : ""
        } is-mentioned`}
      >
        <Avatar
          name={m.author_email}
          title={m.author_name || m.author_email}
          size={26}
        />
        <div className="chat-message-body">
          <div className="chat-message-head">
            <span className="chat-message-author">
              {m.author_name || m.author_email}
            </span>
            {m.edited_at && (
              <span
                className="chip chip-muted"
                title={`נערך ${formatRelative(m.edited_at)}`}
              >
                📝 נערך
              </span>
            )}
            <span className="chat-message-time" title={m.timestamp}>
              {formatRelative(m.timestamp)}
            </span>
          </div>
          <CommentBodyExpandable
            body={m.body}
            truncateChars={200}
            className="chat-message-text"
            people={people}
          />
          {/* Replies under the body, not in the header (chat order). */}
          <ThreadReplies
            parentCommentId={actionTarget}
            project={m.project}
            count={m.reply_count ?? 0}
            people={people}
          />
          <div className="discussion-client-actions">
            <CardActions
              commentId={actionTarget}
              project={m.project}
              editCommentId={m.comment_id}
              resolved={m.resolved}
              body={m.body}
              deleteItemLabel="את התיוג"
              canConvertToTask={!isClientUser}
              canEdit={viewerCanEdit(m.author_email, userEmail)}
              allowEditWhenResolved
            />
          </div>
        </div>
      </li>
    );
  };

  return (
    <ul className="chat-message-list discussion-client-list">
      {top.length === 0 && (
        <li className="discussion-no-open-note">
          ✅ אין תיוגים פתוחים עבורך בפרויקט זה.
        </li>
      )}
      {top.map((m) => renderMention(m))}
      {resolvedCount > 0 && !showResolved && (
        <li className="discussion-resolved-reveal-row">
          <details className="discussion-resolved-reveal">
            <summary className="discussion-resolved-summary">
              <span className="discussion-resolved-summary-show">
                + הצג {resolvedCount} {resolvedNoun}
              </span>
              <span className="discussion-resolved-summary-hide">
                הסתר {resolvedNoun}
              </span>
            </summary>
            <ul className="chat-message-list discussion-client-list discussion-resolved-list">
              {resolvedMentions.map((m) => renderMention(m))}
            </ul>
          </details>
        </li>
      )}
    </ul>
  );
}

/* ─── Small bits ─────────────────────────────────────────────────── */

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return "עכשיו";
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `לפני ${mins} ד׳`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `לפני ${hrs} ש׳`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `לפני ${days} י׳`;
  const months = Math.round(days / 30);
  if (months < 12) return `לפני ${months} חו׳`;
  const years = Math.round(days / 365);
  return `לפני ${years} ש׳`;
}

function extractError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Append project+company+authuser filters to the dashboard base URL. */
function buildDashboardUrl(
  base: string,
  filters: {
    company?: string;
    project?: string;
    authuser?: string;
    /** When true, the dashboard hides its sticky filter bar — useful for
     *  iframe embedding since the URL already scopes to one project. */
    embed?: boolean;
    /** "YYYY-MM" — auto-applies the dashboard's month-override mode on
     *  initial load. Anything else is silently dropped. */
    monthOverride?: string;
    /** When true, the dashboard suppresses negative-signal surfaces that
     *  clients can't interpret correctly out of context — top-bar "bad"
     *  alert chips, "wasted budget" / "expensive vs portfolio" insight
     *  cards, funnel-weakness diagnoses. Positive insights and headline
     *  numbers stay visible. Set whenever the viewer is a client tier
     *  user (see isClientUser in this file). */
    clientView?: boolean;
  },
): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return base;
  }
  if (filters.company) url.searchParams.set("company", filters.company);
  if (filters.project) url.searchParams.set("project", filters.project);
  if (filters.authuser) url.searchParams.set("authuser", filters.authuser);
  if (filters.embed) url.searchParams.set("embed", "1");
  // "YYYY-MM" (single month) OR "YYYY-MM-DD..YYYY-MM-DD" (free range) — the
  // dashboard parses both. Anything else is dropped.
  if (
    filters.monthOverride &&
    (/^\d{4}-\d{2}$/.test(filters.monthOverride) ||
      /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(filters.monthOverride))
  ) {
    url.searchParams.set("monthOverride", filters.monthOverride);
  }
  if (filters.clientView) url.searchParams.set("clientView", "1");
  return url.toString();
}

/**
 * Async server component that fetches the available-months list from Apps
 * Script and renders the client-side picker. Wrapped in <Suspense> at the
 * call site so the page doesn't block on this network call — the picker
 * materializes when the months arrive (typically <500ms). Failures (Apps
 * Script down, etc.) silently render nothing — the iframe still works,
 * users just can't pick a month from the hub side.
 */
async function DashboardMonthOverrideSlot({ current }: { current: string }) {
  let months: string[] = [];
  try {
    const res = await getAvailableMonths();
    months = Array.isArray(res?.months) ? res.months : [];
  } catch {
    return null;
  }
  if (!months.length) return null;
  return <DashboardMonthOverridePicker current={current} months={months} />;
}
