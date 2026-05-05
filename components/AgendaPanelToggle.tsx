"use client";

/**
 * Collapse / expand toggle for the right-rail AgendaPanel. Persists
 * the choice via /api/me/prefs (key: agenda_collapsed). Optimistic —
 * the UI flips immediately, the POST is fire-and-forget. On a refresh
 * or navigation the server-rendered initial state matches because the
 * pref is read on every page render.
 */

import { useState, useTransition } from "react";

type Props = {
  initialCollapsed: boolean;
};

export default function AgendaPanelToggle({ initialCollapsed }: Props) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [, startTransition] = useTransition();

  function toggle() {
    const next = !collapsed;
    // Optimistic UI flip — applies CSS attribute on <aside data-collapsed>.
    // Walks the DOM up to the panel since the toggle lives inside it.
    const button = document.activeElement;
    const panel =
      button instanceof HTMLElement ? button.closest(".agenda-panel") : null;
    if (panel instanceof HTMLElement) {
      if (next) panel.setAttribute("data-collapsed", "1");
      else panel.removeAttribute("data-collapsed");
    }
    setCollapsed(next);
    startTransition(() => {
      void fetch("/api/me/prefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agenda_collapsed: next }),
        keepalive: true,
      }).catch(() => {
        /* best-effort — server-render reads the latest pref next page,
         * so a one-off transient failure self-heals on next nav. */
      });
    });
  }

  return (
    <button
      type="button"
      className="agenda-panel-toggle"
      onClick={toggle}
      title={collapsed ? "הרחב סדר יום" : "צמצם סדר יום"}
      aria-expanded={!collapsed}
      aria-controls="agenda-panel-list"
    >
      {collapsed ? "‹" : "›"}
    </button>
  );
}
