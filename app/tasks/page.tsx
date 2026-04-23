import Link from "next/link";
import {
  tasksList,
  type WorkTask,
  type WorkTaskStatus,
} from "@/lib/appsScript";

export const dynamic = "force-dynamic";

type Search = {
  project?: string;
  status?: string;
  department?: string;
  assignee?: string;
};

// Data Plus's four lifecycle buckets, same Hebrew labels the team already
// uses. `awaiting_clarification` maps to "ממתין לבירור" — the clarification
// loop before a task can move into "בעבודה".
const STATUS_BUCKETS: { key: WorkTaskStatus; label: string; tone: string }[] = [
  { key: "in_progress", label: "בעבודה", tone: "in_progress" },
  { key: "awaiting_approval", label: "ממתין לאישור", tone: "awaiting_approval" },
  { key: "awaiting_clarification", label: "ממתין לבירור", tone: "awaiting_clarification" },
  { key: "done", label: "בוצעה", tone: "done" },
];

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;

  const { tasks, error } = await tasksList({
    project: sp.project || "",
    status: (sp.status as WorkTaskStatus) || "",
    department: sp.department || "",
    assignee: sp.assignee || "",
  })
    .then((r) => ({ tasks: r.tasks ?? [], error: null as string | null }))
    .catch((e: unknown) => ({
      tasks: [] as WorkTask[],
      error: e instanceof Error ? e.message : String(e),
    }));

  // Distinct projects + departments from the current result set for the
  // filter dropdowns. Stable-sorted.
  const projects = Array.from(new Set(tasks.map((t) => t.project))).sort();
  const departments = Array.from(
    new Set(tasks.map((t) => t.department).filter(Boolean)),
  ).sort();

  // Group by bucket for rendering; any status that doesn't match a bucket
  // (e.g. `draft`, `cancelled`) falls into a separate tail bucket we hide
  // by default. Keeps the top-level queue focused.
  const byStatus: Record<string, WorkTask[]> = {};
  for (const b of STATUS_BUCKETS) byStatus[b.key] = [];
  const other: WorkTask[] = [];
  for (const t of tasks) {
    if (byStatus[t.status]) byStatus[t.status].push(t);
    else other.push(t);
  }

  return (
    <main className="container">
      <header className="page-header">
        <div>
          <h1>
            <span className="emoji" aria-hidden>
              📋
            </span>
            משימות
          </h1>
          <div className="subtitle">
            ניהול משימות — יצירה, אישור, ובקרת סטטוס. כל משימה מקבלת תיקייה
            ב־Drive, אירוע ביומן של המבצע, משימה ב־Google Tasks, ומייל לאישור.
          </div>
        </div>
        <div className="page-header-actions">
          <Link href="/tasks/new" className="btn-primary">
            + משימה חדשה
          </Link>
        </div>
      </header>

      <TasksFilterBar
        current={{
          project: sp.project || "",
          status: sp.status || "",
          department: sp.department || "",
          assignee: sp.assignee || "",
        }}
        projects={projects}
        departments={departments}
      />

      {error && (
        <div className="error">
          <strong>שגיאה בטעינת המשימות.</strong>
          <br />
          {error}
        </div>
      )}

      {!error && tasks.length === 0 && (
        <div className="empty">
          <span className="emoji" aria-hidden>
            🌿
          </span>
          אין משימות תואמות לסינון.
        </div>
      )}

      {STATUS_BUCKETS.map((b) => {
        const list = byStatus[b.key] || [];
        if (!list.length) return null;
        return (
          <section key={b.key} className={`tasks-bucket tasks-bucket-${b.tone}`}>
            <h2 className="tasks-bucket-head">
              {b.label}
              <span className="tasks-bucket-count">{list.length}</span>
            </h2>
            <div className="tasks-table-wrap">
              <table className="tasks-table">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>פרויקט</th>
                    <th>כותרת</th>
                    <th>מחלקה</th>
                    <th>עדיפות</th>
                    <th>תאריך מבוקש</th>
                    <th>עובדים במשימה</th>
                    <th>גורם מאשר</th>
                    <th>כותב המשימה</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((t) => (
                    <TaskRow key={t.id} task={t} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {other.length > 0 && (
        <details className="tasks-other">
          <summary>
            {other.length} משימות במצבים אחרים (טיוטה / בוטל) — לחץ להצגה
          </summary>
          <div className="tasks-table-wrap">
            <table className="tasks-table">
              <thead>
                <tr>
                  <th>סטטוס</th>
                  <th>פרויקט</th>
                  <th>כותרת</th>
                  <th>תאריך מבוקש</th>
                  <th>כותב המשימה</th>
                </tr>
              </thead>
              <tbody>
                {other.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <span className="tasks-status-pill">{t.status}</span>
                    </td>
                    <td>{t.project}</td>
                    <td>
                      <Link href={`/tasks/${encodeURIComponent(t.id)}`}>
                        {t.title}
                      </Link>
                    </td>
                    <td>{t.requested_date || "—"}</td>
                    <td>{shortName(t.author_email)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </main>
  );
}

function TaskRow({ task }: { task: WorkTask }) {
  return (
    <tr>
      <td className="num">{task.id.slice(-6)}</td>
      <td>
        <Link href={`/projects/${encodeURIComponent(task.project)}`}>
          {task.project}
        </Link>
      </td>
      <td className="title-cell">
        <Link
          href={`/tasks/${encodeURIComponent(task.id)}`}
          className="tasks-title-link"
        >
          {task.title}
        </Link>
        {task.description && (
          <div className="tasks-desc-preview">
            {task.description.slice(0, 90)}
            {task.description.length > 90 ? "…" : ""}
          </div>
        )}
      </td>
      <td>{task.department || "—"}</td>
      <td>
        <span className={`tasks-priority-pill p${task.priority}`}>
          {task.priority || "—"}
        </span>
      </td>
      <td className="date-cell">{task.requested_date || "—"}</td>
      <td>{(task.assignees || []).map(shortName).join(", ") || "—"}</td>
      <td>{shortName(task.approver_email) || "—"}</td>
      <td>{shortName(task.author_email) || "—"}</td>
    </tr>
  );
}

function shortName(email: string): string {
  if (!email) return "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

function TasksFilterBar({
  current,
  projects,
  departments,
}: {
  current: { project: string; status: string; department: string; assignee: string };
  projects: string[];
  departments: string[];
}) {
  const statuses = [
    { val: "", label: "כל הסטטוסים" },
    { val: "awaiting_approval", label: "ממתין לאישור" },
    { val: "awaiting_clarification", label: "ממתין לבירור" },
    { val: "in_progress", label: "בעבודה" },
    { val: "done", label: "בוצעה" },
    { val: "cancelled", label: "בוטל" },
  ];
  return (
    <form method="GET" action="/tasks" className="tasks-filter-bar">
      <label>
        פרויקט
        <select name="project" defaultValue={current.project}>
          <option value="">הכל</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label>
        סטטוס
        <select name="status" defaultValue={current.status}>
          {statuses.map((s) => (
            <option key={s.val} value={s.val}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        מחלקה
        <select name="department" defaultValue={current.department}>
          <option value="">הכל</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label>
        מבצע
        <input
          type="text"
          name="assignee"
          placeholder="name@domain"
          defaultValue={current.assignee}
        />
      </label>
      <button type="submit" className="btn-primary">
        סנן
      </button>
      <Link href="/tasks" className="btn-ghost">
        נקה
      </Link>
    </form>
  );
}
