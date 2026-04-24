import Link from "next/link";
import {
  getProjectTasks,
  getProjectComments,
  getMyMentions,
  getMyProjects,
  getMorningFeed,
  tasksList,
  type TaskItem,
  type CommentItem,
  type MentionItem,
  type MorningProject,
  type WorkTask,
  type WorkTaskStatus,
} from "@/lib/appsScript";
import CreateTaskDrawer from "@/components/CreateTaskDrawer";
import Avatar from "@/components/Avatar";
import MetricsIframe from "@/components/MetricsIframe";
import CardActions from "@/components/CardActions";
import ThreadReplies from "@/components/ThreadReplies";
import MorningSignalRow from "@/components/MorningSignalRow";
import ProjectFilterBar from "@/components/ProjectFilterBar";
import OutOfScopeBanner from "@/components/OutOfScopeBanner";
import { isPersonOnProject } from "@/lib/scope";
import { getScopedPerson } from "@/lib/scope-server";

export const dynamic = "force-dynamic";

type Params = { project: string };
type Search = { resolved?: string; person?: string };

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
  // an unauthorized caller gets consistent errors. workTasksRes is the
  // new work-management Tasks feed (grouped by status bucket below);
  // tasksRes is the legacy comment-mention Google-Tasks feed — kept for
  // now so the "משימות מתיוגים" section stays populated.
  const [tasksRes, commentsRes, mentionsRes, projectsRes, alertsRes, workTasksRes] =
    await Promise.allSettled([
      getProjectTasks(projectName),
      getProjectComments(projectName, 15),
      getMyMentions(),
      getMyProjects(),
      getMorningFeed({ project: projectName }),
      tasksList({ project: projectName }),
    ]);

  const tasksData = tasksRes.status === "fulfilled" ? tasksRes.value : null;
  const commentsData =
    commentsRes.status === "fulfilled" ? commentsRes.value : null;
  const mentionsData =
    mentionsRes.status === "fulfilled" ? mentionsRes.value : null;
  const projectsData =
    projectsRes.status === "fulfilled" ? projectsRes.value : null;
  const alertsData =
    alertsRes.status === "fulfilled" ? alertsRes.value : null;
  const workTasksData =
    workTasksRes.status === "fulfilled" ? workTasksRes.value : null;
  const projectAlerts: MorningProject | null =
    alertsData?.projects[0] ?? null;

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

  // If the tasks call failed, it's likely an access-denied — show the first error.
  const firstError =
    tasksRes.status === "rejected"
      ? extractError(tasksRes.reason)
      : commentsRes.status === "rejected"
        ? extractError(commentsRes.reason)
        : null;

  const tasks = tasksData?.tasks ?? [];
  const comments = commentsData?.comments ?? [];
  const myMentionsOnProject =
    mentionsData?.mentions.filter((m) => m.project === projectName) ?? [];
  const workTasks = workTasksData?.tasks ?? [];

  const openTasks = tasks.filter((t) => !t.resolved).length;
  // Open work-tasks: anything not in a terminal state. Matches the queue's
  // default (done / cancelled fall out; draft, awaiting_approval,
  // awaiting_clarification, in_progress all count).
  const openWorkTasks = workTasks.filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  ).length;
  const totalComments = commentsData?.total ?? 0;
  const openMentions = myMentionsOnProject.filter((m) => !m.resolved).length;

  // Resolved-item count across the three preview sections. Drives the
  // "(N)" badge on the filter-bar toggle so users see at a glance how
  // much is currently hidden. Only top-level comments are countable
  // here — replies inherit their parent's resolved state on the Apps
  // Script side and aren't independently resolvable in the UI.
  const resolvedTasks = tasks.filter((t) => t.resolved).length;
  const resolvedMentions = myMentionsOnProject.filter((m) => m.resolved).length;
  const resolvedComments = comments.filter(
    (c) => !c.parent_id && c.resolved,
  ).length;
  const resolvedCount = resolvedTasks + resolvedMentions + resolvedComments;

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
          {chatSpaceUrl && (
            <a
              className="btn-chat"
              href={chatSpaceUrl}
              target="_blank"
              rel="noreferrer"
              title="פתח את שיחת הפרויקט ב-Google Chat"
            >
              💬 פתח בצ׳אט
            </a>
          )}
          <CreateTaskDrawer project={projectName} />
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
          <WorkTasksPreview projectName={projectName} tasks={workTasks} />
        </section>

        <section className="project-section">
          <div className="section-head">
            <h2>
              💬 משימות מתיוגים
              <span className="section-count">{openTasks}</span>
            </h2>
            <Link
              className="section-link"
              href={`/projects/${encodeURIComponent(projectName)}/tasks`}
            >
              פתח לוח ←
            </Link>
          </div>
          <p className="section-subtitle">
            {showResolved
              ? "כל המשימות בפרויקט (פתוחות וסגורות)"
              : "משימות פתוחות על שרשורים בפרויקט (נוצרות מתיוגים ב־@ על הערות)"}
          </p>
          <TasksPreview
            tasks={tasks}
            today={tasksData?.today ?? today()}
            showResolved={showResolved}
          />
        </section>

        <section className="project-section">
          <div className="section-head">
            <h2>
              🏷️ התיוגים שלך בפרויקט
              <span className="section-count">{openMentions}</span>
            </h2>
            <Link className="section-link" href="/inbox">
              כל התיוגים ←
            </Link>
          </div>
          <p className="section-subtitle">
            {showResolved
              ? "כל התיוגים בפרויקט (פתוחים וסגורים)"
              : "שרשורים שבהם תויגת ועוד לא סגרת"}
          </p>
          <MentionsPreview
            mentions={myMentionsOnProject}
            showResolved={showResolved}
          />
        </section>

        <section className="project-section">
          <div className="section-head">
            <h2>
              💬 הערות אחרונות
              <span className="section-count">{totalComments}</span>
            </h2>
            <Link
              className="section-link"
              href={`/projects/${encodeURIComponent(projectName)}/timeline`}
            >
              פתח ציר זמן ←
            </Link>
          </div>
          <p className="section-subtitle">
            {showResolved
              ? "כל ההערות האחרונות בפרויקט (פתוחות וסגורות)"
              : "פעילות חדשה בפרויקט — הערות פתוחות"}
          </p>
          <CommentsPreview
            comments={comments}
            projectName={projectName}
            showResolved={showResolved}
          />
          {totalComments > comments.length && (
            <div className="section-foot">
              מציג {comments.length} מתוך {totalComments}
            </div>
          )}
        </section>
      </div>

      {/* Alerts section — pacing/budget/deadline/paused-budget signals for
          this project only. Same dismiss/snooze/revisit behavior as the
          morning page; dismissals are team-wide. */}
      {projectAlerts && projectAlerts.signals.length > 0 && (
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
      )}

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

function TasksPreview({
  tasks,
  today,
  showResolved,
}: {
  tasks: TaskItem[];
  today: string;
  showResolved: boolean;
}) {
  // When showResolved is on, include resolved tasks inline — they render
  // with .compact-task.done styling already (via taskState). Otherwise
  // filter to open only.
  const pool = showResolved ? tasks : tasks.filter((t) => !t.resolved);
  if (pool.length === 0) {
    return (
      <div className="empty-small">
        {showResolved ? "🌿 אין משימות בפרויקט זה." : "🎉 אין משימות פתוחות!"}
      </div>
    );
  }

  // Group replies under their parent so the visual order mirrors the
  // thread structure: [top-level] → [its reply] → [its reply] → [next
  // top-level] ... Orphan replies (parent not in the visible window)
  // land at the end, still marked as replies.
  const topLevel = pool.filter((t) => !t.parent_id);
  const repliesByParent = new Map<string, TaskItem[]>();
  for (const t of pool) {
    if (!t.parent_id) continue;
    const list = repliesByParent.get(t.parent_id) ?? [];
    list.push(t);
    repliesByParent.set(t.parent_id, list);
  }
  const ordered: TaskItem[] = [];
  for (const t of topLevel) {
    ordered.push(t);
    const replies = repliesByParent.get(t.comment_id);
    if (replies) ordered.push(...replies);
    repliesByParent.delete(t.comment_id);
  }
  // Any replies whose parent isn't in the visible set.
  for (const replies of repliesByParent.values()) ordered.push(...replies);
  const visible = ordered.slice(0, 6);

  return (
    <ul className="compact-list">
      {visible.map((t) => {
        const state = taskState(t, today);
        const isReply = !!t.parent_id;
        return (
          <li
            key={t.comment_id + "|" + t.assignee_email}
            className={`compact-task ${state} ${isReply ? "is-reply" : ""}`}
          >
            <div className="compact-task-title">
              {isReply && (
                <span className="compact-task-reply-arrow" aria-hidden>
                  ↪{" "}
                </span>
              )}
              {t.deep_link ? (
                <a href={t.deep_link} target="_blank" rel="noreferrer">
                  {truncate(t.title, 100) || "(ללא תוכן)"}
                </a>
              ) : (
                truncate(t.title, 100) || "(ללא תוכן)"
              )}
            </div>
            <div className="compact-task-meta">
              <span className="chip">{t.assignee_name}</span>
              {t.due && (
                <span className={`chip due-${state}`}>{formatDue(t.due, today)}</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Work-management tasks preview — groups open tasks by status bucket
 * (בעבודה / ממתין לאישור / ממתין לבירור) and shows a few per bucket with
 * a "see all" link to the full queue filtered to this project. The
 * done / cancelled buckets are omitted here since they're the terminal
 * states; get them via the full queue view.
 */
function WorkTasksPreview({
  projectName,
  tasks,
}: {
  projectName: string;
  tasks: WorkTask[];
}) {
  const OPEN_BUCKETS: { key: WorkTaskStatus; label: string; tone: string }[] = [
    { key: "in_progress", label: "בעבודה", tone: "in_progress" },
    { key: "awaiting_approval", label: "ממתין לאישור", tone: "awaiting_approval" },
    { key: "awaiting_clarification", label: "ממתין לבירור", tone: "awaiting_clarification" },
  ];
  const byStatus: Record<string, WorkTask[]> = {};
  for (const b of OPEN_BUCKETS) byStatus[b.key] = [];
  for (const t of tasks) {
    if (byStatus[t.status]) byStatus[t.status].push(t);
  }
  const anyOpen = OPEN_BUCKETS.some((b) => (byStatus[b.key] || []).length);
  if (!anyOpen) {
    return (
      <div className="empty-small">
        🎉 אין משימות פתוחות בפרויקט זה.{" "}
        <Link href={`/tasks/new?project=${encodeURIComponent(projectName)}`}>
          צור משימה חדשה →
        </Link>
      </div>
    );
  }
  return (
    <div className="work-tasks-preview">
      {OPEN_BUCKETS.map((b) => {
        const list = (byStatus[b.key] || [])
          .slice()
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, 4);
        if (!list.length) return null;
        return (
          <div
            key={b.key}
            className={`work-tasks-preview-bucket tasks-bucket-${b.tone}`}
          >
            <div className="work-tasks-preview-bucket-head">
              <span
                className={`tasks-status-pill tasks-status-${b.key}`}
              >
                {b.label}
              </span>
              <span className="work-tasks-preview-count">
                {byStatus[b.key].length}
              </span>
            </div>
            <ul className="work-tasks-preview-list">
              {list.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/tasks/${encodeURIComponent(t.id)}`}
                    className="work-tasks-preview-link"
                  >
                    <span className="work-tasks-preview-title">
                      {t.title || "(ללא כותרת)"}
                    </span>
                    <span className="work-tasks-preview-meta">
                      {t.assignees.length > 0 && (
                        <span className="chip">
                          {t.assignees
                            .map((e) => e.split("@")[0])
                            .slice(0, 2)
                            .join(", ")}
                          {t.assignees.length > 2
                            ? ` +${t.assignees.length - 2}`
                            : ""}
                        </span>
                      )}
                      {t.requested_date && (
                        <span className="chip">{t.requested_date}</span>
                      )}
                      {t.sub_status && (
                        <span className="tasks-substatus-pill">
                          {t.sub_status}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function CommentsPreview({
  comments,
  projectName,
  showResolved,
}: {
  comments: CommentItem[];
  projectName: string;
  showResolved: boolean;
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
      {top.map((c) => (
        <li
          key={c.comment_id}
          className={`compact-comment ${c.resolved ? "is-resolved" : ""}`}
        >
          <div className="compact-comment-head">
            <Avatar name={c.author_email} title={c.author_name || c.author_email} size={22} />
            <span className="author">{c.author_name || c.author_email}</span>
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
          <div className="compact-comment-body">{truncate(c.body, 220)}</div>
          <div className="compact-comment-actions">
            <CardActions
              commentId={c.comment_id}
              resolved={c.resolved}
              body={c.body}
              deleteItemLabel="את התגובה"
            />
          </div>
        </li>
      ))}
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
            <div className="compact-comment-body">{truncate(m.body, 200)}</div>
            <div className="compact-comment-actions">
              <CardActions
                commentId={actionTarget}
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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function taskState(
  t: TaskItem,
  today: string,
): "done" | "overdue" | "due-today" | "" {
  if (t.resolved) return "done";
  if (!t.due) return "";
  if (t.due < today) return "overdue";
  if (t.due === today) return "due-today";
  return "";
}

function formatDue(due: string, today: string): string {
  if (due === today) return "יעד היום";
  if (due < today) return `עבר היעד (${due})`;
  return `יעד ${due}`;
}

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
