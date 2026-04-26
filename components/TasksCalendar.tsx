"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
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
 * No drag for status change here — calendar is read-mostly for now.
 * Adding click-to-reschedule is a separate follow-up because it needs
 * server writes + an optimistic-update layer.
 */
export default function TasksCalendar({
  tasks,
  initialMonth,
  searchParams,
}: Props) {
  const [activeDay, setActiveDay] = useState<string>("");

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
              return (
                <div
                  key={day.iso}
                  role="gridcell"
                  className={`tasks-calendar-cell${
                    day.inMonth ? "" : " is-other-month"
                  }${isToday ? " is-today" : ""}${isOpen ? " is-open" : ""}`}
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
                        <Link
                          href={`/tasks/${encodeURIComponent(t.id)}`}
                          className={`tasks-calendar-event tasks-calendar-event-${t.status}`}
                          title={`${t.project} · ${t.title}${
                            t.priority === 1 ? " · 🔥 גבוהה" : ""
                          }`}
                        >
                          {t.priority === 1 && (
                            <span aria-hidden className="tasks-calendar-event-flag">
                              🔥
                            </span>
                          )}
                          <span className="tasks-calendar-event-title">{t.title}</span>
                        </Link>
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
                  </ul>
                  {isOpen && overflow > 0 && (
                    <ul className="tasks-calendar-overflow-list">
                      {dayTasks.slice(MAX_PER_CELL).map((t) => (
                        <li key={t.id}>
                          <Link
                            href={`/tasks/${encodeURIComponent(t.id)}`}
                            className={`tasks-calendar-event tasks-calendar-event-${t.status}`}
                          >
                            <span className="tasks-calendar-event-title">{t.title}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {undated.length > 0 && (
        <details className="tasks-calendar-undated">
          <summary>
            ללא תאריך מבוקש{" "}
            <span className="muted">({undated.length})</span>
          </summary>
          <ul className="tasks-calendar-undated-list">
            {undated.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/tasks/${encodeURIComponent(t.id)}`}
                  className={`tasks-calendar-event tasks-calendar-event-${t.status}`}
                >
                  <span className="tasks-calendar-event-title">
                    {t.project} · {t.title}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}

      {tasks.length === 0 && (
        <div className="empty">
          <span className="emoji" aria-hidden>
            🌿
          </span>
          אין משימות תואמות לסינון.
        </div>
      )}
    </section>
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
