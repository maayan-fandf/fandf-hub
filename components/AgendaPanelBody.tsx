"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import type { AgendaDay, AgendaItem } from "@/lib/agenda";
import { STATUS_LABELS } from "@/components/TaskStatusCell";
import { useTaskPreview } from "@/components/TaskPreviewProvider";

/**
 * Client-side renderer for the multi-day agenda. Server hands us the
 * full window (yesterday → today → next 6 days), we render it as
 * day-headed sections and auto-scroll today into view on mount.
 *
 * Each TASK row carries a 👁 quick-view button that opens the shared
 * TaskPreviewProvider drawer. The button stops the parent <Link>
 * from navigating so the user stays on whatever page hosts the
 * panel.
 */

type Props = {
  days: AgendaDay[];
};

export default function AgendaPanelBody({ days }: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to today's section on first mount. The server window
  // includes 1 day before today + today + days after, so today is
  // typically the second section — without this, the panel would open
  // to "אתמול" at the top and the user would have to scroll past
  // yesterday to see today.
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const todayEl = root.querySelector<HTMLElement>(
      '[data-agenda-day-today="1"]',
    );
    if (todayEl) {
      // Use scrollTop rather than scrollIntoView so the panel's parent
      // doesn't also scroll (avoids the page jumping when the panel
      // is below the fold).
      root.scrollTop = todayEl.offsetTop - root.offsetTop;
    }
  }, []);

  return (
    <div className="agenda-panel-scroller" ref={scrollerRef}>
      {days.map((day) => (
        <DaySection key={day.date} day={day} />
      ))}
    </div>
  );
}

function DaySection({ day }: { day: AgendaDay }) {
  return (
    <section
      className={`agenda-panel-day${
        day.isToday ? " is-today" : ""
      }`}
      data-agenda-day-today={day.isToday ? "1" : undefined}
      data-agenda-date={day.date}
    >
      <header className="agenda-panel-day-head">
        <span className="agenda-panel-day-label">{day.dayLabel}</span>
        <span className="agenda-panel-day-date" dir="ltr">
          {formatShortDate(day.date)}
        </span>
      </header>
      {day.items.length === 0 ? (
        <div className="agenda-panel-day-empty">—</div>
      ) : (
        <DayList items={day.items} />
      )}
    </section>
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
  // Whether the row offers a 👁 quick-view button — only for tasks
  // that we have the full payload for (events open in a new tab and
  // their data lives in Calendar; no preview to render).
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
            {STATUS_LABELS[item.status] || item.status}
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
  // "2026-05-09" → "9.5" — short label that fits in the day-section
  // header next to the Hebrew label (e.g. "יום שני · 9.5").
  const m = yyyymmdd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return yyyymmdd;
  return `${parseInt(m[3], 10)}.${parseInt(m[2], 10)}`;
}
