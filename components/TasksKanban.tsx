"use client";

import { useEffect, useMemo, useState } from "react";
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
import {
  STATUS_LABELS,
  STATUS_EMOJIS,
  responsibleEmailForStatus,
} from "@/components/TaskStatusCell";
import Avatar from "@/components/Avatar";
import { useTaskPreview } from "@/components/TaskPreviewProvider";
import { fireConfetti, firePulse } from "@/lib/confetti";
import { compareByRank, computeInsertRank } from "@/lib/taskRank";
import { displayProjectOrCompany } from "@/lib/personalLabel";
import TaskTransitionModal, {
  getModalTransitionKind,
} from "@/components/TaskTransitionModal";
import { isRejectionPending } from "@/lib/taskRejectionPending";
import { TASK_USER_STATE_LABELS } from "@/lib/taskUserState";

/** Same classification as the table view's TasksQueue. Pulled inline
 *  so the kanban card can render a matching parent/child visual cue
 *  when the user toggles the עטיפות filter on. */
type KanbanCardKind = "umbrella" | "parallel-child" | "chain-child" | null;
function classifyKanbanTask(task: WorkTask): KanbanCardKind {
  if (task.is_umbrella) return "umbrella";
  const hasEdges =
    (task.blocks?.length ?? 0) > 0 || (task.blocked_by?.length ?? 0) > 0;
  if (task.umbrella_id) return hasEdges ? "chain-child" : "parallel-child";
  return hasEdges ? "chain-child" : null;
}

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
  /** Mirror of TasksQueue's prop — see lib/taskUserState. Cards in
   *  this map get the accent + leading chip ("תויגת" / "ממתין לאישורך"
   *  / "ממתין לבירורך"). Empty / undefined → no highlights. */
  userStateByTaskId?: ReadonlyMap<string, "tagged" | "awaiting_approval" | "awaiting_clarification">;
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
  userStateByTaskId,
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
  // Re-sync from props when the parent re-renders with a new task
  // list (URL-driven filter toggles, etc.). Mirrors the fix in
  // TasksQueue.tsx — without this, useState's mount-time init would
  // hold the old data even after `router.refresh()` brought fresh
  // server-rendered props.
  useEffect(() => {
    setTasks(initialTasks);
  }, [initialTasks]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Submission modal target — set when a drag triggers a transition
  // that needs a deliverable. Covers drops INTO awaiting_approval /
  // awaiting_clarification AND drops OUT of awaiting_approval into
  // in_progress / awaiting_handling (approver bouncing work back).
  // The modal handles the comment + status patch + router.refresh()
  // itself; we skip the optimistic local state update so a cancel
  // leaves the card where it was.
  const [modalTarget, setModalTarget] = useState<{
    taskId: string;
    fromStatus: WorkTaskStatus;
    newStatus: WorkTaskStatus;
  } | null>(null);

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
    //
    // Direction-aware insert anchor for SAME-COLUMN reorders: dnd-kit's
    // verticalListSortingStrategy mirrors `arrayMove(items, oldIdx, newIdx)`
    // so the dragged card lands AT over's position. Always inserting
    // before over (the previous behavior) made a one-slot-down drag
    // compute newRank === task.rank → early return → snap back. Cross-
    // column drops and "drop on empty column body" don't have a from-
    // index in the target column, so they keep the simple "insert before"
    // path (or null = append).
    const sameColumn = task.status === targetStatus;
    if (sameColumn && insertBeforeId) {
      const fullCol = (byStatus[targetStatus] || []).slice().sort(compareByRank);
      const fromIdx = fullCol.findIndex((t) => t.id === id);
      const toIdx = fullCol.findIndex((t) => t.id === insertBeforeId);
      if (fromIdx !== -1 && toIdx !== -1 && fromIdx < toIdx) {
        // Dragging DOWN within the same column → land AFTER over,
        // i.e. insertBefore the row that follows over in the filtered
        // list. Null when over is the last row (append).
        const filteredCol = fullCol.filter((t) => t.id !== id);
        const overInFiltered = filteredCol.findIndex(
          (t) => t.id === insertBeforeId,
        );
        insertBeforeId = filteredCol[overInFiltered + 1]?.id ?? null;
      }
    }
    const colTasks = (byStatus[targetStatus] || []).filter((t) => t.id !== id);
    const newRank = computeInsertRank(colTasks, insertBeforeId);

    const sameRank = task.rank === newRank;
    if (sameColumn && sameRank) return;

    // Submission / clarification / rejection transitions all need a
    // deliverable — open the modal instead of patching directly.
    // Same flow as TaskStatusCell / TaskStatusActions: skip the
    // optimistic state update so a cancelled modal leaves the card
    // where it was. Drops INTO ממתין לאישור / ממתין לבירור AND drops
    // OUT of ממתין לאישור into in_progress / awaiting_handling all
    // qualify; the shared helper covers the matrix.
    if (!sameColumn && getModalTransitionKind(task.status, targetStatus)) {
      setModalTarget({
        taskId: id,
        fromStatus: task.status,
        newStatus: targetStatus,
      });
      return;
    }

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
    if (!sameColumn) {
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
      if (!sameColumn) {
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
    <>
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
              userStateByTaskId={userStateByTaskId}
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
    {modalTarget && (
      <TaskTransitionModal
        taskId={modalTarget.taskId}
        fromStatus={modalTarget.fromStatus}
        newStatus={modalTarget.newStatus}
        open={!!modalTarget}
        onClose={() => {
          const wasApproval = modalTarget?.newStatus === "awaiting_approval";
          setModalTarget(null);
          if (wasApproval) firePulse();
        }}
      />
    )}
    </>
  );
}

/* ── Column ──────────────────────────────────────────────────────── */

function KanbanColumn({
  column,
  tasks,
  peopleByEmail,
  userStateByTaskId,
}: {
  column: ColumnDef;
  tasks: WorkTask[];
  peopleByEmail: Map<string, TasksPerson>;
  userStateByTaskId?: ReadonlyMap<string, "tagged" | "awaiting_approval" | "awaiting_clarification">;
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
              <KanbanCard
                key={t.id}
                task={t}
                peopleByEmail={peopleByEmail}
                userState={userStateByTaskId?.get(t.id) ?? null}
              />
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
  userState = null,
}: {
  task: WorkTask;
  peopleByEmail: Map<string, TasksPerson>;
  isOverlay?: boolean;
  userState?: "tagged" | "awaiting_approval" | "awaiting_clarification" | null;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });
  const preview = useTaskPreview();

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
  // Umbrella/child kind — when the user has surfaced umbrellas (only
  // visible when ?umbrellas=1), this drives the parent/child visual
  // cue per card. Same classification as the table view in
  // TasksQueue so the two views stay in sync.
  const cardKind = classifyKanbanTask(task);
  const hasChips =
    isNew ||
    task.campaign ||
    task.round_number > 1 ||
    showPriorityChip ||
    cardKind !== null;
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

  // Per-card class hooks for the umbrella/child styling (purple tint
  // on umbrella cards, smaller-text + indented on children). Mirrors
  // the row-level treatment in the table view.
  const kindClass =
    cardKind === "umbrella"
      ? " kanban-card-umbrella"
      : cardKind === "parallel-child"
        ? " kanban-card-child kanban-card-parallel-child"
        : cardKind === "chain-child"
          ? " kanban-card-child kanban-card-chain-child"
          : "";
  return (
    <article
      ref={setNodeRef}
      style={style}
      // data-user-state drives the card's tinted background + leading
      // edge accent + chip (see globals.css → .kanban-card[data-user-state=…]).
      data-user-state={userState ?? undefined}
      className={`kanban-card kanban-card-edge-${priorityClass}${kindClass}${isOverlay ? " is-overlay" : ""}${isDragging ? " is-dragging" : ""}`}
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
        {/* Rejection bullet — mirrors the queue's tasks-substatus-rejected
            pill so a rejected card on the kanban also reads "this was
            bounced back" at a glance. Same derivation from
            status_history; auto-clears on the next status change. */}
        {isRejectionPending(task) && (
          <span
            className="tasks-substatus-pill tasks-substatus-rejected kanban-card-rejected-badge"
            title="האישור נדחה — המשימה הוחזרה לתיקון"
          >
            🔄 הוחזר
          </span>
        )}
        {/* "Wants something from YOU" chip — same vocabulary as the
            queue table view. תויגת / ממתין לאישורך / ממתין לבירורך. */}
        {userState && (
          <span
            className={`task-user-state-chip task-user-state-${userState}`}
            title={TASK_USER_STATE_LABELS[userState]}
          >
            {TASK_USER_STATE_LABELS[userState]}
          </span>
        )}
        {/* Owner avatar — same per-status "whose court is the ball in?"
            mapping as the queue's status pill. Kanban doesn't have a
            status pill on the card (the column IS the status), so we
            surface the owner as a header badge instead. The footer's
            kanban-card-person.is-highlighted ring still highlights the
            same person inside the full people roster; this badge just
            makes them glanceable without scanning the avatar cluster. */}
        {(() => {
          const ownerEmail = responsibleEmailForStatus(task);
          if (!ownerEmail) return null;
          const person = peopleByEmail.get(ownerEmail.toLowerCase());
          const display =
            person?.he_name || person?.name || ownerEmail.split("@")[0] || "";
          return (
            <span
              className="kanban-card-owner"
              title={`${display} · אחראי על הסטטוס הנוכחי`}
            >
              <Avatar
                name={ownerEmail}
                title={display}
                role={person?.role}
                size={18}
              />
            </span>
          );
        })()}
        <Link
          href={`/tasks/${encodeURIComponent(task.id)}`}
          className="kanban-card-title"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {task.title || "(ללא כותרת)"}
        </Link>
        {/* Quick-preview eye — same affordance as the queue view's
            👁 button. Mirrors the overall pattern: stopPropagation on
            both the click AND pointerdown so dnd-kit's drag listeners
            on the card body don't intercept the press. */}
        <button
          type="button"
          className="kanban-card-preview-btn"
          title="תצוגה מקדימה — תיאור מלא ופרטים, ללא מעבר עמוד"
          aria-label="תצוגה מקדימה"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            preview.open(task, Array.from(peopleByEmail.values()));
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          👁
        </button>
      </div>
      {(task.company || task.project) && (
        <div className="kanban-card-project">
          {task.company && (
            <span>{displayProjectOrCompany(task.company)}</span>
          )}
          {task.company && task.project && <span aria-hidden> · </span>}
          {task.project && (
            <span>{displayProjectOrCompany(task.project)}</span>
          )}
        </div>
      )}
      {hasChips && (
        <div className="kanban-card-chips">
          {isNew && (
            <span className="kanban-card-new-chip" title="נוצרה ב־24 שעות האחרונות">
              🆕 חדש
            </span>
          )}
          {/* Umbrella/child chips — same vocabulary as the table view
              so a user toggling between views sees the same labels. */}
          {cardKind === "umbrella" && (
            <span
              className="tasks-type-chip tasks-type-chip-umbrella"
              title="שורת עטיפה — מרכזת את כל תתי-המשימות שתחתיה"
            >
              🪆 עטיפה
            </span>
          )}
          {cardKind === "parallel-child" && (
            <span
              className="tasks-type-chip tasks-type-chip-parallel"
              title="תת-משימה מקבילה תחת עטיפה"
            >
              🌂 מקבילה
            </span>
          )}
          {cardKind === "chain-child" && (
            <span
              className="tasks-type-chip tasks-type-chip-chain"
              title="שלב בשרשרת — סדר מסירה אוטומטי"
            >
              🔗 בשרשרת
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
        name:
          p?.he_name || p?.name || email.split("@")[0] || email,
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
