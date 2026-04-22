"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  commentId: string;
  resolved: boolean;
  /**
   * If true, show "Resolved ✓" as an inert label when the comment is already
   * resolved — no un-resolve affordance. The timeline uses this so you can't
   * accidentally re-open a closed thread. The inbox defaults to false so users
   * can toggle.
   */
  readOnlyWhenResolved?: boolean;
  /** Render the trigger as an icon-only button (✓) with the label in a
   *  tooltip. Used by CardActions for the unified icon-row layout. */
  iconOnly?: boolean;
};

export default function ResolveButton({
  commentId,
  resolved,
  readOnlyWhenResolved = false,
  iconOnly = false,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Optimistic local state so the click feels instant; we reconcile on refresh.
  const [localResolved, setLocalResolved] = useState(resolved);

  // If the server-side value changes out from under us (e.g. parent re-renders
  // after router.refresh), accept it.
  if (resolved !== localResolved && !isPending) {
    // Note: this intentional top-level setState is safe because it's guarded
    // by a !isPending check and a value comparison — React won't loop.
    setLocalResolved(resolved);
  }

  if (localResolved && readOnlyWhenResolved) {
    return <span className="chip chip-done">פתור</span>;
  }

  async function toggle() {
    setError(null);
    const next = !localResolved;
    setLocalResolved(next);
    startTransition(async () => {
      try {
        const res = await fetch("/api/comments/resolve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commentId, resolved: next }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        router.refresh();
      } catch (err) {
        // Roll back optimistic update on failure.
        setLocalResolved(!next);
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const label = localResolved ? "בטל פתור" : "סמן כפתור";
  const tooltip = localResolved
    ? "בטל פתור"
    : "סמן שיחה כפתורה (יסגור גם משימות שנוצרו ממנה)";

  return (
    <span className="resolve-btn-wrap">
      <button
        type="button"
        className={
          iconOnly
            ? `card-action ${localResolved ? "is-resolved" : ""}`
            : `resolve-btn ${localResolved ? "is-resolved" : ""}`
        }
        onClick={toggle}
        disabled={isPending}
        aria-pressed={localResolved}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : tooltip}
      >
        {isPending ? "…" : iconOnly ? "✓" : localResolved ? "פתור ✓" : "סמן כפתור"}
      </button>
      {error && <span className="resolve-btn-error">{error}</span>}
    </span>
  );
}
