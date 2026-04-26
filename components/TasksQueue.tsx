"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { WorkTask, WorkTaskStatus, TasksPerson } from "@/lib/appsScript";

/** Sort axes exposed via clickable column headers. `rank` is the
 *  drag-driven manual order (default); the rest sort within each
 *  status bucket. */
export type TasksSortKey =
  | "rank"
  | "title"
  | "priority"
  | "requested_date"
  | "created_at"
  | "updated_at";
export type TasksSortOrder = "asc" | "desc";
import TaskStatusCell from "@/components/TaskStatusCell";
import GoogleDriveIcon from "@/components/GoogleDriveIcon";
import CopyLocalPathButton from "@/components/CopyLocalPathButton";
import {
  TaskPriorityCell,
  TaskRequestedDateCell,
  TaskApproverCell,
  TaskAssigneesCell,
} from "@/components/TaskInlineEditors";
import { compareByRank, computeInsertRank } from "@/lib/taskRank";

// Canonical lifecycle buckets, ordered left-to-right (RTL: right-to-
// left on screen) the way work actually flows:
//   ממתין לטיפול → בעבודה → ממתין לאישור → בוצע, with ממתין לבירור
// parked alongside as the blocked-for-info bucket.
// Terminal states (`draft` / `cancelled`) surface in the "other" fold.
//
// `archiveAfterDays` (when set) splits the bucket: rows with
// `updated_at` newer than the cutoff render normally; older rows
// collapse into a single <details> fold below them so the queue
// doesn't grow unboundedly with terminal-state work.
//
// Note: there used to be a per-bucket `groupBy` axis (assignee /
// approver / company / none) that would split each bucket into sub-
// header bands. Once rank-based manual ordering replaced the
// chronological within-bucket sort, sub-groups fought with rank — a
// dragged row could land in a "different person's" visual band even
// though its rank was correct. Sub-grouping is now permanently off;
// the per-row company / assignee / approver columns surface the same
// facts without overriding rank order.
const ARCHIVE_AFTER_DAYS = 14;
const STATUS_BUCKETS: {
  key: WorkTaskStatus;
  label: string;
  tone: string;
  archiveAfterDays?: number;
}[] = [
  { key: "awaiting_handling", label: "ממתין לטיפול", tone: "awaiting_handling" },
  { key: "in_progress", label: "בעבודה", tone: "in_progress" },
  { key: "awaiting_clarification", label: "ממתין לבירור", tone: "awaiting_clarification" },
  { key: "awaiting_approval", label: "ממתין לאישור", tone: "awaiting_approval" },
  { key: "done", label: "בוצע", tone: "done", archiveAfterDays: ARCHIVE_AFTER_DAYS },
  // Cancelled used to live in the collapsed "other" fold, but now that
  // it's a revivable state (awaiting_handling / in_progress targets in
  // the menu) users need to see it — otherwise cancelling a task makes
  // it look like it disappeared.
  { key: "cancelled", label: "בוטל", tone: "cancelled", archiveAfterDays: ARCHIVE_AFTER_DAYS },
];

/** Split a list of terminal-state tasks into "recent" + "older". Uses
 *  `updated_at` (ISO) as the freshness signal — that's the timestamp
 *  set when the status flipped to done/cancelled. Falls back to
 *  `created_at` for tasks somehow missing an updated_at. */
function partitionByAge(
  tasks: WorkTask[],
  thresholdDays: number,
): { recent: WorkTask[]; older: WorkTask[] } {
  const cutoff = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;
  const recent: WorkTask[] = [];
  const older: WorkTask[] = [];
  for (const t of tasks) {
    const stamp = t.updated_at || t.created_at;
    const ms = stamp ? new Date(stamp).getTime() : NaN;
    if (Number.isFinite(ms) && ms >= cutoff) recent.push(t);
    else if (Number.isFinite(ms)) older.push(t);
    else recent.push(t); // fail-open if we can't parse the timestamp
  }
  return { recent, older };
}

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
  /**
   * Shared-drive name for the Drive Desktop local-path button on each
   * row. When empty (e.g. SA doesn't resolve it), the row's "open in
   * Explorer" button is hidden. Path format:
   *   G:\Shared drives\<driveName>\<company>\<project>[\<campaign>]
   */
  driveName?: string;
  /**
   * Sort axis applied within each status bucket. "rank" (default)
   * uses drag-driven manual order; any other value disables drag
   * because the rank-based reorder would be invisible to the user
   * under a non-rank sort.
   */
  sort?: TasksSortKey;
  sortOrder?: TasksSortOrder;
  /**
   * Existing search params on /tasks. Used to build the Link hrefs on
   * sortable column headers — toggling preserves filters. Omit on
   * surfaces that don't support URL-driven sort (e.g. project pages).
   */
  searchParams?: Record<string, string | undefined>;
};

/** Default order per sort axis: dates default to descending (newest
 *  first), priority defaults to ascending (1=high first), title
 *  defaults to alpha asc. Keeps the first click on a column behave
 *  the way most users expect. */
function defaultOrderFor(sort: TasksSortKey): TasksSortOrder {
  switch (sort) {
    case "requested_date":
    case "created_at":
    case "updated_at":
      return "desc";
    default:
      return "asc";
  }
}

/** Build the /tasks href that resets sort to rank, preserving every
 *  other current search param. */
function buildResetSortHref(
  current: Record<string, string | undefined>,
): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) {
    if (!v) continue;
    if (k === "sort" || k === "order") continue;
    merged[k] = v;
  }
  const qs = new URLSearchParams(merged).toString();
  return qs ? `/tasks?${qs}` : "/tasks";
}

/** Build a comparator for a non-rank sort axis. Returns null for
 *  `rank`, in which case callers fall back to compareByRank. */
function comparatorFor(
  sort: TasksSortKey,
  order: TasksSortOrder,
): ((a: WorkTask, b: WorkTask) => number) | null {
  if (sort === "rank") return null;
  const dir = order === "desc" ? -1 : 1;
  switch (sort) {
    case "title":
      return (a, b) => dir * a.title.localeCompare(b.title, "he");
    case "priority":
      return (a, b) => dir * ((a.priority || 99) - (b.priority || 99));
    case "requested_date":
      return (a, b) =>
        dir * ((a.requested_date || "").localeCompare(b.requested_date || ""));
    case "created_at":
      return (a, b) => dir * a.created_at.localeCompare(b.created_at);
    case "updated_at":
      return (a, b) => dir * a.updated_at.localeCompare(b.updated_at);
  }
}

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
  tasks: initialTasks,
  groupByCompany = true,
  emptyMessage = "אין משימות תואמות לסינון.",
  hideOther = false,
  compact = false,
  people = [],
  driveName = "",
  sort = "rank",
  sortOrder,
  searchParams,
}: Props) {
  // Local task state lets us optimistically reorder rows on drop and
  // revert on server error — same pattern the kanban uses. Initial
  // value is the server-rendered list passed in by the page.
  const [tasks, setTasks] = useState(initialTasks);
  const [error, setError] = useState<string | null>(null);

  // Resolve the order for the current sort axis. When the caller
  // passes a sort but no order, fall back to the column's natural
  // default direction.
  const effectiveOrder: TasksSortOrder = sortOrder || defaultOrderFor(sort);
  const sortFn = useMemo(
    () => comparatorFor(sort, effectiveOrder),
    [sort, effectiveOrder],
  );
  const dragEnabled = sort === "rank";

  // 8px activation distance keeps a click on a row's title link from
  // accidentally starting a drag — pointer movement past the threshold
  // is the trigger. Touch sensor uses a longer delay so taps don't
  // grab rows on mobile.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  // Bucketize once. Anything off the canonical list sinks into `other`.
  const byStatus = useMemo(() => {
    const map: Record<string, WorkTask[]> = {};
    for (const b of STATUS_BUCKETS) map[b.key] = [];
    const out: WorkTask[] = [];
    for (const t of tasks) {
      if (map[t.status]) map[t.status].push(t);
      else out.push(t);
    }
    return { byStatus: map, other: out };
  }, [tasks]);

  async function onDragEnd(e: DragEndEvent) {
    setError(null);
    if (!e.over) return;
    const draggedId = String(e.active.id);
    const overId = String(e.over.id);
    if (draggedId === overId) return;

    const dragged = tasks.find((t) => t.id === draggedId);
    if (!dragged) return;

    // Drop targets in the table are always other rows in the same
    // bucket (each SortableContext is scoped per-bucket). We compute
    // the new rank from the bucket's currently-rendered order, sorted
    // by rank ascending.
    const bucketTasks = (byStatus.byStatus[dragged.status] || [])
      .filter((t) => t.id !== draggedId)
      .slice()
      .sort(compareByRank);

    const overIdx = bucketTasks.findIndex((t) => t.id === overId);
    if (overIdx === -1) return;
    // We always insert before the over-row — that's the standard
    // verticalListSortingStrategy behavior; user's eye lands on the
    // target, the dropped row takes its place.
    const newRank = computeInsertRank(bucketTasks, overId);

    if (dragged.rank === newRank) return;

    // Optimistic local update.
    const prev = tasks;
    const next = tasks.map((t) =>
      t.id === draggedId ? { ...t, rank: newRank } : t,
    );
    setTasks(next);

    try {
      const res = await fetch("/api/worktasks/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: draggedId,
          patch: { rank: newRank, note: "list: reorder" },
        }),
      });
      const data = (await res.json()) as
        | { ok: true }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error("error" in data ? data.error : "Update failed");
      }
    } catch (err) {
      setTasks(prev);
      setError(err instanceof Error ? err.message : String(err));
    }
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

  const { byStatus: byStatusMap, other } = byStatus;

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      {error && (
        <div className="kanban-error" role="alert">
          {error}
          <button
            type="button"
            className="kanban-error-dismiss"
            onClick={() => setError(null)}
            aria-label="סגור"
          >
            ×
          </button>
        </div>
      )}
      {STATUS_BUCKETS.map((b) => {
        const list = byStatusMap[b.key] || [];
        if (!list.length) return null;
        // Terminal-state buckets (done / cancelled) split into recent
        // + older — older rows live behind a fold so the queue doesn't
        // accumulate visual debt over time.
        const { recent, older } = b.archiveAfterDays
          ? partitionByAge(list, b.archiveAfterDays)
          : { recent: list, older: [] };
        return (
          <section key={b.key} className={`tasks-bucket tasks-bucket-${b.tone}`}>
            <h2 className="tasks-bucket-head">
              {b.label}
              <span className="tasks-bucket-count">{list.length}</span>
              {sort !== "rank" && searchParams && (
                <Link
                  href={buildResetSortHref(searchParams)}
                  scroll={false}
                  className="tasks-bucket-sort-reset"
                  title="חזור למיון ברירת המחדל (סדר ידני)"
                >
                  ↺ סדר ידני
                </Link>
              )}
            </h2>
            {recent.length > 0 && (
              <div className="tasks-table-wrap">
                <SortableTableSection
                  rows={recent}
                  compact={compact}
                  groupByCompany={groupByCompany}
                  people={people}
                  driveName={driveName}
                  sort={sort}
                  sortOrder={effectiveOrder}
                  sortFn={sortFn}
                  searchParams={searchParams}
                  dragEnabled={dragEnabled}
                />
              </div>
            )}
            {older.length > 0 && (
              <details className="tasks-archive-fold">
                <summary>
                  {`${older.length} משימות ${b.label.toLowerCase()} ישנות (לפני יותר מ‑${b.archiveAfterDays} יום) — לחץ להצגה`}
                </summary>
                <div className="tasks-table-wrap">
                  <SortableTableSection
                    rows={older}
                    compact={compact}
                    groupByCompany={groupByCompany}
                    people={people}
                    driveName={driveName}
                    sort={sort}
                    sortOrder={effectiveOrder}
                    sortFn={sortFn}
                    searchParams={searchParams}
                    dragEnabled={dragEnabled}
                  />
                </div>
              </details>
            )}
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
    </DndContext>
  );
}

/* ── Bucket body ─────────────────────────────────────────────────── */

/**
 * Renders the rows for a single status bucket, sorted by rank
 * ascending. There used to be sub-grouping helpers here (assignee /
 * approver / company sub-headers) but rank-based ordering replaced
 * them — sub-headers fought with rank, see the STATUS_BUCKETS comment
 * for the rationale.
 */

/** Wraps the table + thead + tbody for one section (recent or
 *  archived rows of a single bucket). Owns the SortableContext too —
 *  drag-reorder is enabled only when sorting by rank, since dragging
 *  under a column-driven sort doesn't visibly affect order and just
 *  confuses the user. */
function SortableTableSection({
  rows,
  compact,
  groupByCompany,
  people,
  driveName,
  sort,
  sortOrder,
  sortFn,
  searchParams,
  dragEnabled,
}: {
  rows: WorkTask[];
  compact: boolean;
  groupByCompany: boolean;
  people: TasksPerson[];
  driveName: string;
  sort: TasksSortKey;
  sortOrder: TasksSortOrder;
  sortFn: ((a: WorkTask, b: WorkTask) => number) | null;
  searchParams?: Record<string, string | undefined>;
  dragEnabled: boolean;
}) {
  const ordered = sortFn
    ? rows.slice().sort(sortFn)
    : rows.slice().sort(compareByRank);
  const head = (
    <thead>
      <tr>
        {dragEnabled && <th className="drag-handle-col" aria-hidden></th>}
        {!compact && <th>חברה</th>}
        {groupByCompany && <th>פרטי הפרוייקט</th>}
        {!groupByCompany && !compact && <th>פרויקט</th>}
        <SortableTh
          column="title"
          label="פרטי המשימה"
          sort={sort}
          sortOrder={sortOrder}
          searchParams={searchParams}
        />
        <th>כותב</th>
        <th>מחלקות</th>
        <SortableTh
          column="priority"
          label="דחיפות"
          sort={sort}
          sortOrder={sortOrder}
          searchParams={searchParams}
        />
        <SortableTh
          column="requested_date"
          label="תאריך"
          sort={sort}
          sortOrder={sortOrder}
          searchParams={searchParams}
        />
        {!compact && (
          <SortableTh
            column="created_at"
            label="נוצרה"
            sort={sort}
            sortOrder={sortOrder}
            searchParams={searchParams}
          />
        )}
        <th>סטטוס</th>
        <th>עובדים</th>
        <th>מאשר</th>
        <th className="icons">פעולות</th>
      </tr>
    </thead>
  );
  const body = (
    <BucketBody
      tasks={ordered}
      compact={compact}
      people={people}
      driveName={driveName}
      dragEnabled={dragEnabled}
    />
  );
  const table = (
    <table className={`tasks-table${compact ? " tasks-table-compact" : ""}`}>
      {head}
      <tbody>{body}</tbody>
    </table>
  );
  if (!dragEnabled) return table;
  return (
    <SortableContext
      items={ordered.map((t) => t.id)}
      strategy={verticalListSortingStrategy}
    >
      {table}
    </SortableContext>
  );
}

/** A single column header that's clickable when `searchParams` is
 *  provided (URL-driven sort). Click toggles asc/desc on the active
 *  column, or sets this column as the new sort axis with its default
 *  direction. Without `searchParams` (e.g. when used on a project
 *  page that doesn't expose URL sort), renders as plain text. */
function SortableTh({
  column,
  label,
  sort,
  sortOrder,
  searchParams,
}: {
  column: TasksSortKey;
  label: string;
  sort: TasksSortKey;
  sortOrder: TasksSortOrder;
  searchParams?: Record<string, string | undefined>;
}) {
  if (!searchParams) {
    return <th>{label}</th>;
  }
  const isActive = sort === column;
  const nextOrder: TasksSortOrder = isActive
    ? sortOrder === "asc"
      ? "desc"
      : "asc"
    : defaultOrderFor(column);
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(searchParams)) {
    if (v) merged[k] = v;
  }
  merged.sort = column;
  merged.order = nextOrder;
  const qs = new URLSearchParams(merged).toString();
  const href = qs ? `/tasks?${qs}` : "/tasks";
  return (
    <th className={`sortable-th${isActive ? " is-active" : ""}`}>
      <Link href={href} scroll={false} className="sortable-th-link">
        {label}
        <span className="sortable-th-indicator" aria-hidden>
          {isActive ? (sortOrder === "desc" ? " ▼" : " ▲") : ""}
        </span>
      </Link>
    </th>
  );
}

function BucketBody({
  tasks,
  compact,
  people,
  driveName,
  dragEnabled = true,
}: {
  tasks: WorkTask[];
  compact: boolean;
  people: TasksPerson[];
  driveName: string;
  dragEnabled?: boolean;
}) {
  // Caller (SortableTableSection) already sorted into the right order
  // for the active sort axis; we just render in the order received.
  return (
    <>
      {tasks.map((t) => (
        <TaskRow
          key={t.id}
          task={t}
          compact={compact}
          people={people}
          driveName={driveName}
          dragEnabled={dragEnabled}
        />
      ))}
    </>
  );
}

/* ── Row + helpers ───────────────────────────────────────────────── */

function TaskRow({
  task,
  compact = false,
  people = [],
  driveName = "",
  dragEnabled = true,
}: {
  task: WorkTask;
  compact?: boolean;
  people?: TasksPerson[];
  driveName?: string;
  dragEnabled?: boolean;
}) {
  // useSortable always runs (rules of hooks), but we ignore its bindings
  // when drag is disabled — i.e. when the queue is sorted by something
  // other than rank. Under a non-rank sort, dragging would reorder the
  // task's stored rank invisibly, so we hide the handle and skip the
  // attributes / listeners on the row.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });
  const rowStyle: React.CSSProperties = dragEnabled
    ? {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.45 : undefined,
      }
    : {};

  // Drive Desktop local path. We deliberately don't include the
  // task-specific subfolder (drive_folder_url is a web URL, not a path);
  // the user can drill into it once Explorer opens at the campaign
  // level. The path is omitted entirely when the SA couldn't resolve
  // the shared-drive name (driveName === "").
  const localPath =
    driveName && task.project
      ? `G:\\Shared drives\\${driveName}\\${task.company || ""}\\${task.project}${
          task.campaign ? `\\${task.campaign}` : ""
        }`
      : "";
  return (
    <tr
      ref={dragEnabled ? setNodeRef : undefined}
      style={rowStyle}
      {...(dragEnabled ? attributes : {})}
    >
      {dragEnabled && (
        <td className="drag-handle-cell" {...listeners} aria-label="גרור לשינוי סדר">
          <span className="drag-handle-grip" aria-hidden>⋮⋮</span>
        </td>
      )}
      {!compact && (
        <td className="tasks-company-cell">
          {task.company ? (
            task.company
          ) : (
            <span className="task-empty-cell">—</span>
          )}
        </td>
      )}
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
        {isCreatedWithin24h(task.created_at) && (
          <span className="tasks-new-chip" title="נוצרה ב־24 שעות האחרונות">
            🆕 חדש
          </span>
        )}
        {task.brief && (
          <span className="tasks-brief-chip" title="בריף">
            #{task.brief}
          </span>
        )}
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
              className="tasks-row-icon tasks-row-icon-drive"
              title="תיקיית קבצים ב־Drive"
              aria-label="תיקיית קבצים ב־Drive"
            >
              <GoogleDriveIcon size="1em" />
            </a>
          )}
          {localPath && (
            <CopyLocalPathButton
              path={localPath}
              title="העתק נתיב מקומי — Drive Desktop"
            />
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

/** Within the last 24h — same window the kanban card uses for the
 *  "🆕 חדש" chip. Now that within-bucket sort is rank-driven (not
 *  chronological), this badge restores the "what just landed" signal. */
function isCreatedWithin24h(iso: string): boolean {
  const ms = Date.parse(iso || "");
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms < 24 * 60 * 60 * 1000;
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
