import Link from "next/link";
import {
  tasksList,
  getMyProjects,
  type WorkTask,
  type WorkTaskStatus,
} from "@/lib/appsScript";

export const dynamic = "force-dynamic";

type Search = {
  company?: string;
  project?: string;
  brief?: string;
  status?: string;
  department?: string;
  author?: string;
  project_manager?: string;
  assignee?: string;
};

// Data Plus's four lifecycle buckets, same Hebrew labels.
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

  // Load tasks + the project list in parallel. projectList feeds the
  // company/project dropdowns so they show *all* options the user has
  // access to, not just the ones already represented in the filtered
  // result set (which was the Phase 0 behaviour).
  const [tasksRes, projectsRes] = await Promise.all([
    tasksList({
      company: sp.company || "",
      project: sp.project || "",
      brief: sp.brief || "",
      status: (sp.status as WorkTaskStatus) || "",
      department: sp.department || "",
      author: sp.author || "",
      project_manager: sp.project_manager || "",
      assignee: sp.assignee || "",
    })
      .then((r) => ({ tasks: r.tasks ?? [], error: null as string | null }))
      .catch((e: unknown) => ({
        tasks: [] as WorkTask[],
        error: e instanceof Error ? e.message : String(e),
      })),
    getMyProjects().catch(() => null),
  ]);
  const { tasks, error } = tasksRes;

  // Company/project options from the Keys roster (all projects the user
  // can see), not just the ones in the current result set — so the
  // dropdowns stay usable after narrowing filters down to zero matches.
  const allProjects = projectsRes?.projects ?? [];
  const companyOptions = Array.from(
    new Set(allProjects.map((p) => p.company).filter(Boolean)),
  ).sort();
  const projectOptions = Array.from(
    new Set(
      (sp.company
        ? allProjects.filter((p) => p.company === sp.company)
        : allProjects
      ).map((p) => p.name),
    ),
  ).sort();
  const departmentOptions = ["מדיה", "קריאייטיב", "UI/UX", "תכנון", "אחר"];

  // Bucketize.
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
            ב־Drive תחת <code dir="ltr">חברה / פרויקט / משימה</code>, אירוע ביומן
            לכל מבצע, משימה ב־Google Tasks, ומייל לגורם המאשר.
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
          company: sp.company || "",
          project: sp.project || "",
          brief: sp.brief || "",
          status: sp.status || "",
          department: sp.department || "",
          author: sp.author || "",
          project_manager: sp.project_manager || "",
          assignee: sp.assignee || "",
        }}
        companies={companyOptions}
        projects={projectOptions}
        departments={departmentOptions}
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
                    <th className="num">בריף</th>
                    <th>חברה / פרויקט</th>
                    <th>פרטי המשימה</th>
                    <th>מחלקות</th>
                    <th>עדיפות / תאריך</th>
                    {b.key === "in_progress" && <th>סטטוס</th>}
                    <th>עובדים</th>
                    <th>מאשר</th>
                    <th>כותב</th>
                    <th className="icons">פעולות</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((t) => (
                    <TaskRow key={t.id} task={t} showSubStatus={b.key === "in_progress"} />
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
                  <th>כותב</th>
                </tr>
              </thead>
              <tbody>
                {other.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <span
                        className={`tasks-status-pill tasks-status-${t.status}`}
                      >
                        {t.status}
                      </span>
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

function TaskRow({
  task,
  showSubStatus,
}: {
  task: WorkTask;
  showSubStatus: boolean;
}) {
  return (
    <tr>
      <td className="num">{task.brief || task.id.slice(-6)}</td>
      <td>
        <div className="tasks-proj-cell">
          {task.company && (
            <span className="tasks-company">{task.company}</span>
          )}
          <Link
            href={`/projects/${encodeURIComponent(task.project)}`}
            className="tasks-project-link"
          >
            {task.project}
          </Link>
        </div>
      </td>
      <td className="title-cell">
        <Link
          href={`/tasks/${encodeURIComponent(task.id)}`}
          className="tasks-title-link"
        >
          {task.title}
        </Link>
        {task.round_number > 1 && (
          <span className="tasks-round-chip" title="סבב תיקונים">
            סבב #{task.round_number}
          </span>
        )}
        {task.description && (
          <div className="tasks-desc-preview">
            {task.description.slice(0, 90)}
            {task.description.length > 90 ? "…" : ""}
          </div>
        )}
      </td>
      <td>
        {(task.departments || []).length
          ? (task.departments || []).join(", ")
          : "—"}
      </td>
      <td className="date-cell">
        <span className={`tasks-priority-pill p${task.priority}`}>
          {task.priority || "—"}
        </span>{" "}
        {task.requested_date || "—"}
      </td>
      {showSubStatus && (
        <td>
          {task.sub_status ? (
            <span className="tasks-substatus-pill">{task.sub_status}</span>
          ) : (
            "—"
          )}
        </td>
      )}
      <td>{(task.assignees || []).map(shortName).join(", ") || "—"}</td>
      <td>{shortName(task.approver_email) || "—"}</td>
      <td>{shortName(task.author_email) || "—"}</td>
      <td className="icons">
        <div className="tasks-row-icons">
          <Link
            href={`/tasks/${encodeURIComponent(task.id)}`}
            className="tasks-row-icon"
            title="פתח משימה"
          >
            ▶
          </Link>
          {task.drive_folder_url && (
            <a
              href={task.drive_folder_url}
              target="_blank"
              rel="noreferrer"
              className="tasks-row-icon"
              title="תיקיית קבצים ב־Drive"
            >
              📁
            </a>
          )}
          <Link
            href={`/tasks/${encodeURIComponent(task.id)}#history`}
            className="tasks-row-icon"
            title="היסטוריה + הערות"
          >
            💬
          </Link>
        </div>
      </td>
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
  companies,
  projects,
  departments,
}: {
  current: {
    company: string;
    project: string;
    brief: string;
    status: string;
    department: string;
    author: string;
    project_manager: string;
    assignee: string;
  };
  companies: string[];
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
        בריף
        <input
          type="text"
          name="brief"
          placeholder="#"
          defaultValue={current.brief}
          style={{ width: "5em" }}
        />
      </label>
      <label>
        חברה
        <select name="company" defaultValue={current.company}>
          <option value="">הכל</option>
          {companies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
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
        כותב
        <input
          type="text"
          name="author"
          placeholder="name@domain"
          defaultValue={current.author}
        />
      </label>
      <label>
        מנהל פרויקט
        <input
          type="text"
          name="project_manager"
          placeholder="name@domain"
          defaultValue={current.project_manager}
        />
      </label>
      <label>
        עובד מבצע
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
