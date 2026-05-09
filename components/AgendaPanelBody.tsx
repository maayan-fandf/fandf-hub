"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { AgendaDay, AgendaItem } from "@/lib/agenda";
import { useTaskPreview } from "@/components/TaskPreviewProvider";

/**
 * Client-side renderer for the agenda. Server hands us a window of
 * days (~yesterday through next week); we display ONE active day at
 * a time and let the user step through with prev/next/Today buttons.
 *
 * Same UX as Google Calendar's mini-panel: the header shows the
 * currently-displayed day; arrows step ±1, "Today" jumps back.
 *
 * Each TASK row carries a 👁 quick-view button that opens the shared
 * TaskPreviewProvider drawer. The button stops the parent <Link>
 * from navigating so the user stays on whatever page hosts the
 * panel.
 */

/** Local Hebrew labels for status pill text. Mirrors the same map
 *  TaskStatusCell exports + TaskPreviewProvider inlines — duplicated
 *  here on purpose so the agenda doesn't depend on importing a
 *  Record from another "use client" module (the bundle path through
 *  the agenda's server parent occasionally lost the export and the
 *  pill rendered "awaiting_handling" instead of the Hebrew). */
const STATUS_LABELS_HE: Record<string, string> = {
  draft: "טיוטה",
  awaiting_handling: "ממתין לטיפול",
  in_progress: "בעבודה",
  awaiting_clarification: "ממתין לבירור",
  awaiting_approval: "ממתין לאישור",
  done: "בוצע",
  cancelled: "בוטל",
  blocked: "חסום",
};

type Props = {
  days: AgendaDay[];
};

export default function AgendaPanelBody({ days }: Props) {
  const todayIdx = useMemo(
    () => Math.max(0, days.findIndex((d) => d.isToday)),
    [days],
  );
  const [activeIdx, setActiveIdx] = useState<number>(todayIdx);
  // Clamp into the available range — users can navigate inside the
  // prefetched window. When they hit an edge the corresponding arrow
  // disables. (Out-of-window navigation = future enhancement; for now
  // the window is wide enough — yesterday + today + 6 ahead.)
  const safeIdx = Math.min(Math.max(activeIdx, 0), days.length - 1);
  const day = days[safeIdx];

  if (!day) {
    return (
      <div className="agenda-panel-empty">
        אין נתוני סדר יום זמינים.
      </div>
    );
  }

  const canPrev = safeIdx > 0;
  const canNext = safeIdx < days.length - 1;

  return (
    <div className="agenda-panel-content">
      {/* Day-switcher header — Today | ◂ ▸ pattern, mirrors Google
          Calendar's mini-panel. The label below shows the currently-
          displayed day so the user knows where they are. */}
      <div className="agenda-panel-nav" role="toolbar" aria-label="ניווט בין ימים">
        <button
          type="button"
          className="agenda-panel-nav-today"
          onClick={() => setActiveIdx(todayIdx)}
          disabled={safeIdx === todayIdx}
          title="חזור להיום"
        >
          היום
        </button>
        <div className="agenda-panel-nav-arrows">
          {/* In RTL the visual prev/next swap, but logical
              "previous day" = older = lower index. Use chevron arrows
              that DON'T flip with direction so they remain
              chronologically intuitive. */}
          <button
            type="button"
            className="agenda-panel-nav-arrow"
            onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
            disabled={!canPrev}
            title="יום קודם"
            aria-label="יום קודם"
          >
            ‹
          </button>
          <button
            type="button"
            className="agenda-panel-nav-arrow"
            onClick={() =>
              setActiveIdx((i) => Math.min(days.length - 1, i + 1))
            }
            disabled={!canNext}
            title="יום הבא"
            aria-label="יום הבא"
          >
            ›
          </button>
        </div>
      </div>
      <div
        className={`agenda-panel-day-banner${
          day.isToday ? " is-today" : ""
        }`}
      >
        <span className="agenda-panel-day-banner-label">{day.dayLabel}</span>
        <span className="agenda-panel-day-banner-date" dir="ltr">
          {formatShortDate(day.date)}
        </span>
      </div>

      {day.items.length === 0 ? (
        <div className="agenda-panel-empty">
          {day.isToday ? "אין משימות להיום ✨" : "אין פריטים ביום זה."}
          {day.isToday && (
            <div className="agenda-panel-empty-hint">
              זמן חופשי לחשוב, ליזום, או לסגור משימות מהמלאי שלך.
            </div>
          )}
        </div>
      ) : (
        <DayList items={day.items} />
      )}
    </div>
  );
}

function DayList({ items }: { items: AgendaItem[] }) {
  // Group items into "with time" and "all day". Items are already
  // sorted upstream — timed first, then all-day. Just slice on the
  // first all-day item to render two sub-headings.
  const firstAllDay = items.findIndex((i) => !i.time);
  const timed = firstAllDay === -1 ? items : items.slice(0, firstAllDay);
  const allDay = firstAllDay === -1 ? [] : items.slice(firstAllDay);

  return (
    <ul className="agenda-panel-list">
      {timed.map((it) => (
        <AgendaRow key={it.id} item={it} />
      ))}
      {allDay.length > 0 && timed.length > 0 && (
        <li className="agenda-panel-divider" aria-hidden>
          כל היום
        </li>
      )}
      {allDay.map((it) => (
        <AgendaRow key={it.id} item={it} />
      ))}
    </ul>
  );
}

function AgendaRow({ item }: { item: AgendaItem }) {
  const preview = useTaskPreview();
  const isEvent = item.source === "event";
  const canPreview = !isEvent && !!item.task;

  const inner = (
    <>
      <span
        className={`agenda-panel-row-dot ${item.toneClass}`}
        aria-hidden
      />
      <div className="agenda-panel-row-body">
        <div className="agenda-panel-row-line">
          {item.time && (
            <span className="agenda-panel-row-time" dir="ltr">
              {item.time}
            </span>
          )}
          <span className="agenda-panel-row-title">
            {isEvent && (
              <span className="agenda-panel-row-event-glyph" aria-hidden>
                📅{" "}
              </span>
            )}
            {item.title}
          </span>
        </div>
        {item.subtitle && (
          <div className="agenda-panel-row-subtitle">{item.subtitle}</div>
        )}
        {item.status && (
          <div className="agenda-panel-row-status">
            {STATUS_LABELS_HE[item.status] || item.status}
          </div>
        )}
      </div>
    </>
  );

  return (
    <li className="agenda-panel-row">
      {isEvent ? (
        <a
          href={item.href}
          target="_blank"
          rel="noreferrer"
          className="agenda-panel-row-link"
          title="פתח ב-Google Calendar"
        >
          {inner}
        </a>
      ) : (
        <Link href={item.href} className="agenda-panel-row-link">
          {inner}
        </Link>
      )}
      {canPreview && (
        <button
          type="button"
          className="agenda-panel-row-preview"
          title="תצוגה מקדימה — תיאור מלא ופרטים, ללא מעבר עמוד"
          aria-label="תצוגה מקדימה"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            if (item.task) preview.open(item.task, []);
          }}
        >
          👁
        </button>
      )}
    </li>
  );
}

function formatShortDate(yyyymmdd: string): string {
  const m = yyyymmdd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return yyyymmdd;
  return `${parseInt(m[3], 10)}.${parseInt(m[2], 10)}`;
}
