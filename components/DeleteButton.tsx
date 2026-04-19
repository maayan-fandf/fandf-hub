"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  commentId: string;
  /**
   * Shown in the confirm prompt, e.g. "את התיוג", "את המשימה".
   * Keep it short — it's inserted into "בטוח למחוק את X?".
   */
  itemLabel?: string;
  /** Subtle mode: just an "✕", title-tooltip only. Default is a text button. */
  minimal?: boolean;
};

/**
 * Delete a top-level comment (and its replies + spawned Google Tasks).
 * Only authors and admins can delete — the Apps Script side enforces that;
 * we just forward the result. Uses the browser's native confirm() to keep
 * dependencies low — good enough for a destructive action behind auth.
 */
export default function DeleteButton({
  commentId,
  itemLabel = "פריט זה",
  minimal = false,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    if (
      !window.confirm(
        `בטוח למחוק ${itemLabel}? הפעולה תמחק גם את התגובות והמשימות שנוצרו. אי אפשר לבטל.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/comments/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commentId }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <span className="delete-btn-wrap">
      <button
        type="button"
        className={`delete-btn ${minimal ? "is-minimal" : ""}`}
        onClick={onClick}
        disabled={isPending}
        title={minimal ? "מחק" : "מחק לצמיתות"}
        aria-label="מחק"
      >
        {isPending ? "…" : minimal ? "✕" : "מחק"}
      </button>
      {error && <span className="resolve-btn-error">{error}</span>}
    </span>
  );
}
