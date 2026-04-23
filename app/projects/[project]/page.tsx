import Link from "next/link";
import {
  getProjectTasks,
  getProjectComments,
  getMyMentions,
  getMyProjects,
  getMorningFeed,
  type TaskItem,
  type CommentItem,
  type MentionItem,
  type MorningProject,
} from "@/lib/appsScript";
import CreateTaskDrawer from "@/components/CreateTaskDrawer";
import Avatar from "@/components/Avatar";
import MetricsIframe from "@/components/MetricsIframe";
import CardActions from "@/components/CardActions";
import ThreadReplies from "@/components/ThreadReplies";
import MorningSignalRow from "@/components/MorningSignalRow";

export const dynamic = "force-dynamic";

type Params = { project: string };

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { project: projectParam } = await params;
  const projectName = decodeURIComponent(projectParam);

  // Fire four API calls in parallel — each one validates access independently,
  // so if the user is unauthorized we'll get consistent errors. getMyProjects
  // is added so we can resolve the project's company for the dashboard iframe
  // filter (needs ?company=X&project=Y).
  const [tasksRes, commentsRes, mentionsRes, projectsRes, alertsRes] =
    await Promise.allSettled([
      getProjectTasks(projectName),
      getProjectComments(projectName, 15),
      getMyMentions(),
      getMyProjects(),
      getMorningFeed({ project: projectName }),
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
  const projectAlerts: MorningProject | null =
    alertsData?.projects[0] ?? null;

  const projectMeta = projectsData?.projects.find(
    (p) => p.name === projectName,
  );
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

  const openTasks = tasks.filter((t) => !t.resolved).length;
  const totalComments = commentsData?.total ?? 0;
  const openMentions = myMentionsOnProject.filter((m) => !m.resolved).length;

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

      <div className="stats-grid">
        <StatTile label="📋 משימות פתוחות" value={openTasks} variant="tasks" />
        <StatTile label="🏷️ תיוגים פתוחים עבורך" value={openMentions} variant="mentions" />
        <StatTile label='💬 סה"כ הערות' value={totalComments} variant="comments" />
      </div>

      <div className="project-sections">
        <section className="project-section">
          <div className="section-head">
            <h2>📋 משימות</h2>
            <Link
              className="section-link"
              href={`/projects/${encodeURIComponent(projectName)}/tasks`}
            >
              פתח לוח ←
            </Link>
          </div>
          <TasksPreview tasks={tasks} today={tasksData?.today ?? today()} />
        </section>

        <section className="project-section">
          <div className="section-head">
            <h2>💬 הערות אחרונות</h2>
            <Link
              className="section-link"
              href={`/projects/${encodeURIComponent(projectName)}/timeline`}
            >
              פתח ציר זמן ←
            </Link>
          </div>
          <CommentsPreview comments={comments} />
          {totalComments > comments.length && (
            <div className="section-foot">
              מציג {comments.length} מתוך {totalComments}
            </div>
          )}
        </section>

        <section className="project-section">
          <div className="section-head">
            <h2>🏷️ התיוגים שלך בפרויקט</h2>
            <Link className="section-link" href="/inbox">
              כל התיוגים ←
            </Link>
          </div>
          <MentionsPreview mentions={myMentionsOnProject} />
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
      {dashboardFilteredUrl && (
        <section className="project-section project-section-metrics">
          <div className="section-head">
            <h2>📊 מטריקות</h2>
            <a
              className="section-link"
              href={dashboardFilteredUrl}
              target="_blank"
              rel="noreferrer"
            >
              פתח בכרטיסייה חדשה ↗
            </a>
          </div>
          <MetricsIframe
            src={dashboardFilteredUrl}
            projectName={projectName}
            expectedEmail={userEmail}
          />
        </section>
      )}
    </main>
  );
}

/* ─── Sections ───────────────────────────────────────────────────── */

function TasksPreview({ tasks, today }: { tasks: TaskItem[]; today: string }) {
  const open = tasks.filter((t) => !t.resolved);
  if (open.length === 0) {
    return <div className="empty-small">🎉 אין משימות פתוחות!</div>;
  }

  // Group replies under their parent so the visual order mirrors the
  // thread structure: [top-level] → [its reply] → [its reply] → [next
  // top-level] ... Orphan replies (parent not in the visible window)
  // land at the end, still marked as replies.
  const topLevel = open.filter((t) => !t.parent_id);
  const repliesByParent = new Map<string, TaskItem[]>();
  for (const t of open) {
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

function CommentsPreview({ comments }: { comments: CommentItem[] }) {
  const top = comments.filter((c) => !c.parent_id).slice(0, 8);
  if (top.length === 0) {
    return <div className="empty-small">💭 אין הערות בפרויקט זה עדיין.</div>;
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
    </ul>
  );
}

function MentionsPreview({ mentions }: { mentions: MentionItem[] }) {
  const top = mentions.slice(0, 5);
  if (top.length === 0) {
    return (
      <div className="empty-small">
        🌿 לא תויגת בפרויקט זה.
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
    </ul>
  );
}

/* ─── Small bits ─────────────────────────────────────────────────── */

function StatTile({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant?: "tasks" | "mentions" | "comments";
}) {
  const cls = variant ? `stat-tile stat-tile-${variant}` : "stat-tile";
  return (
    <div className={cls}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

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
  filters: { company?: string; project?: string; authuser?: string },
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
  return url.toString();
}
