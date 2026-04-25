import Link from "next/link";
import {
  getProjectTasks,
  getProjectComments,
  type TaskItem,
  type CommentItem,
} from "@/lib/appsScript";
import TimelineFilterBar from "@/components/TimelineFilterBar";
import CardActions from "@/components/CardActions";
import ScrollToThread from "@/components/ScrollToThread";
import Avatar from "@/components/Avatar";

export const dynamic = "force-dynamic";

type Params = { project: string };
type Search = { kind?: string; resolved?: string; q?: string; author?: string };

type CommentEntry = {
  kind: "comment";
  at: number;
  iso: string;
  comment: CommentItem;
  spawnedTasks: TaskItem[];
};
type TaskEntry = {
  kind: "task";
  at: number;
  iso: string;
  task: TaskItem;
};
type FeedEntry = CommentEntry | TaskEntry;

export default async function ProjectTimelinePage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { project: projectParam } = await params;
  const projectName = decodeURIComponent(projectParam);
  const sp = await searchParams;
  const rawKind = sp.kind ?? "";
  const kindFilter: "" | "comment" | "task" =
    rawKind === "comment" || rawKind === "task" ? rawKind : "";
  const showResolved = sp.resolved === "1";
  const query = (sp.q ?? "").trim();
  const queryLc = query.toLowerCase();
  const authorFilter = (sp.author ?? "").trim();

  const [tasksRes, commentsRes] = await Promise.allSettled([
    getProjectTasks(projectName),
    getProjectComments(projectName, 100),
  ]);

  const tasksData = tasksRes.status === "fulfilled" ? tasksRes.value : null;
  const commentsData =
    commentsRes.status === "fulfilled" ? commentsRes.value : null;
  const firstError =
    tasksRes.status === "rejected"
      ? extractError(tasksRes.reason)
      : commentsRes.status === "rejected"
        ? extractError(commentsRes.reason)
        : null;

  const tasks = tasksData?.tasks ?? [];
  const comments = commentsData?.comments ?? [];
  const today = tasksData?.today ?? new Date().toISOString().slice(0, 10);
  const totalComments = commentsData?.total ?? comments.length;

  // Build the merged feed. A task whose source comment is already in `comments`
  // gets folded into that comment's entry as a chip — showing it separately
  // would just duplicate the body. Tasks whose source comment is older than
  // the comment fetch window appear as standalone entries.
  const commentIds = new Set(comments.map((c) => c.comment_id));
  const tasksByCommentId = new Map<string, TaskItem[]>();
  for (const t of tasks) {
    const list = tasksByCommentId.get(t.comment_id) ?? [];
    list.push(t);
    tasksByCommentId.set(t.comment_id, list);
  }

  const allEntries: FeedEntry[] = [];
  for (const c of comments) {
    allEntries.push({
      kind: "comment",
      at: toTs(c.timestamp),
      iso: c.timestamp,
      comment: c,
      spawnedTasks: tasksByCommentId.get(c.comment_id) ?? [],
    });
  }
  for (const t of tasks) {
    if (commentIds.has(t.comment_id)) continue;
    allEntries.push({
      kind: "task",
      at: toTs(t.created_at),
      iso: t.created_at,
      task: t,
    });
  }
  allEntries.sort((a, b) => b.at - a.at);

  const counts = {
    all: allEntries.length,
    comments: allEntries.filter((e) => e.kind === "comment").length,
    tasks:
      allEntries.filter((e) => e.kind === "task").length +
      allEntries.reduce(
        (n, e) => n + (e.kind === "comment" ? e.spawnedTasks.length : 0),
        0,
      ),
  };

  let visible: FeedEntry[];
  if (kindFilter === "task") {
    // Flatten all tasks as standalone entries — no folding — so filtering to
    // "tasks" surfaces every task including ones attached to fetched comments.
    visible = tasks
      .filter((t) => showResolved || !t.resolved)
      .map<FeedEntry>((t) => ({
        kind: "task",
        at: toTs(t.created_at),
        iso: t.created_at,
        task: t,
      }))
      .sort((a, b) => b.at - a.at);
  } else {
    visible = allEntries.filter((e) => {
      if (kindFilter === "comment" && e.kind !== "comment") return false;
      if (!showResolved) {
        if (e.kind === "comment" && e.comment.resolved) return false;
        if (e.kind === "task" && e.task.resolved) return false;
      }
      return true;
    });
  }

  // Text + author filters — applied after kind/resolved so the filter bar's
  // counts still reflect the broader feed. Authors are case-insensitive
  // matched against the stored full name OR email. Query matches the body
  // (comment.body or task.title + task.body) substring, case-insensitive.
  const entryAuthorName = (e: FeedEntry): string =>
    e.kind === "comment" ? e.comment.author_name || e.comment.author_email : e.task.author_name || e.task.author_email;
  const entryBodyLc = (e: FeedEntry): string =>
    e.kind === "comment"
      ? (e.comment.body || "").toLowerCase()
      : ((e.task.title || "") + " " + (e.task.body || "")).toLowerCase();

  if (authorFilter) {
    const af = authorFilter.toLowerCase();
    visible = visible.filter((e) => entryAuthorName(e).toLowerCase() === af);
  }
  if (queryLc) {
    visible = visible.filter((e) => entryBodyLc(e).includes(queryLc));
  }

  // Distinct author names across the whole feed — powers the filter dropdown.
  // Built from `allEntries` (not `visible`) so toggling a filter doesn't shrink
  // the dropdown options the user might want to pick next.
  const authorSet = new Set<string>();
  for (const e of allEntries) {
    const name = entryAuthorName(e);
    if (name) authorSet.add(name);
  }
  const authors = Array.from(authorSet).sort((a, b) => a.localeCompare(b, "he"));

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>📅</span>
            {projectName} · ציר זמן
          </h1>
          <div className="subtitle">
            <Link href={`/projects/${encodeURIComponent(projectName)}`}>
              → סקירת {projectName}
            </Link>
            {commentsData && totalComments > comments.length && (
              <> · מציג {comments.length} מתוך {totalComments} ההערות האחרונות</>
            )}
          </div>
        </div>
      </header>

      {firstError && (
        <div className="error">
          <strong>שגיאה בטעינת ציר הזמן.</strong>
          <br />
          {firstError}
        </div>
      )}

      {!firstError && counts.all > 0 && (
        <TimelineFilterBar
          currentKind={kindFilter}
          showResolved={showResolved}
          counts={counts}
          authors={authors}
          currentAuthor={authorFilter}
          currentQuery={query}
        />
      )}
      {/* Scroll-to-thread on #thread-{id} hash — e.g. from ⌘K results
          or the dashboard drawer's "פתח בהאב" deep-links. */}
      <ScrollToThread />

      {!firstError && visible.length === 0 && (
        <div className="empty">
          <span className="emoji" aria-hidden>
            {counts.all === 0 ? "🌱" : "🔍"}
          </span>
          {counts.all === 0
            ? "עדיין אין פעילות בפרויקט זה."
            : "אין רשומות תואמות לסינון הנוכחי."}
        </div>
      )}

      {visible.length > 0 && (
        <ul className="timeline-list">
          {visible.map((e) =>
            e.kind === "comment" ? (
              <CommentRow key={`c:${e.comment.comment_id}`} entry={e} />
            ) : (
              <TaskRow
                key={`t:${e.task.comment_id}|${e.task.assignee_email}`}
                entry={e}
                today={today}
              />
            ),
          )}
        </ul>
      )}
    </main>
  );
}

/* ─── Row renderers ──────────────────────────────────────────────── */

function CommentRow({ entry }: { entry: CommentEntry }) {
  const c = entry.comment;
  const isReply = !!c.parent_id;
  // Anchor id — target for #thread-{id} deep-links (⌘K results, dashboard
  // drawer's "פתח בהאב" button). For replies, land on the reply itself so
  // the user sees the specific sub-comment, not just the thread root.
  return (
    <li
      id={`thread-${c.comment_id}`}
      className={`timeline-entry ${c.resolved ? "is-resolved" : ""} ${isReply ? "is-reply" : ""}`}
    >
      <div className="timeline-rail">
        <span className="timeline-dot timeline-dot-comment" aria-hidden />
      </div>
      <div className="timeline-card">
        <div className="timeline-head">
          <Avatar name={c.author_email} title={c.author_name || c.author_email} size={26} />
          <span className="chip chip-muted">💬 הערה</span>
          <span className="author">{c.author_name || c.author_email}</span>
          {c.parent_id && <span className="chip chip-muted">↩️ תגובה</span>}
          {c.reply_count > 0 && (
            <span className="chip chip-muted">{c.reply_count} תגובות</span>
          )}
          {c.edited_at && (
            <span
              className="chip chip-muted"
              title={`נערך ${formatRelative(c.edited_at)}`}
            >
              📝 נערך
            </span>
          )}
          <span className="time" title={c.timestamp}>
            {formatRelative(c.timestamp)}
          </span>
        </div>
        <div className="timeline-body">{truncate(c.body, 600)}</div>
        {entry.spawnedTasks.length > 0 && (
          <div className="timeline-tasks">
            <span className="timeline-tasks-label">משימות שנוצרו:</span>
            {entry.spawnedTasks.map((t) => (
              <span
                key={t.comment_id + "|" + t.assignee_email}
                className={`chip ${t.resolved ? "chip-done" : ""}`}
                title={t.due ? `יעד ${t.due}` : "ללא תאריך יעד"}
              >
                {t.assignee_name || t.assignee_email}
                {t.due && !t.resolved ? ` · ${t.due}` : ""}
              </span>
            ))}
          </div>
        )}
        <div className="timeline-actions">
          {/* Top-level comments get all 4 actions. Replies skip reply/resolve
              (those operate on the thread root) — CardActions takes care of
              both via canReply + readOnlyWhenResolved flags. */}
          {!c.parent_id ? (
            <CardActions
              commentId={c.comment_id}
              resolved={c.resolved}
              body={c.body}
              deleteItemLabel="את התגובה"
            />
          ) : (
            <CardActions
              commentId={c.comment_id}
              resolved={c.resolved}
              body={c.body}
              deleteItemLabel="את התגובה"
              canReply={false}
              readOnlyWhenResolved
            />
          )}
        </div>
      </div>
    </li>
  );
}

function TaskRow({ entry, today }: { entry: TaskEntry; today: string }) {
  const t = entry.task;
  const state = taskState(t, today);
  // Tasks share the thread anchor with their source comment so a ⌘K deep
  // link lands on whichever form (task-only row or comment-with-task chip)
  // happens to render for this thread.
  return (
    <li
      id={`thread-${t.comment_id}`}
      className={`timeline-entry ${t.resolved ? "is-resolved" : ""}`}
    >
      <div className="timeline-rail">
        <span
          className={`timeline-dot timeline-dot-task ${state}`}
          aria-hidden
        />
      </div>
      <div className="timeline-card">
        <div className="timeline-head">
          <Avatar name={t.assignee_email} title={t.assignee_name || t.assignee_email} size={26} />
          <span className="chip">📋 משימה</span>
          <span className="author">
            עבור {t.assignee_name || t.assignee_email}
          </span>
          {t.due && !t.resolved && state === "overdue" && (
            <span className="chip due-overdue">🔥 {formatDue(t.due, today)}</span>
          )}
          {t.due && !t.resolved && state === "due-today" && (
            <span className="chip due-due-today">⏰ {formatDue(t.due, today)}</span>
          )}
          {t.due && !t.resolved && state === "" && (
            <span className="chip chip-muted">{formatDue(t.due, today)}</span>
          )}
          {t.resolved && <span className="chip chip-done">✅ הושלם</span>}
          {t.edited_at && (
            <span
              className="chip chip-muted"
              title={`נערך ${formatRelative(t.edited_at)}`}
            >
              📝 נערך
            </span>
          )}
          <span className="time" title={t.created_at}>
            {formatRelative(t.created_at)}
          </span>
        </div>
        <div className="timeline-body">{truncate(t.title || t.body, 600)}</div>
        <div className="timeline-subnote">
          מאת {t.author_name || t.author_email}
        </div>
        <div className="timeline-actions">
          <CardActions
            commentId={t.comment_id}
            resolved={t.resolved}
            body={t.body}
            deleteItemLabel="את המשימה"
            canConvertToTask={false}
          />
        </div>
      </div>
    </li>
  );
}

/* ─── Helpers ────────────────────────────────────────────────────── */

function toTs(iso: string): number {
  const n = new Date(iso).getTime();
  return Number.isNaN(n) ? 0 : n;
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
