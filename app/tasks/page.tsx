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
import TasksQueue from "@/components/TasksQueue";

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

      {!error && (
        <TasksQueue tasks={tasks} groupByCompany={true} people={people} />
      )}
    </main>
  );
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
    { val: "awaiting_handling", label: "ממתין לטיפול" },
    { val: "in_progress", label: "בעבודה" },
    { val: "awaiting_clarification", label: "ממתין לבירור" },
    { val: "awaiting_approval", label: "ממתין לאישור" },
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
