"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type View = "table" | "kanban" | "calendar";

const VIEW_LABELS: Record<View, string> = {
  table: "רשימה",
  kanban: "קנבן",
  calendar: "לוח שנה",
};

type Props = {
  current: View;
  /** Existing search params on /tasks. We preserve everything except
   *  `view`, so toggling between views keeps the user's filters /
   *  role-defaults intact. */
  searchParams: Record<string, string | undefined>;
};

/**
 * Segmented control next to the page title that switches the queue
 * between the table, kanban board, and calendar view. Client component
 * because we call `router.refresh()` after `router.push()` so the user
 * always sees fresh data when switching views — without it, Next's RSC
 * prefetch cache could serve a stale payload from a few seconds earlier
 * (e.g. after a status change in another tab the toggled view would lag).
 */
export default function TasksViewToggle({ current, searchParams }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [announce, setAnnounce] = useState("");
  const tableHref = buildHref(searchParams, { view: "" });
  const kanbanHref = buildHref(searchParams, { view: "kanban" });
  const calendarHref = buildHref(searchParams, { view: "calendar" });

  function navigate(href: string, target: View) {
    if (target === current) return;
    // Announce to screen readers — without this, the visual change
    // is silent for keyboard / NVDA / VoiceOver users. The aria-live
    // region below picks up the message and reads it once.
    setAnnounce(`עוברים לתצוגת ${VIEW_LABELS[target]}`);
    startTransition(() => {
      router.push(href);
      router.refresh();
    });
  }

  return (
    <div
      className={`tasks-view-toggle${isPending ? " is-pending" : ""}`}
      role="tablist"
      aria-label="תצוגה"
    >
      {/* Screen-reader-only live region — announces view changes
          for keyboard / AT users since the visual transition is
          silent. polite = wait for current speech to finish. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </span>
      <button
        type="button"
        onClick={() => navigate(tableHref, "table")}
        className={`tasks-view-toggle-btn${current === "table" ? " is-active" : ""}`}
        aria-current={current === "table" ? "page" : undefined}
        role="tab"
        aria-selected={current === "table"}
      >
        <span aria-hidden>📋</span>
        רשימה
      </button>
      <button
        type="button"
        onClick={() => navigate(kanbanHref, "kanban")}
        className={`tasks-view-toggle-btn${current === "kanban" ? " is-active" : ""}`}
        aria-current={current === "kanban" ? "page" : undefined}
        role="tab"
        aria-selected={current === "kanban"}
      >
        <span aria-hidden>🗂️</span>
        קנבן
      </button>
      <button
        type="button"
        onClick={() => navigate(calendarHref, "calendar")}
        className={`tasks-view-toggle-btn${current === "calendar" ? " is-active" : ""}`}
        aria-current={current === "calendar" ? "page" : undefined}
        role="tab"
        aria-selected={current === "calendar"}
      >
        <span aria-hidden>📅</span>
        לוח שנה
      </button>
    </div>
  );
}

function buildHref(
  current: Record<string, string | undefined>,
  overrides: Record<string, string>,
): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) {
    if (v) merged[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === "") delete merged[k];
    else merged[k] = v;
  }
  // Strip view-specific params when toggling away — keeps the URL
  // honest so a user on /tasks?month=... after switching back from
  // the calendar doesn't think their list is somehow filtered by
  // month (the table ignores it, but the param sticking around
  // looks like a filter and confused users in practice). `month`
  // is calendar-only.
  const targetView = merged.view || "";
  if (targetView !== "calendar") delete merged.month;
  const qs = new URLSearchParams(merged).toString();
  return qs ? `/tasks?${qs}` : "/tasks";
}
