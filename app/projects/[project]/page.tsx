import Link from "next/link";
import {
  getProjectTasks,
  getProjectComments,
  getMyMentions,
  type TaskItem,
  type CommentItem,
  type MentionItem,
} from "@/lib/appsScript";

export const dynamic = "force-dynamic";

type Params = { project: string };

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { project: projectParam } = await params;
  const projectName = decodeURIComponent(projectParam);

  // Fire three API calls in parallel — each one validates access independently,
  // so if the user is unauthorized we'll get consistent errors.
  const [tasksRes, commentsRes, mentionsRes] = await Promise.allSettled([
    getProjectTasks(projectName),
    getProjectComments(projectName, 15),
    getMyMentions(),
  ]);

  const tasksData = tasksRes.status === "fulfilled" ? tasksRes.value : null;
  const commentsData =
    commentsRes.status === "fulfilled" ? commentsRes.value : null;
  const mentionsData =
    mentionsRes.status === "fulfilled" ? mentionsRes.value : null;

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
          <h1>{projectName}</h1>
          <div className="subtitle">
            <Link href="/">← All projects</Link>
          </div>
        </div>
      </header>

      {firstError && (
        <div className="error">
          <strong>Failed to load project.</strong>
          <br />
          {firstError}
        </div>
      )}

      <div className="stats-grid">
        <StatTile label="Open tasks" value={openTasks} />
        <StatTile label="Open mentions for you" value={openMentions} />
        <StatTile label="Total comments" value={totalComments} />
      </div>

      <div className="project-sections">
        <section className="project-section">
          <div className="section-head">
            <h2>Tasks</h2>
            <Link
              className="section-link"
              href={`/projects/${encodeURIComponent(projectName)}/tasks`}
            >
              Open board →
            </Link>
          </div>
          <TasksPreview tasks={tasks} today={tasksData?.today ?? today()} />
        </section>

        <section className="project-section">
          <div className="section-head">
            <h2>Recent comments</h2>
            <Link
              className="section-link"
              href={`/projects/${encodeURIComponent(projectName)}/timeline`}
            >
              Open timeline →
            </Link>
          </div>
          <CommentsPreview comments={comments} />
          {totalComments > comments.length && (
            <div className="section-foot">
              Showing {comments.length} of {totalComments}
            </div>
          )}
        </section>

        <section className="project-section">
          <div className="section-head">
            <h2>Your mentions on this project</h2>
            <Link className="section-link" href="/inbox">
              Full inbox →
            </Link>
          </div>
          <MentionsPreview mentions={myMentionsOnProject} />
        </section>
      </div>
    </main>
  );
}

/* ─── Sections ───────────────────────────────────────────────────── */

function TasksPreview({ tasks, today }: { tasks: TaskItem[]; today: string }) {
  const open = tasks.filter((t) => !t.resolved).slice(0, 6);
  if (open.length === 0) {
    return <div className="empty-small">No open tasks.</div>;
  }
  return (
    <ul className="compact-list">
      {open.map((t) => {
        const state = taskState(t, today);
        return (
          <li key={t.comment_id + "|" + t.assignee_email} className={`compact-task ${state}`}>
            <div className="compact-task-title">
              {t.deep_link ? (
                <a href={t.deep_link} target="_blank" rel="noreferrer">
                  {truncate(t.title, 100) || "(no body)"}
                </a>
              ) : (
                truncate(t.title, 100) || "(no body)"
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
    return <div className="empty-small">No comments yet on this project.</div>;
  }
  return (
    <ul className="compact-list">
      {top.map((c) => (
        <li
          key={c.comment_id}
          className={`compact-comment ${c.resolved ? "is-resolved" : ""}`}
        >
          <div className="compact-comment-head">
            <span className="author">{c.author_name || c.author_email}</span>
            <span className="time" title={c.timestamp}>
              {formatRelative(c.timestamp)}
            </span>
            {c.reply_count > 0 && (
              <span className="chip chip-muted">{c.reply_count} replies</span>
            )}
            {c.resolved && <span className="chip chip-done">resolved</span>}
          </div>
          <div className="compact-comment-body">{truncate(c.body, 220)}</div>
          {c.deep_link && (
            <a
              className="compact-link"
              href={c.deep_link}
              target="_blank"
              rel="noreferrer"
            >
              Open in dashboard →
            </a>
          )}
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
        You haven&apos;t been @-mentioned on this project.
      </div>
    );
  }
  return (
    <ul className="compact-list">
      {top.map((m) => (
        <li
          key={m.comment_id}
          className={`compact-comment ${m.resolved ? "is-resolved" : ""}`}
        >
          <div className="compact-comment-head">
            <span className="author">{m.author_name || m.author_email}</span>
            <span className="time" title={m.timestamp}>
              {formatRelative(m.timestamp)}
            </span>
            {m.resolved && <span className="chip chip-done">resolved</span>}
          </div>
          <div className="compact-comment-body">{truncate(m.body, 200)}</div>
          {m.deep_link && (
            <a
              className="compact-link"
              href={m.deep_link}
              target="_blank"
              rel="noreferrer"
            >
              Open in dashboard →
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

/* ─── Small bits ─────────────────────────────────────────────────── */

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-tile">
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
  if (due === today) return "Due today";
  if (due < today) return `Overdue (${due})`;
  return `Due ${due}`;
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
  if (diffSec < 60) return "just now";
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(days / 365);
  return `${years}y ago`;
}

function extractError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
