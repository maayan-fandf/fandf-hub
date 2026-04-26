"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  /** Current state of the user's hide_archived pref. */
  hidden: boolean;
  /** How many tasks are currently considered archived (done/
   *  cancelled, older than archive_after_days). Renders next to
   *  the icon as a count badge so the user knows what they're
   *  hiding without having to expand. */
  count: number;
  /** True when the URL is forcing archive visible (e.g.
   *  ?status=done). The toggle still renders so the user can
   *  flip the pref, but the visual state shows "showing" because
   *  the override is in effect for this load. */
  overridden?: boolean;
};

/**
 * Header chip on /tasks that toggles the user's hide_archived pref
 * (POST /api/me/prefs) — clicking flips it across all three views
 * (table / kanban / calendar) at once. Status-explicit URLs (e.g.
 * ?status=done) override the pref for the current load and the
 * chip surfaces that with a "מוצג" tag instead of the badge.
 *
 * The pref is the source of truth; this component is just the
 * dispatcher. router.refresh() pulls the new state in after the
 * pref save lands.
 */
export default function TasksArchiveToggle({
  hidden,
  count,
  overridden = false,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const effective = optimistic ?? hidden;

  function toggle() {
    const next = !effective;
    setOptimistic(next);
    startTransition(async () => {
      try {
        await fetch("/api/me/prefs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hide_archived: next }),
        });
      } finally {
        router.refresh();
        setOptimistic(null);
      }
    });
  }

  // When count is 0 and the toggle is in "hide" mode, the chip
  // still surfaces the option — but a 0-count is a less compelling
  // affordance, so render at lower visual weight to keep the
  // header tidy.
  const isQuiet = count === 0;
  return (
    <button
      type="button"
      className={`tasks-archive-toggle${effective ? " is-hiding" : " is-showing"}${
        overridden ? " is-overridden" : ""
      }${isQuiet ? " is-quiet" : ""}`}
      onClick={toggle}
      disabled={isPending}
      aria-pressed={effective}
      title={
        overridden
          ? "סטטוס בסינון מציג את הארכיון לטעינה הזו — לחיצה תעדכן את ההעדפה הקבועה"
          : effective
            ? `${count} משימות בארכיון מוסתרות. לחץ כדי להציג.`
            : `הארכיון מוצג. לחץ כדי להסתיר ${count} משימות.`
      }
    >
      <span aria-hidden>📦</span>
      <span>ארכיון</span>
      {count > 0 && (
        <span className="tasks-archive-toggle-count">
          {count > 99 ? "99+" : count}
        </span>
      )}
      {overridden && (
        <span className="tasks-archive-toggle-flag">מוצג</span>
      )}
    </button>
  );
}
