"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { WorkTask, WorkTaskStatus } from "@/lib/appsScript";

type Props = {
  tasks: WorkTask[];
  /** YYYY-MM (e.g. "2026-04"). When omitted, defaults to today's
   *  month. Honored from the URL via /tasks?month=YYYY-MM so links
   *  to a specific month survive refreshes. */
  initialMonth?: string;
  /** Existing search params on /tasks. We preserve everything except
   *  `month`, so prev/next month navigation keeps the user's filters
   *  intact. */
  searchParams?: Record<string, string | undefined>;
  /** When true, done + cancelled events render with stronger fade
   *  (opacity .25 vs the baseline .55/.65) so the user's eye lands
   *  on active work first. Per-cell `(N עברו)` chip lets the user
   *  un-dim that cell on demand. */
  hideArchived?: boolean;
};

/** Hebrew weekday labels — Sunday-first to match Israeli calendars. */
const WEEKDAYS_HE = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

/** Hebrew month names for the page heading. */
const MONTHS_HE = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
];

/** Visual ordering of statuses on a day — most urgent first so the
 *  3-task cap surfaces what matters when overflow kicks in. */
const STATUS_PRIORITY: Record<WorkTaskStatus, number> = {
  awaiting_clarification: 1,
  in_progress: 2,
  awaiting_handling: 3,
  awaiting_approval: 4,
  // Blocked tasks sort below the active set (user can't act on them)
  // but above the terminal set (they're still alive in the chain).
  blocked: 7,
  done: 9,
  cancelled: 10,
  draft: 11,
};

const MAX_PER_CELL = 3;

/**
 * Month-grid calendar view of /tasks. Each task with a `requested_date`
 * appears on its day cell, colored by status. Tasks without a requested
 * date collect under the grid in a "ללא תאריך" panel.
 *
 * Navigation:
 *   - prev / next month + "היום" reset, all via URL `?month=YYYY-MM`.
 *   - Clicking a task chip → /tasks/[id].
 *   - Clicking a day cell → expand drawer in a popover (max 3 chips
 *     visible per cell; "+N" overflow opens the day drawer).
 *
 * Drag-to-reschedule:
 *   - Each chip is draggable, each day cell is droppable.
 *   - Drop sets task.requested_date to the target day's YYYY-MM-DD.
 *   - Drop on the "ללא תאריך" panel clears requested_date.
 *   - Optimistic local update; reverts + shows error if the server
 *     rejects (e.g. transient network failure).
 *   - 8px activation distance keeps a click-to-open from accidentally
 *     starting a drag, mirroring TasksKanban's tuning.
 */
export default function TasksCalendar({
  tasks: initialTasks,
  initialMonth,
  searchParams,
  hideArchived = false,
}: Props) {
  const [activeDay, setActiveDay] = useState<string>("");
  // Per-cell un-dim: when hideArchived is on, terminal-state events
  // render extra-faded — clicking the cell's "(N עברו)" chip adds
  // that day to this set so the user can read them without flipping
  // the global pref. Cleared on navigation (component unmount).
  const [unmutedDays, setUnmutedDays] = useState<Set<string>>(new Set());
  function toggleUnmute(iso: string) {
    setUnmutedDays((cur) => {
      const next = new Set(cur);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  }
  // Lift tasks to local state so drag-to-reschedule can update the
  // grid optimistically before the server roundtrip lands. The parent
  // page passes in the server-rendered list as the seed.
  const [tasks, setTasks] = useState(initialTasks);
  const [error, setError] = useState<string | null>(null);

  // dnd-kit sensors. Same activation thresholds as the table view so
  // a click on a chip's title still navigates to /tasks/[id] without
  // accidentally grabbing the chip.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
    useSensor(KeyboardSensor),
  );

  const today = useMemo(() => toIsoDate(new Date()), []);
  const month = parseMonth(initialMonth) || monthFromIso(today);
  const grid = useMemo(() => buildMonthGrid(month), [month]);

  // Bucket tasks by their requested_date day key (YYYY-MM-DD). Tasks
  // with no requested_date go to the "no date" bucket. Sort each bucket
  // by status priority so the per-cell overflow surfaces urgent tasks.
  const { byDay, undated } = useMemo(() => {
    const byDay = new Map<string, WorkTask[]>();
    const undated: WorkTask[] = [];
    for (const t of tasks) {
      const day = (t.requested_date || "").slice(0, 10);
      if (!day) {
        undated.push(t);
        continue;
      }
      const list = byDay.get(day) || [];
      list.push(t);
      byDay.set(day, list);
    }
    for (const list of byDay.values()) {
      list.sort(
        (a, b) =>
          (STATUS_PRIORITY[a.status] || 99) -
          (STATUS_PRIORITY[b.status] || 99),
      );
    }
    undated.sort(
      (a, b) =>
        (STATUS_PRIORITY[a.status] || 99) - (STATUS_PRIORITY[b.status] || 99),
    );
    return { byDay, undated };
  }, [tasks]);

  /** Drop handler — `event.over.id` is the droppable id we set below
   *  ("day:<iso>" for a day cell, "undated" for the panel). The
   *  active draggable's id is the task id. */
  async function onDragEnd(e: DragEndEvent) {
    setError(null);
    if (!e.over) return;
    const taskId = String(e.active.id);
    const overId = String(e.over.id);
    const dragged = tasks.find((t) => t.id === taskId);
    if (!dragged) return;

    let nextDate = "";
    if (overId === "undated") {
      nextDate = "";
    } else if (overId.startsWith("day:")) {
      nextDate = overId.slice(4);
    } else {
      return;
    }
    const currentDate = (dragged.requested_date || "").slice(0, 10);
    if (currentDate === nextDate) return;

    // Optimistic. We replace just the requested_date so the chip
    // hops to its new cell immediately; the rest of the row is
    // reused until the next page-render reconciles against the
    // server.
    const prev = tasks;
    const next = tasks.map((t) =>
      t.id === taskId ? { ...t, requested_date: nextDate } : t,
    );
    setTasks(next);

    try {
      const res = await fetch("/api/worktasks/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: taskId,
          patch: {
            requested_date: nextDate,
            note: nextDate
              ? `calendar: reschedule → ${nextDate}`
              : "calendar: clear requested date",
          },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Update failed (${res.status})`);
      }
    } catch (err) {
      setTasks(prev);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const totalInMonth = useMemo(() => {
    let n = 0;
    for (const week of grid) {
      for (const day of week) {
        if (day.inMonth) n += byDay.get(day.iso)?.length ?? 0;
      }
    }
    return n;
  }, [byDay, grid]);

  const prevMonthHref = buildHref(searchParams, {
    month: shiftMonth(month, -1),
  });
  const nextMonthHref = buildHref(searchParams, {
    month: shiftMonth(month, +1),
  });
  const todayHref = buildHref(searchParams, { month: "" });

  const [year, monthIdx] = monthParts(month);
  const monthLabel = `${MONTHS_HE[monthIdx]} ${year}`;

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <section className="tasks-calendar">
        <header className="tasks-calendar-head">
          <div className="tasks-calendar-nav">
            <Link href={prevMonthHref} className="btn-ghost btn-sm" scroll={false}>
              ‹ קודם
            </Link>
            <h2 className="tasks-calendar-title">{monthLabel}</h2>
            <Link href={nextMonthHref} className="btn-ghost btn-sm" scroll={false}>
              הבא ›
            </Link>
          </div>
          <div className="tasks-calendar-meta">
            <span className="muted">{totalInMonth} משימות בחודש זה</span>
            <Link href={todayHref} className="btn-ghost btn-sm" scroll={false}>
              היום
            </Link>
          </div>
        </header>

        {error && (
          <div className="tasks-calendar-error" role="alert">
            ⚠️ {error}
            <button
              type="button"
              className="tasks-calendar-error-dismiss"
              onClick={() => setError(null)}
              aria-label="סגור"
            >
              ×
            </button>
          </div>
        )}

        <div
          className="tasks-calendar-grid"
          role="grid"
          aria-label={`לוח שנה ${monthLabel}`}
        >
          <div className="tasks-calendar-weekrow tasks-calendar-weekrow-head" role="row">
            {WEEKDAYS_HE.map((d) => (
              <div key={d} className="tasks-calendar-weekday" role="columnheader">
                {d}
              </div>
            ))}
          </div>
          {grid.map((week, wi) => (
            <div key={wi} className="tasks-calendar-weekrow" role="row">
              {week.map((day) => {
                const dayTasks = byDay.get(day.iso) || [];
                const visible = dayTasks.slice(0, MAX_PER_CELL);
                const overflow = dayTasks.length - visible.length;
                const isToday = day.iso === today;
                const isOpen = activeDay === day.iso;
                const archivedInDay = dayTasks.filter(
                  (t) => t.status === "done" || t.status === "cancelled",
                ).length;
                const dimArchived =
                  hideArchived && !unmutedDays.has(day.iso);
                return (
                  <DroppableDayCell
                    key={day.iso}
                    iso={day.iso}
                    inMonth={day.inMonth}
                    isToday={isToday}
                    isOpen={isOpen}
                    dimArchived={dimArchived}
                  >
                    <div className="tasks-calendar-cell-head">
                      <span className="tasks-calendar-day-num">{day.dayNum}</span>
                      {dayTasks.length > 0 && (
                        <span
                          className="tasks-calendar-day-count"
                          title={`${dayTasks.length} משימות`}
                          aria-label={`${dayTasks.length} משימות`}
                        >
                          {dayTasks.length}
                        </span>
                      )}
                    </div>
                    <ul className="tasks-calendar-events">
                      {visible.map((t) => (
                        <li key={t.id}>
                          <DraggableEvent task={t} />
                        </li>
                      ))}
                      {overflow > 0 && (
                        <li>
                          <button
                            type="button"
                            className="tasks-calendar-overflow"
                            onClick={() =>
                              setActiveDay(isOpen ? "" : day.iso)
                            }
                            aria-expanded={isOpen}
                          >
                            {isOpen ? "סגור" : `+${overflow} נוספות`}
                          </button>
                        </li>
                      )}
                      {hideArchived && archivedInDay > 0 && (
                        <li>
                          <button
                            type="button"
                            className="tasks-calendar-archive-hint"
                            onClick={() => toggleUnmute(day.iso)}
                            title={
                              unmutedDays.has(day.iso)
                                ? "החזר עמעום"
                                : `${archivedInDay} בארכיון — לחץ להבלטה`
                            }
                          >
                            {unmutedDays.has(day.iso)
                              ? "🔅 עמעם"
                              : `📦 ${archivedInDay} עברו`}
                          </button>
                        </li>
                      )}
                    </ul>
                    {isOpen && overflow > 0 && (
                      <ul className="tasks-calendar-overflow-list">
                        {dayTasks.slice(MAX_PER_CELL).map((t) => (
                          <li key={t.id}>
                            <DraggableEvent task={t} hideFlag />
                          </li>
                        ))}
                      </ul>
                    )}
                  </DroppableDayCell>
                );
              })}
            </div>
          ))}
        </div>

        <UndatedPanel undated={undated} />

        {tasks.length === 0 && (
          <div className="empty">
            <span className="emoji" aria-hidden>
              🌿
            </span>
            אין משימות תואמות לסינון.
          </div>
        )}
      </section>
    </DndContext>
  );
}

/** A day cell — the droppable target for drag-to-reschedule. The
 *  droppable id encodes the date (`day:YYYY-MM-DD`); the drop handler
 *  pulls the date out and patches the task's requested_date.
 *
 *  `dimArchived` toggles a CSS hook (`is-dim-archived`) that lets
 *  the calendar's stylesheet fade done/cancelled chips inside this
 *  cell more aggressively when the user has hide_archived turned
 *  on. Click the cell's `(N עברו)` chip in TasksCalendar to flip
 *  the dim state for one cell at a time. */
function DroppableDayCell({
  iso,
  inMonth,
  isToday,
  isOpen,
  dimArchived = false,
  children,
}: {
  iso: string;
  inMonth: boolean;
  isToday: boolean;
  isOpen: boolean;
  dimArchived?: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${iso}` });
  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      className={`tasks-calendar-cell${inMonth ? "" : " is-other-month"}${
        isToday ? " is-today" : ""
      }${isOpen ? " is-open" : ""}${isOver ? " is-drop-target" : ""}${
        dimArchived ? " is-dim-archived" : ""
      }`}
    >
      {children}
    </div>
  );
}

/** A single event chip — draggable so users can re-schedule by
 *  pulling it onto another day. The 8px MouseSensor activation
 *  threshold keeps a normal click on the title firing the Link
 *  navigation; only meaningful pointer movement starts a drag. */
function DraggableEvent({
  task,
  hideFlag = false,
}: {
  task: WorkTask;
  hideFlag?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: task.id });
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.45 : undefined,
    cursor: "grab",
  };
  return (
    <Link
      ref={setNodeRef}
      href={`/tasks/${encodeURIComponent(task.id)}`}
      style={style}
      className={`tasks-calendar-event tasks-calendar-event-${task.status}`}
      title={`${task.project} · ${task.title}${
        task.priority === 1 ? " · 🔥 גבוהה" : ""
      }${" · גרור ליום אחר כדי לדחות"}`}
      {...attributes}
      {...listeners}
      // Stop propagation so the underlying gridcell's click doesn't
      // double-handle. dnd-kit's listeners already swallow the event
      // when a drag starts, so this only matters for plain clicks.
      onClick={(e) => e.stopPropagation()}
    >
      {task.priority === 1 && !hideFlag && (
        <span aria-hidden className="tasks-calendar-event-flag">
          🔥
        </span>
      )}
      <span className="tasks-calendar-event-title">{task.title}</span>
    </Link>
  );
}

/** "ללא תאריך" panel — also acts as a droppable target. Dropping a
 *  scheduled task here clears its requested_date. The chips inside
 *  are themselves draggable so a user can re-schedule a previously
 *  un-dated task by pulling it to a day. */
function UndatedPanel({ undated }: { undated: WorkTask[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: "undated" });
  if (undated.length === 0) {
    // Render an empty zone too so users discover the "drop here to
    // unschedule" affordance even when there's nothing un-dated yet.
    return (
      <div
        ref={setNodeRef}
        className={`tasks-calendar-undated tasks-calendar-undated-empty${
          isOver ? " is-drop-target" : ""
        }`}
        aria-label="גרור לכאן כדי להסיר תאריך"
      >
        <span className="muted">
          {isOver ? "שחרר כדי להסיר תאריך" : "גרור משימה לכאן כדי להסיר תאריך"}
        </span>
      </div>
    );
  }
  return (
    <details
      ref={setNodeRef}
      className={`tasks-calendar-undated${isOver ? " is-drop-target" : ""}`}
      open
    >
      <summary>
        ללא תאריך מבוקש{" "}
        <span className="muted">({undated.length})</span>
      </summary>
      <ul className="tasks-calendar-undated-list">
        {undated.map((t) => (
          <li key={t.id}>
            <DraggableEvent task={t} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/* ─── Date helpers ───────────────────────────────────────────────────
   Local-time arithmetic on Date so the month grid stays anchored to
   the user's wall clock — important since requested_date is stored as
   a YYYY-MM-DD wall-time string, not a UTC instant. */

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function monthFromIso(iso: string): string {
  return iso.slice(0, 7);
}

function parseMonth(s: string | undefined): string {
  if (!s) return "";
  const m = s.match(/^(\d{4})-(\d{2})$/);
  if (!m) return "";
  return s;
}

function monthParts(month: string): [year: number, monthIdx: number] {
  const [y, m] = month.split("-").map(Number);
  return [y, m - 1];
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = monthParts(month);
  const d = new Date(y, m + delta, 1);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

type GridDay = { iso: string; dayNum: number; inMonth: boolean };

/** Build a 6-row × 7-col grid for the given month. Each row is a week
 *  starting Sunday; cells outside the month are still rendered (greyed)
 *  so the grid keeps its rectangular shape, matching how Google
 *  Calendar / Apple Calendar render the month view. */
function buildMonthGrid(month: string): GridDay[][] {
  const [y, m] = monthParts(month);
  const first = new Date(y, m, 1);
  const startWeekday = first.getDay(); // 0 = Sunday
  const start = new Date(y, m, 1 - startWeekday);
  const grid: GridDay[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < 6; w++) {
    const week: GridDay[] = [];
    for (let d = 0; d < 7; d++) {
      week.push({
        iso: toIsoDate(cursor),
        dayNum: cursor.getDate(),
        inMonth: cursor.getMonth() === m,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    grid.push(week);
  }
  return grid;
}

function buildHref(
  current: Record<string, string | undefined> | undefined,
  overrides: Record<string, string>,
): string {
  const merged: Record<string, string> = {};
  if (current) {
    for (const [k, v] of Object.entries(current)) {
      if (v) merged[k] = v;
    }
  }
  // Always force view=calendar so prev/next/today links don't fall back
  // to the table view.
  merged.view = "calendar";
  for (const [k, v] of Object.entries(overrides)) {
    if (v === "") delete merged[k];
    else merged[k] = v;
  }
  // No "month" => default to current month (avoid stale cached URLs).
  if (!merged.month) delete merged.month;
  const qs = new URLSearchParams(merged).toString();
  return qs ? `/tasks?${qs}` : "/tasks";
}
