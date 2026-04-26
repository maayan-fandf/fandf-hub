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
import { getUserRole, type UserRole } from "@/lib/userRole";
import { getUserPrefs } from "@/lib/userPrefs";
import { getSharedDriveName } from "@/lib/driveFolders";
import TasksQueue from "@/components/TasksQueue";
import TasksKanban from "@/components/TasksKanban";
import TasksViewToggle from "@/components/TasksViewToggle";

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
  campaign?: string;
  requested_date_from?: string;
  requested_date_to?: string;
  /** `mine=0` opts out of the default "author = me" filter (Data-Plus-
   *  style). When absent we treat it as `mine=1`. */
  mine?: string;
  /** `view=kanban` switches to the drag-and-drop board; default is the
   *  Data-Plus-style table queue. */
  view?: string;
};


export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;

  const me = await currentUserEmail().catch(() => "");
  // "View as" support — when the user has set view_as_email in their
  // prefs (gear menu in the topnav), every default filter on this
  // page is computed against that identity instead of the session
  // user. Use case: a manager reviewing an employee's queue, or a
  // task manager covering for a peer. Data access is unaffected;
  // this only flips the default filter values.
  const prefs = me ? await getUserPrefs(me).catch(() => null) : null;
  const viewAs = prefs?.view_as_email || "";
  const effectiveMe = viewAs || me;
  const isViewingAs = !!viewAs && viewAs !== me;

  // Role-aware default filter: each role has a different "what
  // matters to me right now" axis. Admins see what they authored
  // (Data Plus default — admins typically brief tasks in). Managers
  // see tasks waiting their approval. Creatives see tasks assigned
  // to them. Clients fall back to the no-default behavior since
  // they're already access-gated to their projects.
  // `?mine=0` opts out of all role defaults (the "show all" path).
  const role: UserRole = effectiveMe ? await getUserRole(effectiveMe).catch(() => "unknown") : "unknown";
  const mineOptIn = sp.mine !== "0";

  const effectiveAuthor =
    sp.author !== undefined
      ? sp.author
      : mineOptIn && (role === "admin" || role === "unknown")
        ? effectiveMe
        : "";
  const effectiveApprover =
    sp.approver !== undefined
      ? sp.approver
      : mineOptIn && role === "manager"
        ? effectiveMe
        : "";
  const effectiveAssignee =
    sp.assignee !== undefined
      ? sp.assignee
      : mineOptIn && role === "creative"
        ? effectiveMe
        : "";

  const [tasksRes, projectsRes, peopleRes, driveName] = await Promise.all([
    tasksList({
      company: sp.company || "",
      project: sp.project || "",
      brief: sp.brief || "",
      status: (sp.status as WorkTaskStatus) || "",
      priority: sp.priority || "",
      department: sp.department || "",
      author: effectiveAuthor,
      approver: effectiveApprover,
      project_manager: sp.project_manager || "",
      assignee: effectiveAssignee,
      campaign: sp.campaign || "",
      requested_date_from: sp.requested_date_from || "",
      requested_date_to: sp.requested_date_to || "",
    })
      .then((r) => ({ tasks: r.tasks ?? [], error: null as string | null }))
      .catch((e: unknown) => ({
        tasks: [] as WorkTask[],
        error: e instanceof Error ? e.message : String(e),
      })),
    getMyProjects().catch(() => null),
    tasksPeopleList().catch(() => null),
    me ? getSharedDriveName(me).catch(() => "") : Promise.resolve(""),
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
  const view: "kanban" | "table" = sp.view === "kanban" ? "kanban" : "table";

  return (
    <main className="container">
      <header className="page-header tasks-page-header">
        <div className="tasks-page-header-main">
          <div className="tasks-page-header-titlerow">
            <h1>
              <span className="emoji" aria-hidden>
                📋
              </span>
              משימות
            </h1>
            <TasksViewToggle current={view} searchParams={sp} />
          </div>
          <div className="subtitle">
            ניהול משימות — כל משימה מקבלת תיקייה ב־Drive, משימה
            ב־Google Tasks לכל מבצע (מסומנת כהושלמה אוטומטית כשהמשימה
            עוברת ל&quot;בוצע&quot;), ומייל לגורם המאשר.
            {mineOptIn && effectiveMe && (
              <RoleDefaultHint
                role={role}
                me={effectiveMe}
                isViewingAs={isViewingAs}
                hasExplicitAuthor={sp.author !== undefined}
                hasExplicitApprover={sp.approver !== undefined}
                hasExplicitAssignee={sp.assignee !== undefined}
                showAllHref={buildHref(sp, {
                  mine: "0",
                  author: "",
                  approver: "",
                  assignee: "",
                })}
              />
            )}
            {!mineOptIn && (
              <>
                {" "}
                · מציג את כולם —{" "}
                <Link
                  href={buildHref(sp, {
                    mine: "1",
                    author: "",
                    approver: "",
                    assignee: "",
                  })}
                >
                  חזרה לברירת מחדל
                </Link>
              </>
            )}
          </div>
        </div>
        <div className="header-actions">
          <Link href="/tasks/new" className="btn-primary btn-sm">
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
          author: effectiveAuthor,
          approver: effectiveApprover,
          project_manager: sp.project_manager || "",
          assignee: effectiveAssignee,
          campaign: sp.campaign || "",
          requested_date_from: sp.requested_date_from || "",
          requested_date_to: sp.requested_date_to || "",
        }}
        companies={companyOptions}
        projects={projectOptions}
        departments={departmentOptions}
        people={people}
        campaignOptions={Array.from(
          new Set(tasks.map((t) => (t.campaign || "").trim()).filter(Boolean)),
        ).sort()}
      />

      {error && (
        <div className="error">
          <strong>שגיאה בטעינת המשימות.</strong>
          <br />
          {error}
        </div>
      )}

      {!error && view === "kanban" && (
        <TasksKanban tasks={tasks} people={people} />
      )}

      {!error && view === "table" && (
        <TasksQueue
          tasks={tasks}
          groupByCompany={true}
          people={people}
          driveName={driveName}
        />
      )}
    </main>
  );
}


/**
 * Renders the "מציג רק…" subtitle line + the "show all" opt-out, with
 * copy tailored to the user's role. Shown when the page is in its
 * default (`mine=1`) state and a role-default actually applies.
 */
function RoleDefaultHint({
  role,
  me,
  isViewingAs,
  hasExplicitAuthor,
  hasExplicitApprover,
  hasExplicitAssignee,
  showAllHref,
}: {
  role: UserRole;
  me: string;
  isViewingAs: boolean;
  hasExplicitAuthor: boolean;
  hasExplicitApprover: boolean;
  hasExplicitAssignee: boolean;
  showAllHref: string;
}) {
  const handle = me.split("@")[0];
  let text = "";
  if (role === "manager" && !hasExplicitApprover) {
    text = isViewingAs
      ? `מציג משימות שמחכות לאישור של ${handle}`
      : `מציג משימות שמחכות לאישורך (${handle})`;
  } else if (role === "creative" && !hasExplicitAssignee) {
    text = isViewingAs
      ? `מציג משימות שמשובצות אצל ${handle}`
      : `מציג משימות שמשובצות אצלך (${handle})`;
  } else if ((role === "admin" || role === "unknown") && !hasExplicitAuthor) {
    text = isViewingAs
      ? `מציג משימות ש-${handle} יצר/ה`
      : `מציג משימות שיצרת (${handle})`;
  }
  if (!text) return null;
  return (
    <>
      {" "}
      · {text} —{" "}
      <Link href={showAllHref}>הצג את כולם</Link>
    </>
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
  campaignOptions,
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
    campaign: string;
    requested_date_from: string;
    requested_date_to: string;
  };
  companies: string[];
  projects: string[];
  departments: string[];
  people: TasksPerson[];
  campaignOptions: string[];
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
      {/* Filter order mirrors the table columns below: חברה → פרויקט →
          קמפיין → כותב → מחלקה → דחיפות → סטטוס → עובד מבצע → מאשר →
          מנהל פרויקט. תאריך / נוצרה are display-only (no filter). */}
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
        קמפיין
        <input
          type="text"
          name="campaign"
          list="tasks-campaigns-filter"
          placeholder="הכל"
          defaultValue={current.campaign}
        />
      </label>
      <datalist id="tasks-campaigns-filter">
        {campaignOptions.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
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
        דחיפות
        <select name="priority" defaultValue={current.priority}>
          {priorities.map((p) => (
            <option key={p.val} value={p.val}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="filter-date-range">
        תאריך מבוקש
        <div className="date-range-inputs">
          <input
            type="date"
            name="requested_date_from"
            defaultValue={current.requested_date_from}
            aria-label="מ"
          />
          <span className="date-range-sep">—</span>
          <input
            type="date"
            name="requested_date_to"
            defaultValue={current.requested_date_to}
            aria-label="עד"
          />
        </div>
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
        עובד מבצע
        <input
          type="text"
          name="assignee"
          list="tasks-people"
          placeholder="name@domain"
          defaultValue={current.assignee}
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
      {/* Shared datalist populates all four people inputs above. */}
      <datalist id="tasks-people">
        {people.map((p) => (
          <option key={p.email} value={p.email}>
            {p.name} · {p.role}
          </option>
        ))}
      </datalist>
      <div className="tasks-filter-actions">
        <button type="submit" className="btn-primary">
          סנן
        </button>
        <Link href="/tasks" className="btn-ghost">
          נקה
        </Link>
      </div>
    </form>
  );
}
