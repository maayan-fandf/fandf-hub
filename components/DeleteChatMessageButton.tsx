"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * 🗑️ icon button that confirms then deletes a Chat message via
 * /api/chat/delete. Caller (InternalDiscussionTab) renders this only
 * for messages where the viewing user is the author — Chat REST
 * enforces the same constraint server-side, but gating client-side
 * avoids showing an action the user can't actually perform.
 *
 * Uses native window.confirm — same pattern as DeleteButton on the
 * hub-Comments side. The dialog text excerpts the message body so
 * the user sees what they're about to lose.
 */
export default function DeleteChatMessageButton({
  messageName,
  bodyExcerpt,
}: {
  messageName: string;
  bodyExcerpt: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onClick() {
    if (isPending) return;
    const preview = (bodyExcerpt || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const prompt = preview
      ? `למחוק את ההודעה?\n\n«${preview}${bodyExcerpt.length > 80 ? "…" : ""}»`
      : "למחוק את ההודעה?";
    if (!window.confirm(prompt)) return;
    startTransition(async () => {
      try {
        const res = await fetch("/api/chat/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageName }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        router.refresh();
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <button
      type="button"
      className="chat-message-action chat-message-action-danger"
      onClick={onClick}
      disabled={isPending}
      title="מחק הודעה"
      aria-label="מחק הודעה"
    >
      {isPending ? "…" : "🗑️"}
    </button>
  );
}
