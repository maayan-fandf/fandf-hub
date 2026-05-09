/**
 * Right-rail agenda panel — server component. Mounted once globally
 * via app/layout.tsx, fetches a multi-day window for the signed-in
 * user (default: yesterday + today + the next 6 days), renders each
 * day as its own section. The user can scroll through the panel to
 * see neighboring days; a small client effect auto-scrolls today's
 * section into view on initial paint.
 *
 * Each task row carries a 👁 quick-view button — clicking opens the
 * shared TaskPreviewProvider drawer (same one /tasks queue uses)
 * with the full task content inline.
 *
 * Layout: sticky `<aside>` on the right side of the viewport, full
 * height under the topnav. Collapses to a thin tab the user can click
 * to expand. Hidden entirely on screens narrower than 1024px (the
 * existing main-content layout already gets cramped at that size).
 */

import { Suspense } from "react";
import { getAgendaForUserDays, type AgendaDay } from "@/lib/agenda";
import { getUserPrefs } from "@/lib/userPrefs";
import AgendaPanelToggle from "@/components/AgendaPanelToggle";
import AgendaPanelBody from "@/components/AgendaPanelBody";

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
  const [prefs, days] = await Promise.all([
    getUserPrefs(userEmail).catch(() => ({ agenda_collapsed: false })),
    getAgendaForUserDays(userEmail, { daysBefore: 1, daysAfter: 6 }),
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
        {/* Title always renders; collapsed-mode CSS rotates it so it
            reads vertically along the thin collapsed strip. */}
        <div className="agenda-panel-head-title">
          <div className="agenda-panel-head-emoji" aria-hidden>
            📅
          </div>
          <div>
            <div className="agenda-panel-head-label">סדר יום</div>
            <div className="agenda-panel-head-date">{headerDate}</div>
          </div>
        </div>
      </header>

      {!collapsed && (
        <Suspense
          fallback={<div className="agenda-panel-empty">טוען…</div>}
        >
          <AgendaPanelBody days={days as AgendaDay[]} />
        </Suspense>
      )}
    </aside>
  );
}
