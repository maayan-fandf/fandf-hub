/**
 * Right-rail agenda panel — server component. Mounted once globally
 * via app/layout.tsx, fetches today's items for the signed-in user,
 * renders a sticky sidebar with collapsed/expanded state from
 * UserPrefs.agenda_collapsed.
 *
 * Phase A (this commit, 2026-05-05): tasks-only. Calendar events
 * follow in Phase B once the read scope is granted.
 *
 * Layout: sticky `<aside>` on the right side of the viewport, full
 * height under the topnav. Collapses to a thin tab the user can click
 * to expand. Hidden entirely on screens narrower than 1024px (the
 * existing main-content layout already gets cramped at that size).
 */

import { Suspense } from "react";
import Link from "next/link";
import { getAgendaForUser } from "@/lib/agenda";
import { getUserPrefs } from "@/lib/userPrefs";
import { STATUS_LABELS } from "@/components/TaskStatusCell";
import AgendaPanelToggle from "@/components/AgendaPanelToggle";

type Props = {
  /** Signed-in user's email — already resolved by app/layout.tsx via
   *  `auth()`. Empty when no session; component returns null in that
   *  case so the panel doesn't render on /signin. */
  userEmail: string;
};

export default async function AgendaPanel({ userEmail }: Props) {
  if (!userEmail) return null;

  // Read prefs in parallel with agenda data so the initial paint is
  // single-roundtrip (each call is independent).
  const [prefs, items] = await Promise.all([
    getUserPrefs(userEmail).catch(() => ({ agenda_collapsed: false })),
    getAgendaForUser(userEmail),
  ]);
  const collapsed = !!prefs.agenda_collapsed;

  // Today's date for the panel header — "ה' באייר", "יום שני 5 במאי",
  // etc. Use the user's browser locale for the display via formatToParts;
  // server-render fallback is the en-CA YYYY-MM-DD form.
  const headerDate = new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

  return (
    <aside
      className="agenda-panel"
      data-collapsed={collapsed ? "1" : undefined}
      aria-label="סדר היום"
    >
      <header className="agenda-panel-head">
        <AgendaPanelToggle initialCollapsed={collapsed} />
        {!collapsed && (
          <div className="agenda-panel-head-title">
            <div className="agenda-panel-head-emoji" aria-hidden>
              📅
            </div>
            <div>
              <div className="agenda-panel-head-label">היום</div>
              <div className="agenda-panel-head-date">{headerDate}</div>
            </div>
          </div>
        )}
      </header>

      {!collapsed && (
        <Suspense
          fallback={<div className="agenda-panel-empty">טוען…</div>}
        >
          <AgendaList items={items} />
        </Suspense>
      )}
    </aside>
  );
}

function AgendaList({
  items,
}: {
  items: Awaited<ReturnType<typeof getAgendaForUser>>;
}) {
  if (items.length === 0) {
    return (
      <div className="agenda-panel-empty">
        אין משימות להיום ✨
        <div className="agenda-panel-empty-hint">
          זמן חופשי לחשוב, ליזום, או לסגור משימות מהמלאי שלך.
        </div>
      </div>
    );
  }

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

function AgendaRow({
  item,
}: {
  item: Awaited<ReturnType<typeof getAgendaForUser>>[number];
}) {
  // Calendar events open in a new tab (the htmlLink points at
  // calendar.google.com); tasks navigate within the hub via the
  // standard Link prefetch flow.
  const isEvent = item.source === "event";
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
    </li>
  );
}
