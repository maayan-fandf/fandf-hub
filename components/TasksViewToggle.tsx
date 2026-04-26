"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

type View = "table" | "kanban";

type Props = {
  current: View;
  /** Existing search params on /tasks. We preserve everything except
   *  `view`, so toggling between table and kanban keeps the user's
   *  filters / role-defaults intact. */
  searchParams: Record<string, string | undefined>;
};

/**
 * Segmented control next to the page title that switches the queue
 * between the table and the kanban board. Client component because we
 * call `router.refresh()` after `router.push()` so the user always sees
 * fresh data when switching views — without it, Next's RSC prefetch
 * cache could serve a stale payload from a few seconds earlier (e.g.
 * after a status change in another tab the toggled view would lag).
 */
export default function TasksViewToggle({ current, searchParams }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const tableHref = buildHref(searchParams, { view: "" });
  const kanbanHref = buildHref(searchParams, { view: "kanban" });

  function navigate(href: string, target: View) {
    if (target === current) return;
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
  const qs = new URLSearchParams(merged).toString();
  return qs ? `/tasks?${qs}` : "/tasks";
}
