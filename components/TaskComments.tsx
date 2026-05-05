import Avatar from "./Avatar";
import TaskReplyComposer from "./TaskReplyComposer";
import EditDrawer from "./EditDrawer";
import DeleteButton from "./DeleteButton";
import CommentBody from "./CommentBody";
import { getTaskComments, tasksPeopleList } from "@/lib/appsScript";
import { formatDateIso } from "@/lib/dateFormat";
import { personDisplayName } from "@/lib/personDisplay";

type Props = {
  taskId: string;
};

export default async function TaskComments({ taskId }: Props) {
  // Pull comments + people in parallel — people drives the
  // English-email → Hebrew-name resolution for comment authors so the
  // discussion thread shows "מעין" instead of "maayan". The people
  // call is cheap (~60 entries portfolio-wide) and the fetch was
  // already running on the parent page anyway.
  const [data, peopleRes] = await Promise.all([
    getTaskComments(taskId).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: msg } as const;
    }),
    tasksPeopleList().catch(() => ({ ok: false, people: [] as never[] })),
  ]);
  const people = peopleRes.ok ? peopleRes.people : [];

  if ("error" in data) {
    return (
      <section className="task-detail-comments">
        <h3>דיון</h3>
        <div className="task-comments-error">שגיאה בטעינת תגובות: {data.error}</div>
      </section>
    );
  }

  const { comments, me } = data;
  const project = data.project || "";
  const myEmail = (me?.email || "").toLowerCase();
  const isAdmin = !!me?.isAdmin;

  return (
    <section className="task-detail-comments">
      <h3>
        דיון{" "}
        <span className="task-comments-count">
          {comments.length > 0 ? `(${comments.length})` : ""}
        </span>
      </h3>

      {comments.length === 0 && (
        <div className="task-comments-empty">אין תגובות עדיין — התחל את הדיון.</div>
      )}

      {comments.length > 0 && (
        <ul className="task-comments-list">
          {comments.map((c) => {
            const canEdit =
              !!myEmail && c.author_email.toLowerCase() === myEmail;
            const canDelete = canEdit || isAdmin;
            return (
              <li key={c.comment_id} className="thread-reply">
                <Avatar
                  name={c.author_email}
                  title={
                    personDisplayName(c.author_email, people) ||
                    c.author_name ||
                    c.author_email
                  }
                  size={26}
                />
                <div className="thread-reply-body">
                  <div className="thread-reply-head">
                    <span className="thread-reply-author">
                      {personDisplayName(c.author_email, people) ||
                        c.author_name ||
                        c.author_email}
                    </span>
                    <span className="thread-reply-time" title={c.timestamp}>
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
                    {(canEdit || canDelete) && (
                      <span className="thread-reply-actions">
                        {canEdit && (
                          <EditDrawer
                            commentId={c.comment_id}
                            initialBody={c.body}
                            iconOnly
                          />
                        )}
                        {canDelete && (
                          <DeleteButton
                            commentId={c.comment_id}
                            itemLabel="את ההערה"
                            iconOnly
                          />
                        )}
                      </span>
                    )}
                  </div>
                  <CommentBody body={c.body} className="thread-reply-text" />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <TaskReplyComposer taskId={taskId} project={project} />
    </section>
  );
}

// Body rendering used to live here as a duplicate of components/CommentBody.tsx.
// Removed 2026-05-03 in favor of the shared component — kept the two in sync
// was a maintenance trap (the auto-link fix for long URLs landed in the
// shared module but missed the duplicate, leaving the task discussion view
// rendering bare URLs as plain text). The shared CommentBody now powers
// every comment surface (project page, inbox, task discussion, threads).

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
  return formatDateIso(iso);
}
