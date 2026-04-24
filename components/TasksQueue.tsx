import Link from "next/link";
import type { WorkTask, WorkTaskStatus } from "@/lib/appsScript";
import TaskStatusCell from "@/components/TaskStatusCell";

// Four canonical lifecycle buckets, ordered the way the team reads them.
// Terminal states (`draft` / `cancelled`) surface in the "other" fold
// instead so open work stays visually dominant.
const STATUS_BUCKETS: { key: WorkTaskStatus; label: string; tone: string }[] = [
  { key: "in_progress", label: "בעבודה", tone: "in_progress" },
  { key: "awaiting_approval", label: "ממתין לאישור", tone: "awaiting_approval" },
  { key: "awaiting_clarification", label: "ממתין לבירור", tone: "awaiting_clarification" },
  { key: "done", label: "בוצע", tone: "done" },
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
                  {groupByCompany ? (
                    groupByCompanyProject(list).map(([company, projectGroups]) => (
                      <CompanyGroup
                        key={company || "(no-company)"}
                        company={company}
                        projectGroups={projectGroups}
                      />
                    ))
                  ) : (
                    list
                      .slice()
                      .sort((a, b) => b.created_at.localeCompare(a.created_at))
                      .map((t) => <TaskRow key={t.id} task={t} compact={compact} />)
                  )}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {!hideOther && other.length > 0 && (
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
    </>
  );
}

/* ── Grouping helpers ────────────────────────────────────────────── */

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
}: {
  company: string;
  projectGroups: [string, WorkTask[]][];
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

/* ── Row + helpers ───────────────────────────────────────────────── */

function TaskRow({
  task,
  compact = false,
}: {
  task: WorkTask;
  compact?: boolean;
}) {
  return (
    <tr>
      <td className="num">{task.brief || task.id.slice(-6)}</td>
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
        <span className={`tasks-priority-pill p${task.priority}`}>
          {task.priority || "—"}
        </span>
      </td>
      <td className="date-cell">{task.requested_date || "—"}</td>
      {!compact && (
        <td className="date-cell">{formatCreatedAt(task.created_at)}</td>
      )}
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

function formatCreatedAt(iso: string): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}
