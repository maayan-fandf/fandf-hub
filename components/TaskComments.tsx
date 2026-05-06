import TaskReplyComposer from "./TaskReplyComposer";
import TaskCommentRow from "./TaskCommentRow";
import { getTaskComments, tasksPeopleList } from "@/lib/appsScript";

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
              <TaskCommentRow
                key={c.comment_id}
                comment={c}
                people={people}
                canEdit={canEdit}
                canDelete={canDelete}
              />
            );
          })}
        </ul>
      )}

      <TaskReplyComposer taskId={taskId} project={project} people={people} />
    </section>
  );
}

// Body rendering + per-row chrome used to live here. As of
// 2026-05-06 each row is rendered via `<TaskCommentRow>`, a client
// component that owns the inline-edit state so the textarea can take
// the body's slot rather than open as a separate floating drawer.
// Other comment surfaces (project discussion, /inbox, timeline) still
// use the EditDrawer pattern; migration is a follow-up.
