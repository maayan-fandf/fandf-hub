import Link from "next/link";
import { Suspense } from "react";
import {
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
import CreateTaskDrawer from "@/components/CreateTaskDrawer";
import TasksQueue from "@/components/TasksQueue";
import Avatar from "@/components/Avatar";
import MetricsIframe from "@/components/MetricsIframe";
import CardActions from "@/components/CardActions";
import CommentBody from "@/components/CommentBody";
import InternalDiscussionTab from "@/components/InternalDiscussionTab";
import { getDisplayNamesForEmail } from "@/lib/projectsDirect";
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
import { currentUserEmail } from "@/lib/appsScript";
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
    const company =
      data?.projects.find((p) => p.name === projectName)?.company ?? "";
    if (!company) return { folderId: null, viewUrl: null };
    return findProjectFolderUrlCached(company, projectName);
  });
  const sharedDriveP = meP.then((me) =>
    me ? getSharedDriveName(me).catch(() => "") : "",
  );

  const [
    commentsRes,
    mentionsRes,
    projectsRes,
    workTasksRes,
    peopleRes,
    driveFolderRes,
    sharedDriveRes,
  ] = await Promise.allSettled([
    getProjectComments(projectName, 15),
    getMyMentions(),
    projectsP,
    tasksList({ project: projectName }),
    tasksPeopleList(),
    driveFolderP,
    sharedDriveP,
  ]);

  const commentsData =
    commentsRes.status === "fulfilled" ? commentsRes.value : null;
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

  const projectMeta = projectsData?.projects.find(
    (p) => p.name === projectName,
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
  const companyForDashboard = projectMeta?.company ?? "";
  const chatSpaceUrl = projectMeta?.chatSpaceUrl ?? "";
  const userEmail = projectsData?.email ?? "";

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
  // Build the absolute Windows path the user pastes into File
  // Explorer's address bar. F&F's Drive Desktop setup mounts at G:\,
  // matching every workstation we've checked. If a Mac user ever
  // hits this, they paste it into Finder's "Go to" dialog and adapt
  // the prefix manually — niche enough to ignore for now.
  const localPath =
    sharedDriveName && companyForDashboard && projectName
      ? `G:\\Shared drives\\${sharedDriveName}\\${companyForDashboard}\\${projectName}`
      : "";
  const dashboardBaseUrl = process.env.DASHBOARD_URL ?? "";
  // `authuser` hints Google to load the iframe under *this* account if the
  // browser is signed into multiple Google accounts. If it's signed into the
  // wrong one (or none), Google will redirect to its sign-in flow with our
  // email pre-filled — still better than a silent "can't open" error.
  const dashboardFilteredUrl = dashboardBaseUrl
    ? buildDashboardUrl(dashboardBaseUrl, {
        company: companyForDashboard,
        project: projectName,
        authuser: userEmail,
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
  const legacyEmbedUrl = dashboardBaseUrl
    ? buildDashboardUrl(dashboardBaseUrl, {
        company: companyForDashboard,
        project: projectName,
        authuser: userEmail,
        embed: true,
      })
    : "";
  const proxyEmbedUrl = `/api/dashboard/${encodeURIComponent(projectName)}`;
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

  const comments = commentsData?.comments ?? [];
  const myMentionsOnProject =
    mentionsData?.mentions.filter((m) => m.project === projectName) ?? [];
  const workTasks = workTasksData?.tasks ?? [];

  // Open work-tasks: anything not in a terminal state. Matches the queue's
  // default (done / cancelled fall out; draft, awaiting_approval,
  // awaiting_clarification, in_progress all count).
  const openWorkTasks = workTasks.filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  ).length;
  const totalComments = commentsData?.total ?? 0;
  const openMentions = myMentionsOnProject.filter((m) => !m.resolved).length;

  // Resolved-item count across the two remaining preview sections (mentions
  // + comments). Drives the "(N)" badge on the filter-bar toggle so users
  // see at a glance how much is currently hidden. Only top-level comments
  // are countable here — replies inherit their parent's resolved state.
  const resolvedMentions = myMentionsOnProject.filter((m) => m.resolved).length;
  const resolvedComments = comments.filter(
    (c) => !c.parent_id && c.resolved,
  ).length;
  const resolvedCount = resolvedMentions + resolvedComments;

  return (
    <main className="container">
      <header className="page-header">
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
              selected via search param. */}
          <Link
            href={`/tasks/new?project=${encodeURIComponent(projectName)}`}
            className="btn-primary btn-sm"
            title="פתח את יוצר המשימות עם הפרויקט מוגדר מראש"
          >
            + משימה חדשה
          </Link>
          {/* Comment / mention drawer — formerly mislabelled "+ משימה
              חדשה". It actually creates a top-level comment with
              @-mentions, which spawns Google Tasks for the mentioned
              users. Renaming to "+ הערה" is honest about its actual
              role: a quick note, not a tracked task. */}
          <CreateTaskDrawer project={projectName} />
          <a
            className="btn-ghost btn-sm btn-with-drive-icon"
            href={driveFolderUrl}
            target="_blank"
            rel="noreferrer"
            title={
              driveFolderUrl.includes("drive.google.com/drive/search")
                ? "פתח חיפוש Drive עבור הפרויקט"
                : "פתח את תיקיית הפרויקט ב-Drive"
            }
          >
            <GoogleDriveIcon size="1.05em" /> Drive
          </a>
          {localPath && (
            <CopyLocalPathButton
              path={localPath}
              title="העתק נתיב מקומי — Drive Desktop"
            />
          )}
          {chatSpaceUrl && (
            <a
              className="btn-ghost btn-sm"
              href={chatSpaceUrl}
              target="_blank"
              rel="noreferrer"
              title="פתח את שיחת הפרויקט ב-Google Chat"
            >
              💬 צ׳אט
            </a>
          )}
        </div>
      </header>

      {firstError && (
        <div className="error">
          <strong>שגיאה בטעינת הפרויקט.</strong>
          <br />
          {firstError}
        </div>
      )}

      {isOutOfScope && <OutOfScopeBanner person={scopedPerson} />}

      {/* Hidden when the project has nothing resolved yet AND the user isn't
          already in show-resolved mode — avoids showing an inert toggle on
          a fresh project. */}
      {(resolvedCount > 0 || showResolved) && (
        <ProjectFilterBar
          showResolved={showResolved}
          resolvedCount={resolvedCount}
        />
      )}

      {/* Section order intentionally matches the stats row above (tasks /
          mentions / comments) so each column lines up with its count tile
          when the grid renders in RTL. */}
      <div className="project-sections">
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
            emptyMessage="🎉 אין משימות פתוחות בפרויקט זה."
          />
        </section>

        <DiscussionSection
          comments={comments}
          mentions={myMentionsOnProject}
          totalComments={totalComments}
          openMentions={openMentions}
          projectName={projectName}
          showResolved={showResolved}
          requestedView={sp.view}
          requestedChannel={sp.channel}
          isInternalUser={isInternalUser}
          userEmail={userEmail}
          chatSpaceUrl={chatSpaceUrl}
        />
      </div>

      {/* Alerts section — pacing/budget/deadline/paused-budget signals for
          this project only. Same dismiss/snooze/revisit behavior as the
          morning page; dismissals are team-wide.
          Streamed via <Suspense> so the slow Apps-Script-backed
          getMorningFeed call (~1–3s cold) doesn't block the משימות /
          תיוגים / הערות sections above from rendering. The section
          materializes when ready; nothing visible while it's pending. */}
      <Suspense fallback={null}>
        <ProjectAlertsSection projectName={projectName} />
      </Suspense>

      {/* Dashboard iframe, inline under the comment/task cards. Spans the
          full container width. No standalone page header — the section
          heading is enough. */}
      {dashboardEmbedUrl && (
        <section className="project-section project-section-metrics">
          <div className="section-head">
            <h2>📊 מטריקות</h2>
            <a
              className="section-link"
              href={dashboardOpenUrl}
              target="_blank"
              rel="noreferrer"
            >
              פתח בכרטיסייה חדשה ↗
            </a>
          </div>
          <MetricsIframe
            src={dashboardEmbedUrl}
            projectName={projectName}
            expectedEmail={userEmail}
          />
        </section>
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
async function ProjectAlertsSection({ projectName }: { projectName: string }) {
  const alertsData = await getMorningFeed({ project: projectName }).catch(
    () => null,
  );
  const projectAlerts: MorningProject | null = alertsData?.projects[0] ?? null;
  if (!projectAlerts || projectAlerts.signals.length === 0) return null;
  return (
    <section className="project-section">
      <div className="section-head">
        <h2>
          🔔 התראות
          <span className="section-count">
            {projectAlerts.signals.length}
          </span>
        </h2>
        <Link className="section-link" href="/morning">
          כל ההתראות ←
        </Link>
      </div>
      <ul className="morning-signal-list">
        {projectAlerts.signals.map((s, i) => (
          <MorningSignalRow key={i} signal={s} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Two-channel discussion section. Outer tabs split the conversation
 * surface by audience:
 *   🔒 פנימי   — Google Chat space (internal team only). Read-only
 *               mirror of recent messages + a button to open Chat.
 *   🤝 לקוח   — hub Comments (internal + client). Full composer,
 *               attachments, mentions, resolve / edit / delete.
 *
 * Each tab carries its own inner toggle (הכל / 🏷️ תיוגים שלי) so the
 * "things needing my attention" affordance survives across both
 * surfaces.
 *
 * Default channel is role-aware:
 *   - Internal user (`@fandf.co.il`) lands on "internal" — they live
 *     in Chat and that's where their day-to-day pings come from.
 *   - Clients (and unknown roles) land on "client" — they can't see
 *     the internal channel at all.
 * User-driven tab clicks set `?channel=internal|client` explicitly.
 */
function DiscussionSection({
  comments,
  mentions,
  totalComments,
  openMentions,
  projectName,
  showResolved,
  requestedView,
  requestedChannel,
  isInternalUser,
  userEmail,
  chatSpaceUrl,
}: {
  comments: CommentItem[];
  mentions: MentionItem[];
  totalComments: number;
  openMentions: number;
  projectName: string;
  showResolved: boolean;
  requestedView: string | undefined;
  requestedChannel: string | undefined;
  isInternalUser: boolean;
  userEmail: string;
  chatSpaceUrl: string;
}) {
  const channel: "internal" | "client" =
    requestedChannel === "internal"
      ? "internal"
      : requestedChannel === "client"
        ? "client"
        : isInternalUser
          ? "internal"
          : "client";

  // Build hrefs for the outer tab — preserve other params (view,
  // resolved) so flipping channels doesn't reset the inner state.
  const channelHref = (next: "internal" | "client") => {
    const qs = new URLSearchParams();
    if (showResolved) qs.set("resolved", "1");
    if (requestedView) qs.set("view", requestedView);
    qs.set("channel", next);
    return `/projects/${encodeURIComponent(projectName)}?${qs.toString()}`;
  };

  return (
    <section className="project-section project-section-wide">
      <div className="discussion-channel-tabs" role="tablist">
        {/* Internal tab is hidden for non-fandf users — they have no
            access to the Chat space anyway, so showing the tab would
            just be a teaser they can't act on. */}
        {isInternalUser && (
          <Link
            role="tab"
            aria-selected={channel === "internal"}
            href={channelHref("internal")}
            className={`discussion-channel-tab ${channel === "internal" ? "is-active" : ""}`}
          >
            🔒 פנימי
            <span className="discussion-channel-tab-hint">Chat</span>
          </Link>
        )}
        <Link
          role="tab"
          aria-selected={channel === "client"}
          href={channelHref("client")}
          className={`discussion-channel-tab ${channel === "client" ? "is-active" : ""}`}
        >
          🤝 לקוח
          <span className="discussion-channel-tab-hint">Hub</span>
        </Link>
      </div>
      {channel === "internal" ? (
        <InternalChannel
          subjectEmail={userEmail}
          chatSpaceUrl={chatSpaceUrl}
          requestedView={requestedView}
          showResolved={showResolved}
          projectName={projectName}
        />
      ) : (
        <ClientChannel
          comments={comments}
          mentions={mentions}
          totalComments={totalComments}
          openMentions={openMentions}
          projectName={projectName}
          showResolved={showResolved}
          requestedView={requestedView}
        />
      )}
    </section>
  );
}

/**
 * Server component for the internal-channel tab. Pulls recent Chat
 * messages via Suspense so the chat-API fetch (~300–800ms) doesn't
 * block the rest of the page. Inner toggle (הכל / 🏷️ תיוגים שלי)
 * works the same as on the client tab.
 */
async function InternalChannel({
  subjectEmail,
  chatSpaceUrl,
  requestedView,
  showResolved,
  projectName,
}: {
  subjectEmail: string;
  chatSpaceUrl: string;
  requestedView: string | undefined;
  showResolved: boolean;
  projectName: string;
}) {
  const view: "all" | "mine" = requestedView === "mine" ? "mine" : "all";
  const buildHref = (nextView: "all" | "mine") => {
    const qs = new URLSearchParams();
    if (showResolved) qs.set("resolved", "1");
    qs.set("channel", "internal");
    qs.set("view", nextView);
    return `/projects/${encodeURIComponent(projectName)}?${qs.toString()}`;
  };
  // Pull display-name aliases for the תיוגים filter — Chat mention
  // annotations use displayName, not email. Best-effort.
  const myDisplayNames = subjectEmail
    ? await getDisplayNamesForEmail(subjectEmail).catch(() => [])
    : [];
  return (
    <>
      <div className="section-head section-head-inner">
        <p className="section-subtitle">
          {view === "mine"
            ? "הודעות אחרונות בחלל הצ׳אט הפנימי שתויגת בהן"
            : "הודעות אחרונות בחלל הצ׳אט הפנימי של הפרויקט"}
        </p>
        <div className="tasks-view-toggle" role="tablist">
          <Link
            role="tab"
            aria-selected={view === "all"}
            href={buildHref("all")}
            className={`tasks-view-toggle-btn ${view === "all" ? "is-active" : ""}`}
          >
            הכל
          </Link>
          <Link
            role="tab"
            aria-selected={view === "mine"}
            href={buildHref("mine")}
            className={`tasks-view-toggle-btn ${view === "mine" ? "is-active" : ""}`}
          >
            🏷️ תיוגים שלי
          </Link>
        </div>
      </div>
      <Suspense fallback={<div className="discussion-empty">טוען צ׳אט…</div>}>
        <InternalDiscussionTab
          subjectEmail={subjectEmail}
          spaceUrlOrWebhook={chatSpaceUrl}
          showOnlyMine={view === "mine"}
          myEmail={subjectEmail}
          myDisplayNames={myDisplayNames}
        />
      </Suspense>
    </>
  );
}

/**
 * Hub-native client-channel tab — the previous unified
 * DiscussionSection body, narrowed to "client tab" semantics. Inner
 * toggle (הכל / 🏷️ תיוגים שלי) operates on hub Comments rows.
 */
function ClientChannel({
  comments,
  mentions,
  totalComments,
  openMentions,
  projectName,
  showResolved,
  requestedView,
}: {
  comments: CommentItem[];
  mentions: MentionItem[];
  totalComments: number;
  openMentions: number;
  projectName: string;
  showResolved: boolean;
  requestedView: string | undefined;
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
  // doesn't reset when flipping views, and the outer ?channel=client
  // sticks so the toggle doesn't drop the user back onto the internal
  // tab. Toggle is server-rendered as <Link>s — no JS required for
  // state, refresh-safe by construction.
  const buildHref = (nextView: "all" | "mine") => {
    const qs = new URLSearchParams();
    if (showResolved) qs.set("resolved", "1");
    qs.set("channel", "client");
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
        <MentionsPreview mentions={mentions} showResolved={showResolved} />
      ) : (
        <CommentsPreview
          comments={comments}
          projectName={projectName}
          showResolved={showResolved}
          mentionedThreadIds={mentionedThreadIds}
        />
      )}
      {view === "all" && totalComments > comments.length && (
        <div className="section-foot">
          מציג {comments.length} מתוך {totalComments}
        </div>
      )}
    </>
  );
}

function CommentsPreview({
  comments,
  projectName,
  showResolved,
  mentionedThreadIds,
}: {
  comments: CommentItem[];
  projectName: string;
  showResolved: boolean;
  /** Comment ids of thread roots the user is @-mentioned in (top-level
   *  or any reply). Marked with an accent border + 🏷️ chip in the
   *  card head when present. Empty/undefined = no decoration. */
  mentionedThreadIds?: Set<string>;
}) {
  // Only top-level threads render in the preview; replies are reached via
  // the inline ThreadReplies control on each thread. When showResolved is
  // on, resolved threads are rendered inline (faded via .is-resolved).
  const topLevel = comments.filter((c) => !c.parent_id);
  const visible = showResolved ? topLevel : topLevel.filter((c) => !c.resolved);
  const resolvedCount = topLevel.filter((c) => c.resolved).length;
  const top = visible.slice(0, 8);

  if (top.length === 0 && resolvedCount === 0) {
    return <div className="empty-small">💭 אין הערות בפרויקט זה עדיין.</div>;
  }
  if (top.length === 0) {
    // showResolved is false here (otherwise visible would include them)
    return (
      <div className="empty-small">
        ✅ אין הערות פתוחות.{" "}
        <Link
          href={`/projects/${encodeURIComponent(projectName)}/timeline?resolved=1`}
          className="section-link"
        >
          הצג {resolvedCount} פתורות ←
        </Link>
      </div>
    );
  }
  return (
    <ul className="compact-list">
      {top.map((c) => {
        const isMentioned = mentionedThreadIds?.has(c.comment_id) ?? false;
        return (
        <li
          key={c.comment_id}
          className={`compact-comment ${c.resolved ? "is-resolved" : ""} ${
            isMentioned ? "is-mentioned" : ""
          }`}
        >
          <div className="compact-comment-head">
            <Avatar name={c.author_email} title={c.author_name || c.author_email} size={22} />
            <span className="author">{c.author_name || c.author_email}</span>
            {isMentioned && (
              <span
                className="chip chip-mention"
                title="תויגת בשרשור הזה"
              >
                🏷️ אותך
              </span>
            )}
            <span className="time" title={c.timestamp}>
              {formatRelative(c.timestamp)}
            </span>
            <ThreadReplies
              parentCommentId={c.comment_id}
              project={c.project}
              count={c.reply_count}
            />
            {c.edited_at && (
              <span
                className="chip chip-muted"
                title={`נערך ${formatRelative(c.edited_at)}`}
              >
                📝 נערך
              </span>
            )}
          </div>
          <CommentBody
            body={c.body}
            truncateChars={220}
            className="compact-comment-body"
          />
          <div className="compact-comment-actions">
            <CardActions
              commentId={c.comment_id}
              project={c.project}
              resolved={c.resolved}
              body={c.body}
              deleteItemLabel="את התגובה"
            />
          </div>
        </li>
        );
      })}
      {resolvedCount > 0 && !showResolved && (
        <li className="compact-comment compact-comment-footer">
          <Link
            href={`/projects/${encodeURIComponent(projectName)}/timeline?resolved=1`}
            className="section-link"
          >
            + הצג {resolvedCount} {resolvedCount === 1 ? "הערה פתורה" : "הערות פתורות"} בציר הזמן ←
          </Link>
        </li>
      )}
    </ul>
  );
}

function MentionsPreview({
  mentions,
  showResolved,
}: {
  mentions: MentionItem[];
  showResolved: boolean;
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
  if (top.length === 0) {
    // showResolved is false here (otherwise visible would include them)
    return (
      <div className="empty-small">
        ✅ אין תיוגים פתוחים עבורך בפרויקט זה.{" "}
        <Link href="/inbox?resolved=1" className="section-link">
          הצג {resolvedCount} פתורים ←
        </Link>
      </div>
    );
  }
  return (
    <ul className="compact-list">
      {top.map((m) => {
        // Resolve/delete target the thread root — only top-level comments
        // are resolvable/deletable. Falls back to comment_id for older API
        // responses that don't include thread_root_id.
        const actionTarget =
          m.thread_root_id || m.parent_id || m.comment_id;
        return (
          <li
            key={m.comment_id}
            className={`compact-comment ${m.resolved ? "is-resolved" : ""}`}
          >
            <div className="compact-comment-head">
              <Avatar
                name={m.author_email}
                title={m.author_name || m.author_email}
                size={22}
              />
              <span className="author">
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
              <span className="time" title={m.timestamp}>
                {formatRelative(m.timestamp)}
              </span>
              <ThreadReplies
                parentCommentId={actionTarget}
                project={m.project}
                count={m.reply_count ?? 0}
              />
            </div>
            <CommentBody
              body={m.body}
              truncateChars={200}
              className="compact-comment-body"
            />
            <div className="compact-comment-actions">
              <CardActions
                commentId={actionTarget}
                project={m.project}
                editCommentId={m.comment_id}
                resolved={m.resolved}
                body={m.body}
                deleteItemLabel="את התיוג"
              />
            </div>
          </li>
        );
      })}
      {resolvedCount > 0 && !showResolved && (
        <li className="compact-comment compact-comment-footer">
          <Link href="/inbox?resolved=1" className="section-link">
            + הצג {resolvedCount} {resolvedCount === 1 ? "תיוג פתור" : "תיוגים פתורים"} בתיבת התיוגים ←
          </Link>
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
  return url.toString();
}
