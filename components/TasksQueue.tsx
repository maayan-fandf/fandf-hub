import Link from "next/link";
import type { WorkTask, WorkTaskStatus, TasksPerson } from "@/lib/appsScript";
import TaskStatusCell from "@/components/TaskStatusCell";
import {
  TaskPriorityCell,
  TaskRequestedDateCell,
  TaskApproverCell,
  TaskAssigneesCell,
} from "@/components/TaskInlineEditors";

// Canonical lifecycle buckets, ordered left-to-right (RTL: right-to-
// left on screen) the way work actually flows:
//   ממתין לטיפול → בעבודה → ממתין לאישור → בוצע, with ממתין לבירור
// parked alongside as the blocked-for-info bucket.
// Terminal states (`draft` / `cancelled`) surface in the "other" fold.
//
// `groupBy` picks the sub-grouping axis inside each bucket. Chosen per
// state by what's actionable in that state — e.g. in `ממתין לאישור`,
// the approver's name is the information the viewer cares about (who's
// blocking whom). In `ממתין לטיפול` / `בעבודה`, the assignee is what
// matters (who owns it). `company` keeps the portfolio's company →
// project grouping used elsewhere on the queue page.
type GroupAxis = "assignee" | "approver" | "company" | "none";
const STATUS_BUCKETS: {
  key: WorkTaskStatus;
  label: string;
  tone: string;
  groupBy: GroupAxis;
}[] = [
  { key: "awaiting_handling", label: "ממתין לטיפול", tone: "awaiting_handling", groupBy: "assignee" },
  { key: "in_progress", label: "בעבודה", tone: "in_progress", groupBy: "assignee" },
  { key: "awaiting_clarification", label: "ממתין לבירור", tone: "awaiting_clarification", groupBy: "none" },
  { key: "awaiting_approval", label: "ממתין לאישור", tone: "awaiting_approval", groupBy: "approver" },
  { key: "done", label: "בוצע", tone: "done", groupBy: "company" },
  // Cancelled used to live in the collapsed "other" fold, but now that
  // it's a revivable state (awaiting_handling / in_progress targets in
  // the menu) users need to see it — otherwise cancelling a task makes
  // it look like it disappeared.
  { key: "cancelled", label: "בוטל", tone: "cancelled", groupBy: "none" },
];

type Props = {
  tasks: WorkTask[];
  /**
   * Whether to group rows by company → project inside each bucket.
   * True on the portfolio-wide queue (`/tasks`) where you're looking
   * across companies; false on a project-scoped page where the project
   * is already implicit in the page header.
   */
  groupByCompany?: boolean;
  /**
   * Text to show when there are zero tasks in any bucket. Callers can
   * customize this for e.g. "no tasks on this project yet" vs. the
   * portfolio-wide "no tasks matching your filters".
   */
  emptyMessage?: string;
  /**
   * When true, the "other" fold (draft + cancelled) is hidden to reduce
   * visual noise on compact surfaces like the project page. Defaults
   * to false so the main queue keeps showing it.
   */
  hideOther?: boolean;
  /**
   * Compact layout — smaller column padding, drops the redundant
   * "פרויקט" column (implied when the caller is a project-scoped page)
   * and the description preview. Used on /projects/[project] so the
   * queue section sits cleanly alongside the other sections on the
   * page instead of forcing a wide horizontal scroll.
   */
  compact?: boolean;
  /**
   * People list — used by the inline-edit popovers on the assignees
   * and approver cells. When empty, those cells fall back to plain
   * text (no autocomplete). Callers should pass the same
   * tasksPeopleList() payload they already fetch for the filter bar.
   */
  people?: TasksPerson[];
};

/**
 * The Data-Plus-style tasks queue, rendered as grouped lifecycle
 * buckets over a single flat <table>. Used both on `/tasks` (portfolio
 * view, with company grouping) and on `/projects/[project]` (project
 * view, company grouping off — projects are already scoped).
 *
 * Note: the company-group / project-group sub-headers share the same
 * table body so column widths stay aligned without nested tables.
 */
export default function TasksQueue({
  tasks,
  groupByCompany = true,
  emptyMessage = "אין משימות תואמות לסינון.",
  hideOther = false,
  compact = false,
  people = [],
}: Props) {
  // Bucketize once. Anything off the canonical list sinks into `other`.
  const byStatus: Record<string, WorkTask[]> = {};
  for (const b of STATUS_BUCKETS) byStatus[b.key] = [];
  const other: WorkTask[] = [];
  for (const t of tasks) {
    if (byStatus[t.status]) byStatus[t.status].push(t);
    else other.push(t);
  }

  if (tasks.length === 0) {
    return (
      <div className="empty">
        <span className="emoji" aria-hidden>
          🌿
        </span>
        {emptyMessage}
      </div>
    );
  }

  return (
    <>
      {STATUS_BUCKETS.map((b) => {
        const list = byStatus[b.key] || [];
        if (!list.length) return null;
        // Per-bucket axis picks the sub-header the rows cluster under.
        // On project pages (groupByCompany=false) a `company` axis still
        // resolves — it just collapses to a single project sub-header —
        // so we don't need a separate branch for that mode.
        const axis: GroupAxis =
          b.groupBy === "company" && !groupByCompany ? "none" : b.groupBy;
        return (
          <section key={b.key} className={`tasks-bucket tasks-bucket-${b.tone}`}>
            <h2 className="tasks-bucket-head">
              {b.label}
              <span className="tasks-bucket-count">{list.length}</span>
            </h2>
            <div className="tasks-table-wrap">
              <table className={`tasks-table${compact ? " tasks-table-compact" : ""}`}>
                <thead>
                  <tr>
                    <th className="num">מספר</th>
                    {/* The "פרויקט" column is redundant when we're
                        already on a project-scoped page — the caller
                        sets compact to hide it. */}
                    {groupByCompany && <th>פרטי הפרוייקט</th>}
                    {!groupByCompany && !compact && <th>פרויקט</th>}
                    <th>פרטי המשימה</th>
                    <th>כותב</th>
                    <th>מחלקות</th>
                    <th>עדיפות</th>
                    <th>תאריך</th>
                    {!compact && <th>נוצרה</th>}
                    <th>סטטוס</th>
                    <th>עובדים</th>
                    <th>מאשר</th>
                    <th className="icons">פעולות</th>
                  </tr>
                </thead>
                <tbody>
                  <BucketBody
                    tasks={list}
                    axis={axis}
                    compact={compact}
                    people={people}
                  />
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {!hideOther && other.length > 0 && (
        <details className="tasks-other">
          <summary>
            {other.length} טיוטות — לחץ להצגה
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
                    {/* Interactive status cell — cancelled tasks need a
                        way to be revived; a read-only pill here was the
                        reason "I don't see any way to un-cancel". */}
                    <td>
                      <TaskStatusCell task={t} />
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
    </>
  );
}

/* ── Grouping helpers ────────────────────────────────────────────── */

/**
 * Renders the body of a single status bucket, sub-grouped on the axis
 * chosen per bucket (assignee / approver / company / none). The sub-
 * header is Data-Plus-style: a single row across the whole table width
 * labelling what the grouping is (e.g. "באישור של: ספיר יצחקוב").
 */
function BucketBody({
  tasks,
  axis,
  compact,
  people,
}: {
  tasks: WorkTask[];
  axis: GroupAxis;
  compact: boolean;
  people: TasksPerson[];
}) {
  const totalCols = 12;

  if (axis === "none") {
    const sorted = tasks
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return (
      <>
        {sorted.map((t) => (
          <TaskRow key={t.id} task={t} compact={compact} people={people} />
        ))}
      </>
    );
  }

  if (axis === "company") {
    return (
      <>
        {groupByCompanyProject(tasks).map(([company, projectGroups]) => (
          <CompanyGroup
            key={company || "(no-company)"}
            company={company}
            projectGroups={projectGroups}
            people={people}
          />
        ))}
      </>
    );
  }

  // Person-axis sub-grouping (assignee or approver).
  const groups = groupByPerson(tasks, axis);
  return (
    <>
      {groups.map(([personEmail, rows]) => (
        <PersonGroup
          key={personEmail || "(none)"}
          label={axis === "approver" ? "באישור של" : "אצל"}
          personEmail={personEmail}
          rows={rows}
          totalCols={totalCols}
          compact={compact}
          people={people}
        />
      ))}
    </>
  );
}

function groupByPerson(
  tasks: WorkTask[],
  axis: "assignee" | "approver",
): [string, WorkTask[]][] {
  const byPerson = new Map<string, WorkTask[]>();
  for (const t of tasks) {
    const key =
      axis === "approver"
        ? (t.approver_email || "").toLowerCase().trim()
        : ((t.assignees || [])[0] || "").toLowerCase().trim();
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key)!.push(t);
  }
  // Unassigned sinks to the bottom so real people lead.
  const keys = Array.from(byPerson.keys()).sort((a, b) => {
    if (!a && b) return 1;
    if (a && !b) return -1;
    return a.localeCompare(b);
  });
  return keys.map((k) => [
    k,
    byPerson
      .get(k)!
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at)),
  ]);
}

function PersonGroup({
  label,
  personEmail,
  rows,
  totalCols,
  compact,
  people,
}: {
  label: string;
  personEmail: string;
  rows: WorkTask[];
  totalCols: number;
  compact: boolean;
  people: TasksPerson[];
}) {
  const displayName = personEmail
    ? shortName(personEmail)
    : "(לא משויך)";
  return (
    <>
      <tr className="tasks-person-header">
        <td colSpan={totalCols}>
          <span className="tasks-person-header-label">{label}:</span>{" "}
          <span className="tasks-person-header-name">{displayName}</span>
          <span className="tasks-person-header-count">{rows.length}</span>
        </td>
      </tr>
      {rows.map((t) => (
        <TaskRow key={t.id} task={t} compact={compact} people={people} />
      ))}
    </>
  );
}

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
    return [
      co,
      projects.map(
        (p) =>
          [
            p,
            projMap
              .get(p)!
              .slice()
              .sort((a, b) => b.created_at.localeCompare(a.created_at)),
          ] as [string, WorkTask[]],
      ),
    ];
  });
}

function CompanyGroup({
  company,
  projectGroups,
  people,
}: {
  company: string;
  projectGroups: [string, WorkTask[]][];
  people: TasksPerson[];
}) {
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
          people={people}
        />
      ))}
    </>
  );
}

function ProjectSubGroup({
  project,
  rows,
  totalCols,
  people,
}: {
  project: string;
  rows: WorkTask[];
  totalCols: number;
  people: TasksPerson[];
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
        <TaskRow key={t.id} task={t} people={people} />
      ))}
    </>
  );
}

/* ── Row + helpers ───────────────────────────────────────────────── */

function TaskRow({
  task,
  compact = false,
  people = [],
}: {
  task: WorkTask;
  compact?: boolean;
  people?: TasksPerson[];
}) {
  return (
    <tr>
      <td className="num">
        {task.brief ? (
          task.brief
        ) : (
          <span className="task-id-tail" title={task.id}>
            {task.id.split("-").pop() || ""}
          </span>
        )}
      </td>
      {/* Project cell omitted in compact mode (page is already scoped). */}
      {!compact && (
        <td className="tasks-project-cell-nested">{task.project}</td>
      )}
      <td className="title-cell">
        <Link
          href={`/tasks/${encodeURIComponent(task.id)}`}
          className="tasks-title-link"
        >
          {task.title}
        </Link>
        {task.campaign && (
          <span className="tasks-campaign-chip" title="קמפיין">
            📣 {task.campaign}
          </span>
        )}
        {task.round_number > 1 && (
          <span className="tasks-round-chip" title="סבב תיקונים">
            סבב #{task.round_number}
          </span>
        )}
        {!compact && task.description && (
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
        <TaskPriorityCell task={task} />
      </td>
      <td className="date-cell">
        <TaskRequestedDateCell task={task} />
      </td>
      {!compact && (
        <td className="date-cell">{formatCreatedAt(task.created_at)}</td>
      )}
      <td>
        <TaskStatusCell task={task} />
      </td>
      <td>
        <TaskAssigneesCell task={task} people={people} />
      </td>
      <td>
        <TaskApproverCell task={task} people={people} />
      </td>
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
            className={`tasks-row-icon${task.comments_count ? " has-comments" : ""}`}
            title={
              task.comments_count
                ? `${task.comments_count} תגובות`
                : "היסטוריה + הערות"
            }
          >
            💬
            {task.comments_count ? (
              <span className="tasks-row-icon-badge">{task.comments_count}</span>
            ) : null}
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

function formatCreatedAt(iso: string): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}
