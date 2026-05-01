import Link from "next/link";
import { redirect } from "next/navigation";
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
import { getEffectiveViewAs } from "@/lib/viewAsCookie";
import { getSharedDriveName } from "@/lib/driveFolders";
import TasksQueue, {
  type TasksSortKey,
  type TasksSortOrder,
} from "@/components/TasksQueue";
import TasksKanban from "@/components/TasksKanban";
import TasksCalendar from "@/components/TasksCalendar";
import TasksViewToggle from "@/components/TasksViewToggle";
import TasksArchiveToggle from "@/components/TasksArchiveToggle";
import TasksFilterCompanyProject from "@/components/TasksFilterCompanyProject";
import DateRangePicker from "@/components/DateRangePicker";

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
  /** Picks anyone "involved" — author OR approver OR PM OR
   *  assignee OR mentioned in the task's discussion. Replaces the
   *  old project-manager-only filter from the UI; the underlying
   *  project_manager param still works for legacy URLs. */
  involved_with?: string;
  campaign?: string;
  requested_date_from?: string;
  requested_date_to?: string;
  /** `mine=0` opts out of the default "author = me" filter (Data-Plus-
   *  style). When absent we treat it as `mine=1`. */
  mine?: string;
  /** `view=kanban` switches to the drag-and-drop board, `view=calendar`
   *  to the month-grid; default is the Data-Plus-style table queue. */
  view?: string;
  /** Calendar month — YYYY-MM. Honored only when view=calendar.
   *  Default is the current month. */
  month?: string;
  /** Sort axis applied within each status bucket on the table view.
   *  Defaults to `rank` (drag-driven manual order). Other values:
   *  title | priority | requested_date | created_at | updated_at. */
  sort?: string;
  /** asc | desc — column-specific default if absent. */
  order?: string;
};


export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;

  const me = await currentUserEmail().catch(() => "");
  // Clients have no business on /tasks — bounce them to the home grid.
  // Mirrors the layout's nav-link gating + the project page's section
  // gating so there's no surface a client can land on accidentally.
  if (me) {
    try {
      const access = await getMyProjects();
      const isClientUser =
        !!access.isClient &&
        !access.isAdmin &&
        !access.isStaff &&
        !access.isInternal;
      if (isClientUser) redirect("/");
    } catch {
      /* fail-open: if access lookup fails, fall through to the page;
         tasksList itself enforces project-level access too. */
    }
  }
  // "View as" support — when the user has set view_as_email in their
  // prefs (gear menu in the topnav), every default filter on this
  // page is computed against that identity instead of the session
  // user. Use case: a manager reviewing an employee's queue, or a
  // task manager covering for a peer. Data access is unaffected;
  // this only flips the default filter values.
  const prefs = me ? await getUserPrefs(me).catch(() => null) : null;
  const viewAs = me ? await getEffectiveViewAs(me).catch(() => "") : "";
  const effectiveMe = viewAs || me;
  const isViewingAs = !!viewAs && viewAs !== me;

  // Role-aware default filter. Two flavors:
  //   - Creative role → assignee=me (focused: a creative cares about
  //     what's on their plate, full stop).
  //   - Everyone else (manager / admin / unknown) → relevant_to_me=me,
  //     an OR-filter across author/approver/assignee. So a manager who
  //     authors briefs AND occasionally gets tasks assigned sees both
  //     in their default view, instead of having to flip filters.
  //   - Clients have no default (already access-gated to their projects).
  // `?mine=0` opts out of all defaults (the "show all" path).
  const role: UserRole = effectiveMe ? await getUserRole(effectiveMe).catch(() => "unknown") : "unknown";
  const mineOptIn = sp.mine !== "0";
  const userSetExplicitMineFilter =
    sp.author !== undefined ||
    sp.approver !== undefined ||
    sp.assignee !== undefined;

  const effectiveAuthor = sp.author !== undefined ? sp.author : "";
  const effectiveApprover = sp.approver !== undefined ? sp.approver : "";
  const effectiveAssignee =
    sp.assignee !== undefined
      ? sp.assignee
      : mineOptIn && role === "creative"
        ? effectiveMe
        : "";
  const relevantToMe =
    !userSetExplicitMineFilter &&
    mineOptIn &&
    effectiveMe &&
    (role === "manager" || role === "admin" || role === "unknown")
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
      relevant_to_me: relevantToMe,
      involved_with: sp.involved_with || "",
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
  // Full deduped sorted project list — used by the filter UI as the
  // "no-company-selected" pool. Live-narrowing on the client uses the
  // companyToProjects map below so users don't wait for a server hop.
  const allProjectNames = Array.from(
    new Set(allProjects.map((p) => p.name)),
  ).sort();
  const companyToProjects = (() => {
    const m: Record<string, string[]> = {};
    for (const p of allProjects) {
      const c = p.company || "";
      if (!c) continue;
      if (!m[c]) m[c] = [];
      m[c].push(p.name);
    }
    for (const k of Object.keys(m)) {
      m[k] = Array.from(new Set(m[k])).sort();
    }
    return m;
  })();
  const people = peopleRes?.people ?? [];
  // Departments derived from the live `Role` column on names-to-emails
  // (same source TaskCreateForm uses). Falls back to the legacy hardcoded
  // list when no roles are populated, so the dropdown never empties — and
  // the filter bar's options stay in sync with what the create-task form
  // actually offers.
  const DEPARTMENTS_FALLBACK = ["מדיה", "קריאייטיב", "UI/UX", "תכנון", "אחר"];
  const departmentSet = new Set<string>();
  for (const p of people) {
    const r = (p.role || "").trim();
    if (r) departmentSet.add(r);
  }
  const departmentOptions =
    departmentSet.size === 0
      ? DEPARTMENTS_FALLBACK
      : Array.from(departmentSet).sort((a, b) => a.localeCompare(b, "he"));
  const view: "kanban" | "table" | "calendar" =
    sp.view === "kanban"
      ? "kanban"
      : sp.view === "calendar"
        ? "calendar"
        : "table";

  // Sort fallback chain — explicit URL param > persisted user pref >
  // hard default ("rank" / column-natural direction). Reading from
  // prefs lets the table remember "I sorted by עדיפות yesterday"
  // without forcing a query string everywhere.
  const persistedSort = parseSort(prefs?.tasks_sort);
  const persistedOrder = parseOrder(prefs?.tasks_sort_order);
  const effectiveSort: TasksSortKey = sp.sort
    ? parseSort(sp.sort)
    : persistedSort;
  const effectiveSortOrder: TasksSortOrder | undefined = sp.order
    ? parseOrder(sp.order)
    : persistedOrder;

  // Archive declutter — gear-menu pref hides done/cancelled by
  // default. A status-explicit URL (?status=done|cancelled) is an
  // override; the user opted into seeing those, don't hide them
  // out from under them. Mass-hide also yields automatically when
  // we know the user is filtering for terminal states via other
  // flow controls in the future.
  const userPrefHideArchived = prefs?.hide_archived !== false;
  const statusOverride =
    sp.status === "done" || sp.status === "cancelled";
  const hideArchived = userPrefHideArchived && !statusOverride;
  const archiveAfterDays = (() => {
    const n = parseInt(prefs?.archive_after_days || "14", 10);
    return Number.isFinite(n) ? Math.max(1, Math.min(365, n)) : 14;
  })();
  // Archive count for the header pill — done/cancelled tasks older
  // than the cutoff. Computed against the same `tasks` list the
  // views render, so the badge always matches what the toggle would
  // unhide. Falls back to total terminal-state count if a task
  // somehow has no updated_at.
  const archiveCutoffMs =
    Date.now() - archiveAfterDays * 24 * 60 * 60 * 1000;
  const archivedCount = tasks.reduce((n, t) => {
    if (t.status !== "done" && t.status !== "cancelled") return n;
    const stamp = t.updated_at || t.created_at;
    const ms = stamp ? new Date(stamp).getTime() : NaN;
    if (!Number.isFinite(ms) || ms < archiveCutoffMs) return n + 1;
    return n;
  }, 0);

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
            <TasksArchiveToggle
              hidden={userPrefHideArchived}
              count={archivedCount}
              overridden={statusOverride}
            />
          </div>
          <div className="subtitle">
            ניהול משימות — כל משימה מקבלת תיקייה ב־Drive, משימה
            ב־Google Tasks לכל מבצע (מסומנת כהושלמה אוטומטית כשהמשימה
            עוברת ל&quot;בוצע&quot;), ומייל לגורם המאשר.
            {isViewingAs && (
              <>
                {" "}· 👁️ <b>מציג כ-<span dir="ltr">{viewAs}</span></b>
                {" "}(שינוי בגלגל ההגדרות)
              </>
            )}
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
          involved_with: sp.involved_with || "",
          campaign: sp.campaign || "",
          requested_date_from: sp.requested_date_from || "",
          requested_date_to: sp.requested_date_to || "",
        }}
        // Presentational params that aren't filter inputs but need to
        // ride through a form submission so submitting the filter
        // doesn't bounce the user out of kanban / sort / "show all"
        // back to the defaults.
        passthrough={{
          view: sp.view || "",
          sort: sp.sort || "",
          order: sp.order || "",
          mine: sp.mine || "",
          month: sp.month || "",
        }}
        companies={companyOptions}
        allProjectNames={allProjectNames}
        companyToProjects={companyToProjects}
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
        <TasksKanban
          tasks={tasks}
          people={people}
          hideArchived={hideArchived}
        />
      )}

      {!error && view === "table" && (
        <TasksQueue
          tasks={tasks}
          groupByCompany={true}
          people={people}
          driveName={driveName}
          userEmail={me}
          companyToProjects={companyToProjects}
          sort={effectiveSort}
          sortOrder={effectiveSortOrder}
          searchParams={sp as Record<string, string | undefined>}
          hideArchived={hideArchived}
          archiveAfterDays={archiveAfterDays}
        />
      )}

      {!error && view === "calendar" && (
        <TasksCalendar
          tasks={tasks}
          initialMonth={sp.month}
          searchParams={sp as Record<string, string | undefined>}
          hideArchived={hideArchived}
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
  const hasExplicit =
    hasExplicitAuthor || hasExplicitApprover || hasExplicitAssignee;
  if (hasExplicit) return null;
  let text = "";
  if (role === "creative") {
    text = isViewingAs
      ? `מציג משימות שמשובצות אצל ${handle}`
      : `מציג משימות שמשובצות אצלך (${handle})`;
  } else if (role === "manager" || role === "admin" || role === "unknown") {
    // OR-default: tasks where the user is author OR approver OR
    // assignee. Hint copy is role-agnostic since the filter is.
    text = isViewingAs
      ? `מציג משימות הקשורות ל-${handle} (יוצר/ת, מאשר/ת או מבצע/ת)`
      : `מציג משימות הקשורות אליך (${handle})`;
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

// Whitelisted sort axes; anything else falls back to "rank" so a
// hand-rolled URL can't crash the renderer.
function parseSort(raw: string | undefined): TasksSortKey {
  switch (raw) {
    case "title":
    case "priority":
    case "requested_date":
    case "created_at":
    case "updated_at":
      return raw;
    default:
      return "rank";
  }
}

function parseOrder(raw: string | undefined): TasksSortOrder | undefined {
  if (raw === "asc" || raw === "desc") return raw;
  return undefined;
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
  passthrough,
  companies,
  allProjectNames,
  companyToProjects,
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
    involved_with: string;
    campaign: string;
    requested_date_from: string;
    requested_date_to: string;
  };
  /** Presentational URL params (view / sort / order / mine / month)
   *  that the form submission must preserve. The previous form was
   *  submitting to /tasks with only the visible filter fields, which
   *  silently dropped ?view=kanban / ?sort / etc. — every filter
   *  edit bounced the user back to the default table view. */
  passthrough: {
    view: string;
    sort: string;
    order: string;
    mine: string;
    month: string;
  };
  companies: string[];
  /** All project names (deduped, sorted) — used as the project-list
   *  fallback when no company is selected. Client component narrows
   *  this to the selected company via companyToProjects below. */
  allProjectNames: string[];
  /** company name → its project names (sorted, deduped). Drives the
   *  live narrowing in TasksFilterCompanyProject without requiring a
   *  form submit between picking a company and picking a project. */
  companyToProjects: Record<string, string[]>;
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
  // Count active filters for the mobile-disclosure summary badge.
  // Excludes purely-presentational params (view, sort, order, mine).
  const activeFilterCount = Object.entries(current).reduce(
    (n, [, v]) => (v ? n + 1 : n),
    0,
  );
  return (
    // <details> gives us a CSS-only collapse on mobile — the form is
    // hidden behind the summary on narrow viewports. We always set
    // `open` so the form is visible by default; on desktop the
    // summary is `display: none`, so the user can't accidentally
    // collapse it. On mobile, clicking the summary toggles. The
    // previous "open only when filters active" logic was a bug — it
    // hid the form on desktop too whenever no filters were set.
    <details className="tasks-filter-disclosure" open>
      <summary className="tasks-filter-summary">
        <span>🔍 סינון</span>
        {activeFilterCount > 0 && (
          <span
            className="tasks-filter-summary-badge"
            aria-label={`${activeFilterCount} מסננים פעילים`}
          >
            {activeFilterCount}
          </span>
        )}
      </summary>
      <form method="GET" action="/tasks" className="tasks-filter-bar">
      {/* Hidden passthrough inputs — preserve view / sort / order /
          mine / month across filter submissions. Without these, every
          filter edit drops the user back to /tasks (table view, role
          default), which was misread as "kanban is broken". Empty
          values are still emitted as empty inputs so the URL stays
          predictable; the server treats "" the same as absent. */}
      {passthrough.view && (
        <input type="hidden" name="view" value={passthrough.view} />
      )}
      {passthrough.sort && (
        <input type="hidden" name="sort" value={passthrough.sort} />
      )}
      {passthrough.order && (
        <input type="hidden" name="order" value={passthrough.order} />
      )}
      {passthrough.mine && (
        <input type="hidden" name="mine" value={passthrough.mine} />
      )}
      {passthrough.month && (
        <input type="hidden" name="month" value={passthrough.month} />
      )}
      {/* Field order: project/categorization first, then people in a
          visually-grouped <fieldset>. The four people-related axes
          (כותב / עובד מבצע / מאשר / מעורב במשימה) live together so
          users scanning for "who" don't have to chase them across
          rows. The previous "מנהל פרויקט" filter is replaced by the
          broader "מעורב במשימה" — same input shape, same datalist,
          but the server-side OR matches author OR approver OR PM
          OR assignee OR mentioned-in-discussion. The
          project_manager URL param still works for legacy links;
          new UI just doesn't surface it. */}
      {/* `data-active="1"` on any field whose current value is non-empty —
          CSS uses it to tint the field with --accent-soft so users can
          scan at a glance which filters are narrowing the result set
          (otherwise it's easy to miss e.g. a stuck חברה filter). */}
      <TasksFilterCompanyProject
        defaultCompany={current.company}
        defaultProject={current.project}
        companies={companies}
        allProjects={allProjectNames}
        companyToProjects={companyToProjects}
      />
      <label>
        קמפיין
        <select
          name="campaign"
          defaultValue={current.campaign}
          data-active={current.campaign ? "1" : undefined}
          disabled={campaignOptions.length === 0 && !current.campaign}
          aria-disabled={campaignOptions.length === 0 && !current.campaign}
        >
          <option value="">
            {campaignOptions.length === 0 && !current.campaign
              ? "אין קמפיינים זמינים"
              : "הכל"}
          </option>
          {/* If the user has filtered to a campaign that no longer
              shows up in the loaded set (e.g. all tasks for it are
              archived), surface it anyway so they can deselect. */}
          {current.campaign && !campaignOptions.includes(current.campaign) && (
            <option value={current.campaign}>{current.campaign}</option>
          )}
          {campaignOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label>
        מחלקה
        <select
          name="department"
          defaultValue={current.department}
          data-active={current.department ? "1" : undefined}
        >
          <option value="">הכל</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label>
        סטטוס
        <select
          name="status"
          defaultValue={current.status}
          data-active={current.status ? "1" : undefined}
        >
          {statuses.map((s) => (
            <option key={s.val} value={s.val}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        דחיפות
        <select
          name="priority"
          defaultValue={current.priority}
          data-active={current.priority ? "1" : undefined}
        >
          {priorities.map((p) => (
            <option key={p.val} value={p.val}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <DateRangePicker
        fromName="requested_date_from"
        toName="requested_date_to"
        initialFrom={current.requested_date_from}
        initialTo={current.requested_date_to}
        label="תאריך מבוקש"
      />

      <fieldset className="tasks-filter-people-group">
        <legend className="tasks-filter-people-legend">אנשים</legend>
        <label>
          כותב
          <input
            type="text"
            name="author"
            list="tasks-people"
            placeholder={current.author || "name@domain"}
            defaultValue={current.author}
            data-active={current.author ? "1" : undefined}
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
            data-active={current.assignee ? "1" : undefined}
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
            data-active={current.approver ? "1" : undefined}
          />
        </label>
        <label>
          מעורב במשימה
          <input
            type="text"
            name="involved_with"
            list="tasks-people"
            placeholder="name@domain"
            defaultValue={current.involved_with}
            data-active={current.involved_with ? "1" : undefined}
            title="כל המשימות שאדם זה מעורב בהן — כותב / מאשר / מנהל פרויקט / עובד מבצע / או תויג בדיון"
          />
        </label>
      </fieldset>
      {/* Shared datalist populates every person input above. */}
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
        {/* "Clear" should genuinely clear — i.e. opt out of the role
            default too. /tasks alone re-applies relevant_to_me, which
            confuses users who expect "clear" to show every task. */}
        <Link href="/tasks?mine=0" className="btn-ghost">
          נקה
        </Link>
      </div>
      </form>
    </details>
  );
}
