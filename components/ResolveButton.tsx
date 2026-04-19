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
};

export default function ResolveButton({
  commentId,
  resolved,
  readOnlyWhenResolved = false,
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
    return <span className="chip chip-done">resolved</span>;
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

  return (
    <span className="resolve-btn-wrap">
      <button
        type="button"
        className={`resolve-btn ${localResolved ? "is-resolved" : ""}`}
        onClick={toggle}
        disabled={isPending}
        aria-pressed={localResolved}
        title={
          localResolved
            ? "Mark as unresolved"
            : "Mark this thread as resolved (also closes spawned tasks)"
        }
      >
        {isPending ? "…" : localResolved ? "Resolved ✓" : "Resolve"}
      </button>
      {error && <span className="resolve-btn-error">{error}</span>}
    </span>
  );
}
