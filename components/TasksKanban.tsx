"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { WorkTask, WorkTaskStatus, TasksPerson } from "@/lib/appsScript";
import { STATUS_LABELS, TRANSITIONS } from "@/components/TaskStatusCell";
import Avatar from "@/components/Avatar";
import { fireConfetti, firePulse } from "@/lib/confetti";

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
}: Props) {
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
    useSensor(KeyboardSensor),
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
    // Newest-first within each column — the column IS the grouping axis,
    // so within-column ordering is just chronological.
    for (const k of Object.keys(map)) {
      map[k].sort((a, b) => b.created_at.localeCompare(a.created_at));
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
    // Drop targets are columns (id = `col:<status>`) or other cards
    // (id = task.id). For a card-on-card drop, treat it as a drop on
    // that card's column.
    let targetStatus: WorkTaskStatus | null = null;
    if (overId.startsWith("col:")) {
      targetStatus = overId.slice(4) as WorkTaskStatus;
    } else {
      const target = tasks.find((t) => t.id === overId);
      if (target) targetStatus = target.status;
    }
    if (!targetStatus) return;

    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    if (task.status === targetStatus) return;

    // Validate against the same transition table the inline status
    // pill uses. If the drop is illegal we don't even attempt the
    // server write — surface a one-line hint and the card snaps back.
    const allowed = (TRANSITIONS[task.status] || []).some(
      (t) => t.to === targetStatus,
    );
    if (!allowed) {
      setError(
        `לא ניתן להעביר מ-"${STATUS_LABELS[task.status]}" ל-"${STATUS_LABELS[targetStatus]}".`,
      );
      return;
    }

    // Optimistic local update — flips the card into the target column
    // before the fetch round-trip lands.
    const prev = tasks;
    const next = tasks.map((t) =>
      t.id === id ? { ...t, status: targetStatus! } : t,
    );
    setTasks(next);

    try {
      const res = await fetch("/api/worktasks/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          patch: {
            status: targetStatus,
            note: `kanban: ${STATUS_LABELS[targetStatus]}`,
          },
        }),
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
      if (targetStatus === "done") {
        fireConfetti();
      } else if (targetStatus === "awaiting_approval") {
        firePulse();
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
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
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
        {COLUMNS.map((col) => (
          <KanbanColumn
            key={col.key}
            column={col}
            tasks={byStatus[col.key] || []}
            peopleByEmail={peopleByEmail}
          />
        ))}
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
  return (
    <section
      ref={setNodeRef}
      className={`kanban-column kanban-column-${column.tone}${isOver ? " is-drop-target" : ""}`}
      aria-label={column.label}
    >
      <header className="kanban-column-head">
        <span className="kanban-column-label">{column.label}</span>
        <span className="kanban-column-count">{tasks.length}</span>
      </header>
      <div className="kanban-column-body">
        {tasks.length === 0 ? (
          <div className="kanban-column-empty">אין משימות</div>
        ) : (
          tasks.map((t) => (
            <KanbanCard key={t.id} task={t} peopleByEmail={peopleByEmail} />
          ))
        )}
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
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });

  // While the original card is being dragged, hide it from its column
  // so only the DragOverlay clone is visible. Otherwise the user sees
  // two copies of the card until drop.
  const style: React.CSSProperties = {};
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
  const hasChips =
    task.brief || task.campaign || task.round_number > 1 || showPriorityChip;
  const assignees = task.assignees || [];

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`kanban-card kanban-card-edge-${priorityClass}${isOverlay ? " is-overlay" : ""}${isDragging ? " is-dragging" : ""}`}
      {...attributes}
      {...listeners}
    >
      <div className="kanban-card-header">
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
          {showPriorityChip && (
            <span
              className={`kanban-card-priority-chip ${priorityClass}`}
              title="עדיפות"
            >
              {priorityClass === "high" ? "🔥 גבוהה" : "⏬ נמוכה"}
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
        </div>
      )}
      <div className="kanban-card-foot">
        {task.requested_date && (
          <span className="kanban-card-date" title="תאריך מבוקש">
            📅 {task.requested_date}
          </span>
        )}
        {assignees.length > 0 && (
          <span className="kanban-card-assignees" aria-label="עובדים">
            {assignees.slice(0, 3).map((email) => {
              const p = peopleByEmail.get(email.toLowerCase());
              return (
                <Avatar
                  key={email}
                  name={email}
                  title={p?.name || email}
                  size={22}
                />
              );
            })}
            {assignees.length > 3 && (
              <span className="kanban-card-assignees-more">+{assignees.length - 3}</span>
            )}
          </span>
        )}
      </div>
    </article>
  );
}
