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
  tasks: initialTasks,
  groupByCompany = true,
  emptyMessage = "אין משימות תואמות לסינון.",
  hideOther = false,
  compact = false,
  people = [],
  driveName = "",
}: Props) {
  // Local task state lets us optimistically reorder rows on drop and
  // revert on server error — same pattern the kanban uses. Initial
  // value is the server-rendered list passed in by the page.
  const [tasks, setTasks] = useState(initialTasks);
  const [error, setError] = useState<string | null>(null);

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
            </h2>
            {recent.length > 0 && (
              <div className="tasks-table-wrap">
                <SortableContext
                  items={recent.slice().sort(compareByRank).map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <table className={`tasks-table${compact ? " tasks-table-compact" : ""}`}>
                    <thead>
                      <tr>
                        <th className="drag-handle-col" aria-hidden></th>
                        {/* Company column on the portfolio queue. Hidden in
                            compact mode (project pages already scoped to
                            one company). */}
                        {!compact && <th>חברה</th>}
                        {/* The "פרויקט" column is redundant when we're
                            already on a project-scoped page — the caller
                            sets compact to hide it. */}
                        {groupByCompany && <th>פרטי הפרוייקט</th>}
                        {!groupByCompany && !compact && <th>פרויקט</th>}
                        <th>פרטי המשימה</th>
                        <th>כותב</th>
                        <th>מחלקות</th>
                        <th>דחיפות</th>
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
                        tasks={recent}
                        compact={compact}
                        people={people}
                        driveName={driveName}
                      />
                    </tbody>
                  </table>
                </SortableContext>
              </div>
            )}
            {older.length > 0 && (
              <details className="tasks-archive-fold">
                <summary>
                  {`${older.length} משימות ${b.label.toLowerCase()} ישנות (לפני יותר מ‑${b.archiveAfterDays} יום) — לחץ להצגה`}
                </summary>
                <div className="tasks-table-wrap">
                  <SortableContext
                    items={older.slice().sort(compareByRank).map((t) => t.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <table className={`tasks-table${compact ? " tasks-table-compact" : ""}`}>
                      <thead>
                        <tr>
                          <th className="drag-handle-col" aria-hidden></th>
                          {!compact && <th>חברה</th>}
                          {groupByCompany && <th>פרטי הפרוייקט</th>}
                          {!groupByCompany && !compact && <th>פרויקט</th>}
                          <th>פרטי המשימה</th>
                          <th>כותב</th>
                          <th>מחלקות</th>
                          <th>דחיפות</th>
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
                          tasks={older}
                          compact={compact}
                          people={people}
                          driveName={driveName}
                        />
                      </tbody>
                    </table>
                  </SortableContext>
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
function BucketBody({
  tasks,
  compact,
  people,
  driveName,
}: {
  tasks: WorkTask[];
  compact: boolean;
  people: TasksPerson[];
  driveName: string;
}) {
  const sorted = tasks.slice().sort(compareByRank);
  return (
    <>
      {sorted.map((t) => (
        <TaskRow
          key={t.id}
          task={t}
          compact={compact}
          people={people}
          driveName={driveName}
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
}: {
  task: WorkTask;
  compact?: boolean;
  people?: TasksPerson[];
  driveName?: string;
}) {
  // useSortable wires this row into the bucket-scoped SortableContext
  // upstream. We apply transform+transition so the row visually shifts
  // as the user drags through the list (verticalListSortingStrategy
  // computes the offsets); listeners go on the drag-handle cell so the
  // rest of the row stays fully clickable for the link / inline editors.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });
  const rowStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : undefined,
  };

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
    <tr ref={setNodeRef} style={rowStyle} {...attributes}>
      <td className="drag-handle-cell" {...listeners} aria-label="גרור לשינוי סדר">
        <span className="drag-handle-grip" aria-hidden>⋮⋮</span>
      </td>
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
