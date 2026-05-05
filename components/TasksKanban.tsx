"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  useDroppable,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { WorkTask, WorkTaskStatus, TasksPerson } from "@/lib/appsScript";
import { STATUS_LABELS, STATUS_EMOJIS } from "@/components/TaskStatusCell";
import Avatar from "@/components/Avatar";
import { fireConfetti, firePulse } from "@/lib/confetti";
import { compareByRank, computeInsertRank } from "@/lib/taskRank";

type ColumnDef = {
  key: WorkTaskStatus;
  label: string;
  tone: string;
};

// Same lifecycle order used by TasksQueue's STATUS_BUCKETS so the two
// views read left-to-right (visually right-to-left in RTL) the same way.
const COLUMNS: ColumnDef[] = [
  { key: "awaiting_handling", label: "ממתין לטיפול", tone: "awaiting_handling" },
  { key: "in_progress", label: "בעבודה", tone: "in_progress" },
  { key: "awaiting_clarification", label: "ממתין לבירור", tone: "awaiting_clarification" },
  { key: "awaiting_approval", label: "ממתין לאישור", tone: "awaiting_approval" },
  { key: "done", label: "בוצע", tone: "done" },
  { key: "cancelled", label: "בוטל", tone: "cancelled" },
];

type Props = {
  tasks: WorkTask[];
  people?: TasksPerson[];
  emptyMessage?: string;
  /**
   * When true, the done + cancelled columns are hidden behind an
   * "📦 ארכיון" pill at the end of the board. Click expands them
   * inline; clicking the pill again collapses. Driven by the user's
   * hide_archived gear-menu pref via the page-level archive toggle.
   * Status-explicit URLs (?status=done) override at the page level
   * by passing hideArchived=false. */
  hideArchived?: boolean;
};

/**
 * Trello-style Kanban view of the same tasks the queue table renders.
 * One column per lifecycle status; cards are draggable across columns
 * via @dnd-kit. Drops are validated against `TRANSITIONS` (the same
 * state machine the inline status pill uses) — illegal moves snap back.
 *
 * Optimistic UX: the card moves to the target column immediately, then
 * we POST /api/worktasks/update. On error we revert the local state and
 * show a toast. On success we leave the local state in place; the next
 * full page load will reconcile against the server.
 */
export default function TasksKanban({
  tasks: initialTasks,
  people = [],
  emptyMessage = "אין משימות תואמות לסינון.",
  hideArchived = false,
}: Props) {
  // Local archive expansion — when the page-level pref hides
  // archive but the user wants to peek without flipping the global
  // setting, this expands the done/cancelled columns inline for
  // the current visit. Resets when the user navigates away.
  const [archiveExpanded, setArchiveExpanded] = useState(false);
  const showArchive = !hideArchived || archiveExpanded;
  // Local state lets us optimistically update on drop and revert on
  // server error without re-fetching. The parent page passes the
  // server-rendered list as the seed.
  const [tasks, setTasks] = useState(initialTasks);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 8px activation distance keeps a click on the card link from
  // accidentally starting a drag — clicks on the title <Link> still
  // navigate, only meaningful pointer movement starts a drag. Touch
  // sensor uses a longer delay so taps don't grab cards on mobile.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Bucket tasks once per render. Anything off the canonical list (e.g.
  // `draft`) sinks into a hidden bucket — kanban deliberately doesn't
  // surface drafts.
  const byStatus = useMemo(() => {
    const map: Record<string, WorkTask[]> = {};
    for (const c of COLUMNS) map[c.key] = [];
    for (const t of tasks) {
      if (map[t.status]) map[t.status].push(t);
    }
    // Within each column: sort by manual rank (lower = top). Drag-and-
    // drop updates the rank field directly so this sort stays the
    // source of truth.
    for (const k of Object.keys(map)) {
      map[k].sort(compareByRank);
    }
    return map;
  }, [tasks]);

  const draggingTask = draggingId
    ? tasks.find((t) => t.id === draggingId) || null
    : null;

  function onDragStart(e: DragStartEvent) {
    setDraggingId(String(e.active.id));
    setError(null);
  }

  async function onDragEnd(e: DragEndEvent) {
    const id = String(e.active.id);
    setDraggingId(null);
    if (!e.over) return;
    const overId = String(e.over.id);
    if (overId === id) return;

    const task = tasks.find((t) => t.id === id);
    if (!task) return;

    // Resolve the drop into (targetStatus, insertBeforeId | null).
    // - Drop on a card → status of that card's column, insert just
    //   above that card (insertBeforeId = card.id). Cross-column moves
    //   work the same way: target column is wherever the over-card
    //   currently lives.
    // - Drop on a column body (`col:<status>`) with no card under the
    //   pointer → drop the dragged card AT THE END of that column.
    //   This is the "drop on empty space" path; with `closestCorners`
    //   collision the closest card wins as long as the pointer is
    //   anywhere near a card, so this branch only fires on truly empty
    //   columns or far-from-cards drops.
    let targetStatus: WorkTaskStatus;
    let insertBeforeId: string | null = null;
    if (overId.startsWith("col:")) {
      targetStatus = overId.slice(4) as WorkTaskStatus;
    } else {
      const target = tasks.find((t) => t.id === overId);
      if (!target) return;
      targetStatus = target.status;
      insertBeforeId = target.id;
    }

    // Compute new rank from the column's currently-rendered order
    // (already sorted by rank asc in `byStatus`).
    const colTasks = (byStatus[targetStatus] || []).filter((t) => t.id !== id);
    const newRank = computeInsertRank(colTasks, insertBeforeId);

    const sameStatus = task.status === targetStatus;
    const sameRank = task.rank === newRank;
    if (sameStatus && sameRank) return;

    // Optimistic local update — flips status + rank before the fetch
    // round-trip lands.
    const prev = tasks;
    const next = tasks.map((t) =>
      t.id === id ? { ...t, status: targetStatus, rank: newRank } : t,
    );
    setTasks(next);

    const patch: { status?: WorkTaskStatus; rank?: number; note?: string } = {
      rank: newRank,
    };
    if (!sameStatus) {
      patch.status = targetStatus;
      patch.note = `kanban: ${STATUS_LABELS[targetStatus]}`;
    } else {
      patch.note = `kanban: reorder`;
    }

    try {
      const res = await fetch("/api/worktasks/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, patch }),
      });
      const data = (await res.json()) as
        | { ok: true }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error("error" in data ? data.error : "Update failed");
      }
      // Reuse the same celebration cues the inline pill fires so kanban
      // moves feel as alive as table moves. Origin is the page center
      // because the dragged card has already been re-parented by now.
      if (!sameStatus) {
        if (targetStatus === "done") {
          fireConfetti();
        } else if (targetStatus === "awaiting_approval") {
          firePulse();
        }
      }
    } catch (err) {
      setTasks(prev);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (initialTasks.length === 0) {
    return (
      <div className="empty">
        <span className="emoji" aria-hidden>
          🌿
        </span>
        {emptyMessage}
      </div>
    );
  }

  // Build a quick people lookup so cards can render names from emails
  // without re-iterating the list per row.
  const peopleByEmail = new Map<string, TasksPerson>();
  for (const p of people) {
    peopleByEmail.set((p.email || "").toLowerCase(), p);
  }

  return (
    <DndContext
      sensors={sensors}
      // Three-tier collision detection. closestCorners alone (the
      // previous default) caused two pain points users hit:
      //   1. On EMPTY columns, dropping anywhere off the vertical
      //      center failed silently — the closest CORNER of the slim
      //      column was further from the cursor than a card-corner
      //      in the adjacent column, so the drop landed in the
      //      neighbor.
      //   2. Mid-drag flicker on the empty column's expansion — at
      //      borderline positions closestCorners flipped between
      //      candidates per move, toggling isOver/.is-drop-target
      //      and the resulting layout shift.
      // pointerWithin (cursor inside a droppable's rect) is much
      // closer to user intent: drop where you're pointing. We add
      // rectIntersection + closestCorners as fallbacks for drags
      // that release in a gap between columns.
      collisionDetection={kanbanCollisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
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
      <div className="kanban-board">
        {COLUMNS.map((col) => {
          // "done" stays visible on the kanban regardless of the
          // archive pref — dragging to done is the primary completion
          // gesture and the green column is part of the satisfying
          // workflow signal. Only "cancelled" collapses behind the
          // archive pill (rare + terminal deadweight that piles up).
          const isHideable = col.key === "cancelled";
          if (isHideable && !showArchive) return null;
          return (
            <KanbanColumn
              key={col.key}
              column={col}
              tasks={byStatus[col.key] || []}
              peopleByEmail={peopleByEmail}
            />
          );
        })}
        {/* Archive expand/collapse affordance — only cancelled
            lives behind it now, so the count + label reflect that. */}
        {hideArchived && (() => {
          const archivedTotal = byStatus["cancelled"]?.length || 0;
          if (!archiveExpanded && archivedTotal === 0) return null;
          return (
            <button
              type="button"
              className={`kanban-archive-pill${
                archiveExpanded ? " is-expanded" : ""
              }`}
              onClick={() => setArchiveExpanded((v) => !v)}
              aria-expanded={archiveExpanded}
              title={
                archiveExpanded
                  ? "כווץ את עמודת הארכיון"
                  : `${archivedTotal} משימות בוטלו מוסתרות — לחץ להצגה`
              }
            >
              <span aria-hidden>📦</span>
              {archiveExpanded ? "כווץ ארכיון" : "ארכיון"}
              {!archiveExpanded && archivedTotal > 0 && (
                <span className="kanban-archive-pill-count">
                  {archivedTotal}
                </span>
              )}
            </button>
          );
        })()}
      </div>
      <DragOverlay>
        {draggingTask ? (
          <KanbanCard
            task={draggingTask}
            peopleByEmail={peopleByEmail}
            isOverlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/* ── Column ──────────────────────────────────────────────────────── */

function KanbanColumn({
  column,
  tasks,
  peopleByEmail,
}: {
  column: ColumnDef;
  tasks: WorkTask[];
  peopleByEmail: Map<string, TasksPerson>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column.key}` });
  // Items list for the SortableContext — cards reorder visually within
  // this list during drag (verticalListSortingStrategy shifts neighbors
  // out of the way). Without this wrapper, dropping in any gap between
  // cards falls back to the column droppable and lands at the bottom.
  const itemIds = tasks.map((t) => t.id);
  return (
    <section
      ref={setNodeRef}
      className={`kanban-column kanban-column-${column.tone}${isOver ? " is-drop-target" : ""}`}
      aria-label={column.label}
      data-empty={tasks.length === 0 ? "1" : "0"}
    >
      <header className="kanban-column-head">
        <span className="kanban-column-label">
          <span className="kanban-column-emoji" aria-hidden>
            {STATUS_EMOJIS[column.key]}
          </span>
          {column.label}
        </span>
        <span className="kanban-column-count">{tasks.length}</span>
      </header>
      <div className="kanban-column-body">
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {tasks.length === 0 ? (
            <div className="kanban-column-empty">אין משימות</div>
          ) : (
            tasks.map((t) => (
              <KanbanCard key={t.id} task={t} peopleByEmail={peopleByEmail} />
            ))
          )}
        </SortableContext>
      </div>
    </section>
  );
}

/* ── Card ────────────────────────────────────────────────────────── */

function KanbanCard({
  task,
  peopleByEmail,
  isOverlay = false,
}: {
  task: WorkTask;
  peopleByEmail: Map<string, TasksPerson>;
  isOverlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });

  // While the original card is being dragged, hide it from its column so
  // only the DragOverlay clone is visible. Otherwise the user sees two
  // copies of the card until drop. Other (non-dragged) cards in the same
  // SortableContext shift via `transform` to preview the drop position
  // — the `transition` prop animates that shift smoothly.
  const style: React.CSSProperties = { transition };
  if (transform && !isOverlay) {
    style.transform = `translate3d(${transform.x}px, ${transform.y}px, 0)`;
  }
  if (isDragging && !isOverlay) {
    style.opacity = 0;
  }

  // Priority drives both the inline chip and the card's start-side edge.
  // p1 (high) = red solid edge + 🔥 גבוהה chip; p3 (low) = grey dashed
  // edge + ⏬ נמוכה chip; p2 (normal) = no chip, default border. The
  // dot in the foot row was redundant once the chip carries the label
  // and the edge gives a glanceable signal across a busy column.
  const priorityClass =
    task.priority === 1 ? "high" : task.priority === 3 ? "low" : "normal";
  const showPriorityChip = priorityClass !== "normal";
  // Surface a small "🆕 חדש" chip on tasks created in the last 24h.
  // Manual rank ordering replaced the chronological within-column sort,
  // so we lost the implicit "new = on top" signal — this puts it back
  // visually without forcing it into the sort.
  const isNew = (() => {
    const ms = Date.parse(task.created_at);
    if (!Number.isFinite(ms)) return false;
    return Date.now() - ms < 24 * 60 * 60 * 1000;
  })();
  const hasChips =
    isNew ||
    task.campaign ||
    task.round_number > 1 ||
    showPriorityChip;
  // Every person involved with the task — author, approver, project
  // manager, and each assignee — collapsed into one ordered list with
  // their roles merged when the same email shows up under multiple
  // hats (e.g. maayan as both author + assignee → one avatar with
  // tooltip "מבצע · גם כותב"). Order: author → approver → PM →
  // assignees, which in RTL puts author at the visually rightmost
  // position. Highlighted role-per-status drives the ring color.
  const peopleInvolved = buildPeopleInvolved(task, peopleByEmail);
  const highlightRole = STATUS_HIGHLIGHT_ROLE[task.status];
  const PEOPLE_CAP = 4;
  const peopleVisible = peopleInvolved.slice(0, PEOPLE_CAP);
  const peopleOverflow = peopleInvolved.length - PEOPLE_CAP;

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`kanban-card kanban-card-edge-${priorityClass}${isOverlay ? " is-overlay" : ""}${isDragging ? " is-dragging" : ""}`}
      {...attributes}
      {...listeners}
    >
      <div className="kanban-card-header">
        {/* Phase 6b — 🔒 badge for blocked tasks. Sits before the
            title so the visual cue lands first. Title attribute
            shows a quick hint of what's holding it up; the side
            panel on the detail page lists the actual blockers. */}
        {task.status === "blocked" && (
          <span
            className="tasks-card-blocked-badge"
            title={
              (task.blocked_by?.length ?? 0) > 0
                ? `ממתין על ${task.blocked_by.length} משימות אחרות`
                : "חסום"
            }
          >
            🔒
          </span>
        )}
        <Link
          href={`/tasks/${encodeURIComponent(task.id)}`}
          className="kanban-card-title"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {task.title || "(ללא כותרת)"}
        </Link>
      </div>
      {(task.company || task.project) && (
        <div className="kanban-card-project">
          {task.company && <span>{task.company}</span>}
          {task.company && task.project && <span aria-hidden> · </span>}
          {task.project && <span>{task.project}</span>}
        </div>
      )}
      {hasChips && (
        <div className="kanban-card-chips">
          {isNew && (
            <span className="kanban-card-new-chip" title="נוצרה ב־24 שעות האחרונות">
              🆕 חדש
            </span>
          )}
          {showPriorityChip && (
            <span
              className={`kanban-card-priority-chip ${priorityClass}`}
              title="דחיפות"
            >
              {priorityClass === "high" ? "🔥 גבוהה" : "⏬ נמוכה"}
            </span>
          )}
          {task.campaign && (
            <span className="tasks-campaign-chip" title="בריף">
              📣 {task.campaign}
            </span>
          )}
          {task.round_number > 1 && (
            <span className="tasks-round-chip" title="סבב תיקונים">
              סבב #{task.round_number}
            </span>
          )}
        </div>
      )}
      <div className="kanban-card-foot">
        {task.requested_date && (
          <span className="kanban-card-date" title="תאריך מבוקש">
            📅 {task.requested_date}
          </span>
        )}
        {peopleVisible.length > 0 && (
          <span className="kanban-card-people" aria-label="מעורבים">
            {peopleVisible.map((p) => {
              const isHighlighted =
                highlightRole !== null && p.roles.includes(highlightRole);
              return (
                <span
                  key={p.email}
                  className={`kanban-card-person${isHighlighted ? " is-highlighted" : ""}`}
                  title={buildPersonTooltip(p)}
                >
                  <Avatar name={p.email} title={buildPersonTooltip(p)} size={22} />
                </span>
              );
            })}
            {peopleOverflow > 0 && (
              <span className="kanban-card-assignees-more">+{peopleOverflow}</span>
            )}
          </span>
        )}
      </div>
    </article>
  );
}

/* ── People-involved per card ──────────────────────────────────────
 *
 * Each task has up to 4 distinct role slots: author, approver,
 * project_manager, assignee[]. The card surfaces ALL of them as a
 * single ordered avatar row, deduped by email so a person who fills
 * multiple roles (e.g. author + assignee) shows up once with a
 * combined tooltip ("מבצע · גם כותב").
 *
 * Status drives which role gets a highlighted ring on its avatar:
 *   awaiting_handling | in_progress  → assignees
 *   awaiting_clarification           → author (the task issuer)
 *   awaiting_approval                → approver
 *   done | cancelled | draft         → no highlight
 */
type PersonInvolved = { email: string; name: string; roles: string[] };

const ROLE_LABELS: Record<string, string> = {
  author: "כותב",
  approver: "מאשר",
  project_manager: "מנהל פרויקט",
  assignee: "מבצע",
};

const STATUS_HIGHLIGHT_ROLE: Record<WorkTaskStatus, string | null> = {
  draft: null,
  awaiting_handling: "assignee",
  in_progress: "assignee",
  awaiting_clarification: "author",
  awaiting_approval: "approver",
  done: null,
  cancelled: null,
  // Blocked tasks have an assignee but they can't act yet — highlighting
  // them as "yours" would imply actionable work. Leave null so the
  // card renders neutrally; the 🔒 badge already signals waiting state.
  blocked: null,
};

function buildPeopleInvolved(
  task: WorkTask,
  peopleByEmail: Map<string, TasksPerson>,
): PersonInvolved[] {
  // Order in this list determines visual order on the card (RTL flow
  // puts the first one rightmost).
  const ordered: { email: string; role: string }[] = [];
  if (task.author_email)
    ordered.push({ email: task.author_email.toLowerCase().trim(), role: "author" });
  if (task.approver_email)
    ordered.push({
      email: task.approver_email.toLowerCase().trim(),
      role: "approver",
    });
  if (task.project_manager_email)
    ordered.push({
      email: task.project_manager_email.toLowerCase().trim(),
      role: "project_manager",
    });
  for (const a of task.assignees || []) {
    const email = String(a || "").toLowerCase().trim();
    if (email) ordered.push({ email, role: "assignee" });
  }
  // Dedupe + merge roles, preserving first-seen order.
  const seen = new Map<string, PersonInvolved>();
  for (const { email, role } of ordered) {
    if (!email) continue;
    const existing = seen.get(email);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
    } else {
      const p = peopleByEmail.get(email);
      seen.set(email, {
        email,
        name: p?.name || email.split("@")[0] || email,
        roles: [role],
      });
    }
  }
  return Array.from(seen.values());
}

/** Tooltip line: "<name> — <primary role> · גם <other> · גם <other>"
 *  Reads naturally in Hebrew when the same person fills multiple
 *  roles. Single-role case collapses to just "<name> — <role>". */
function buildPersonTooltip(p: PersonInvolved): string {
  const labels = p.roles.map((r) => ROLE_LABELS[r] || r);
  const [primary, ...rest] = labels;
  let body = primary || "";
  if (rest.length) body += " · גם " + rest.join(" · גם ");
  return `${p.name} — ${body}`;
}

/* ── Custom collision detection ────────────────────────────────────
 *
 * Three-tier strategy: pointerWithin → rectIntersection → closestCorners.
 *
 * Why not just closestCorners (the dnd-kit default)?
 *   - Empty (slim 7em) columns have small bounding boxes. When the
 *     cursor is in the bottom of a slim column, the column's nearest
 *     CORNER (top or bottom of its slim rect) is actually further
 *     from the cursor than a card-corner in an adjacent FULL column.
 *     closestCorners then picks the neighbor — drop lands in the
 *     wrong column. User reproduced this as "only the center of
 *     empty columns accepts drops".
 *   - At borderline positions closestCorners can flip its choice
 *     per pointermove, which toggled isOver and made the empty
 *     column flicker between expanded / collapsed mid-drag.
 *
 * pointerWithin: cursor inside a droppable's rect → that wins.
 *   Direct match for "drop where I'm pointing" intent. No corner
 *   distance ambiguity, no flicker. Returns ALL droppables the
 *   cursor is inside (the column rect + any sortable-card rect
 *   inside it); the existing onDragEnd already prefers the column
 *   when overId starts with 'col:' and the card otherwise, so the
 *   resolution is correct either way.
 *
 * Fallbacks (rectIntersection, closestCorners): kick in only when
 * the user drops in a GAP between columns — pointer not inside any
 * droppable. Keeps previous behavior for those edge cases instead
 * of silently dropping the move.
 */
const kanbanCollisionDetection: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length > 0) return within;
  const intersecting = rectIntersection(args);
  if (intersecting.length > 0) return intersecting;
  return closestCorners(args);
};
