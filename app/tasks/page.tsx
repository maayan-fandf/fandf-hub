import Link from "next/link";
import {
  tasksList,
  tasksPeopleList,
  getMyProjects,
  currentUserEmail,
  type WorkTask,
  type WorkTaskStatus,
  type TasksPerson,
} from "@/lib/appsScript";
import TaskStatusCell from "@/components/TaskStatusCell";

export const dynamic = "force-dynamic";

type Search = {
  company?: string;
  project?: string;
  brief?: string;
  status?: string;
  priority?: string;
  department?: string;
  author?: string;
  approver?: string;
  project_manager?: string;
  assignee?: string;
  /** `mine=0` opts out of the default "author = me" filter (Data-Plus-
   *  style). When absent we treat it as `mine=1`. */
  mine?: string;
};

// Data Plus's four lifecycle buckets, same Hebrew labels. Verb form
// matters here: "בוצע" (passive past-masculine) — not "בוצעה" (feminine).
const STATUS_BUCKETS: { key: WorkTaskStatus; label: string; tone: string }[] = [
  { key: "in_progress", label: "בעבודה", tone: "in_progress" },
  { key: "awaiting_approval", label: "ממתין לאישור", tone: "awaiting_approval" },
  { key: "awaiting_clarification", label: "ממתין לבירור", tone: "awaiting_clarification" },
  { key: "done", label: "בוצע", tone: "done" },
];

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;

  const me = await currentUserEmail().catch(() => "");
  // Author filter defaults to the logged-in user unless explicitly opted
  // out via `?mine=0` or overridden with an explicit `?author=`. Matches
  // the Data Plus behaviour where the filter loads with your own name.
  const mineOptIn = sp.mine !== "0";
  const effectiveAuthor =
    sp.author !== undefined ? sp.author : mineOptIn ? me : "";

  const [tasksRes, projectsRes, peopleRes] = await Promise.all([
    tasksList({
      company: sp.company || "",
      project: sp.project || "",
      brief: sp.brief || "",
      status: (sp.status as WorkTaskStatus) || "",
      priority: sp.priority || "",
      department: sp.department || "",
      author: effectiveAuthor,
      approver: sp.approver || "",
      project_manager: sp.project_manager || "",
      assignee: sp.assignee || "",
    })
      .then((r) => ({ tasks: r.tasks ?? [], error: null as string | null }))
      .catch((e: unknown) => ({
        tasks: [] as WorkTask[],
        error: e instanceof Error ? e.message : String(e),
      })),
    getMyProjects().catch(() => null),
    tasksPeopleList().catch(() => null),
  ]);
  const { tasks, error } = tasksRes;

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
  const people = peopleRes?.people ?? [];

  // Bucketize + within each bucket group by company → project. The groups
  // are emitted as inline sub-heading rows so the visual shape stays a
  // single table (no nested tables) and column widths stay aligned.
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
            ניהול משימות — כל משימה מקבלת תיקייה ב־Drive תחת{" "}
            <code dir="ltr">חברה / פרויקט / משימה</code>, אירוע ביומן לכל
            מבצע, משימה ב־Google Tasks, ומייל לגורם המאשר.
            {mineOptIn && !sp.author && me && (
              <>
                {" "}
                · מציג רק משימות שיצרת ({me.split("@")[0]}) —{" "}
                <Link href={buildHref(sp, { mine: "0", author: "" })}>
                  הצג את כולם
                </Link>
              </>
            )}
            {!mineOptIn && (
              <>
                {" "}
                · מציג את כולם —{" "}
                <Link href={buildHref(sp, { mine: "1", author: "" })}>
                  חזרה לשלי
                </Link>
              </>
            )}
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
          priority: sp.priority || "",
          department: sp.department || "",
          author: sp.author ?? (mineOptIn ? me : ""),
          approver: sp.approver || "",
          project_manager: sp.project_manager || "",
          assignee: sp.assignee || "",
        }}
        companies={companyOptions}
        projects={projectOptions}
        departments={departmentOptions}
        people={people}
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
        const groups = groupByCompanyProject(list);
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
                    <th className="num">מספר המשימה</th>
                    <th>פרטי הפרוייקט</th>
                    <th>פרטי המשימה</th>
                    <th>כותב המשימה</th>
                    <th>מחלקות</th>
                    <th>עדיפות</th>
                    <th>תאריך מבוקש</th>
                    <th>נוצרה</th>
                    <th>סטטוס</th>
                    <th>עובדים במשימה</th>
                    <th>גורם מאשר</th>
                    <th className="icons">פעולות</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map(([company, projectGroups]) => (
                    <CompanyGroup
                      key={company || "(no-company)"}
                      company={company}
                      projectGroups={projectGroups}
                    />
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
                    <td>
                      {t.company ? `${t.company} / ` : ""}
                      {t.project}
                    </td>
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

// Group bucket's tasks by company → project, preserving newest-first
// order within each project group.
function groupByCompanyProject(
  tasks: WorkTask[],
): [string, [string, WorkTask[]][]][] {
  const byCompany = new Map<string, Map<string, WorkTask[]>>();
  for (const t of tasks) {
    const co = t.company || "";
    if (!byCompany.has(co)) byCompany.set(co, new Map());
    const byProj = byCompany.get(co)!;
    if (!byProj.has(t.project)) byProj.set(t.project, []);
    byProj.get(t.project)!.push(t);
  }
  const companies = Array.from(byCompany.keys()).sort((a, b) => {
    // Empty company sinks to the bottom so "(no-company)" doesn't lead.
    if (!a && b) return 1;
    if (a && !b) return -1;
    return a.localeCompare(b);
  });
  return companies.map((co) => {
    const projMap = byCompany.get(co)!;
    const projects = Array.from(projMap.keys()).sort();
    return [co, projects.map((p) => [p, projMap.get(p)!] as [string, WorkTask[]])];
  });
}

function CompanyGroup({
  company,
  projectGroups,
}: {
  company: string;
  projectGroups: [string, WorkTask[]][];
}) {
  // Base columns: # / project / details / author / depts / priority /
  // requested / created / status / workers / approver / actions. Bump
  // totalCols here if the header row changes.
  const totalCols = 12;
  return (
    <>
      <tr className="tasks-company-header">
        <td colSpan={totalCols}>
          <span className="tasks-company-header-label">חברה</span>{" "}
          <span className="tasks-company-header-name">
            {company || "(ללא חברה)"}
          </span>
        </td>
      </tr>
      {projectGroups.map(([project, rows]) => (
        <ProjectSubGroup
          key={project}
          project={project}
          rows={rows}
          totalCols={totalCols}
        />
      ))}
    </>
  );
}

function ProjectSubGroup({
  project,
  rows,
  totalCols,
}: {
  project: string;
  rows: WorkTask[];
  totalCols: number;
}) {
  return (
    <>
      <tr className="tasks-project-header">
        <td colSpan={totalCols}>
          <Link
            href={`/projects/${encodeURIComponent(project)}`}
            className="tasks-project-header-link"
          >
            {project}
          </Link>
          <span className="tasks-project-header-count">{rows.length}</span>
        </td>
      </tr>
      {rows.map((t) => (
        <TaskRow key={t.id} task={t} />
      ))}
    </>
  );
}

function TaskRow({ task }: { task: WorkTask }) {
  return (
    <tr>
      <td className="num">{task.brief || task.id.slice(-6)}</td>
      <td className="tasks-project-cell-nested">{task.project}</td>
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
      <td>{shortName(task.author_email) || "—"}</td>
      <td>
        {(task.departments || []).length
          ? (task.departments || []).join(", ")
          : "—"}
      </td>
      <td className="priority-cell">
        <span className={`tasks-priority-pill p${task.priority}`}>
          {task.priority || "—"}
        </span>
      </td>
      <td className="date-cell">{task.requested_date || "—"}</td>
      <td className="date-cell">{formatCreatedAt(task.created_at)}</td>
      <td>
        <TaskStatusCell task={task} />
      </td>
      <td>{(task.assignees || []).map(shortName).join(", ") || "—"}</td>
      <td>{shortName(task.approver_email) || "—"}</td>
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

// Date part of the ISO created_at — YYYY-MM-DD. Falls back to "—" for
// rows missing the field (happens on legacy rows pre-schema-v2).
function formatCreatedAt(iso: string): string {
  if (!iso) return "—";
  // Handle both ISO 8601 ("2026-04-24T09:53:11.456Z") and date-only
  // forms (some cells come back as Date → toISOString via the mapper).
  return iso.slice(0, 10);
}

// Build an href for /tasks with the current search params plus overrides.
// Empty-string overrides drop the key entirely (URL stays clean).
function buildHref(
  current: Record<string, string | undefined>,
  overrides: Record<string, string>,
): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) {
    if (v) merged[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === "") delete merged[k];
    else merged[k] = v;
  }
  const qs = new URLSearchParams(merged).toString();
  return qs ? `/tasks?${qs}` : "/tasks";
}

function TasksFilterBar({
  current,
  companies,
  projects,
  departments,
  people,
}: {
  current: {
    company: string;
    project: string;
    brief: string;
    status: string;
    priority: string;
    department: string;
    author: string;
    approver: string;
    project_manager: string;
    assignee: string;
  };
  companies: string[];
  projects: string[];
  departments: string[];
  people: TasksPerson[];
}) {
  const statuses = [
    { val: "", label: "כל הסטטוסים" },
    { val: "awaiting_approval", label: "ממתין לאישור" },
    { val: "awaiting_clarification", label: "ממתין לבירור" },
    { val: "in_progress", label: "בעבודה" },
    { val: "done", label: "בוצע" },
    { val: "cancelled", label: "בוטל" },
  ];
  const priorities = [
    { val: "", label: "כל" },
    { val: "1", label: "1 — גבוהה" },
    { val: "2", label: "2 — רגילה" },
    { val: "3", label: "3 — נמוכה" },
  ];
  return (
    <form method="GET" action="/tasks" className="tasks-filter-bar">
      {/* Keep the opt-out of author-defaulting sticky across submits. */}
      <input type="hidden" name="mine" value="0" />
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
        עדיפות
        <select name="priority" defaultValue={current.priority}>
          {priorities.map((p) => (
            <option key={p.val} value={p.val}>
              {p.label}
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
          list="tasks-people"
          placeholder={current.author || "name@domain"}
          defaultValue={current.author}
        />
      </label>
      <label>
        מאשר
        <input
          type="text"
          name="approver"
          list="tasks-people"
          placeholder="name@domain"
          defaultValue={current.approver}
        />
      </label>
      <label>
        מנהל פרויקט
        <input
          type="text"
          name="project_manager"
          list="tasks-people"
          placeholder="name@domain"
          defaultValue={current.project_manager}
        />
      </label>
      <label>
        עובד מבצע
        <input
          type="text"
          name="assignee"
          list="tasks-people"
          placeholder="name@domain"
          defaultValue={current.assignee}
        />
      </label>
      {/* Shared datalist populates all four people inputs above. */}
      <datalist id="tasks-people">
        {people.map((p) => (
          <option key={p.email} value={p.email}>
            {p.name} · {p.role}
          </option>
        ))}
      </datalist>
      <button type="submit" className="btn-primary">
        סנן
      </button>
      <Link href="/tasks" className="btn-ghost">
        נקה
      </Link>
    </form>
  );
}
