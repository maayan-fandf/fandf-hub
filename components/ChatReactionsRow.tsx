"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ChatReaction } from "@/lib/chat";

const COMMON_EMOJIS = ["👍", "❤️", "😄", "🎉", "👀", "🙏", "✅", "🔥"];

/**
 * Interactive emoji-reactions row under each Chat message. Replaces
 * the previous server-rendered link-out chips: clicking a chip now
 * toggles the user's reaction (add via the Chat API; remove via the
 * × on hover); a "+" button opens an inline picker with common
 * emojis to add a fresh reaction.
 *
 * Why both an existing-chip-click AND a separate × for remove?
 *   - Click chip body → ADD: idempotent; if you'd already reacted
 *     with this emoji Chat returns the existing reaction (no-op)
 *   - Hover chip → × button → REMOVE: only succeeds if the
 *     impersonated user actually has a reaction with that emoji
 *
 * The split keeps the affordances unambiguous. Long-press / right-
 * click would be denser but doesn't surface on hover.
 *
 * NB: we don't show a per-user "you reacted" highlight on the chip.
 * Doing so reliably would require a second API call per render to
 * list reactions filtered by the current user. Trade-off: slight
 * UX downgrade vs Chat's native UI in exchange for keeping the
 * read path cheap. Phase-N nicety if usage signals demand it.
 */
export default function ChatReactionsRow({
  messageName,
  reactions,
}: {
  messageName: string;
  reactions: ChatReaction[];
}) {
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function call(emoji: string, action: "add" | "remove") {
    if (isPending) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/chat/react", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageName, emoji, action }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        setPickerOpen(false);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="chat-reactions">
      {reactions.map((r, i) => (
        <span key={i} className="chat-reaction-chip">
          <button
            type="button"
            className="chat-reaction"
            onClick={() => call(r.emoji, "add")}
            disabled={isPending}
            title="הוסף תגובה כזו"
          >
            <span className="chat-reaction-emoji" aria-hidden>
              {r.emoji}
            </span>
            <span className="chat-reaction-count">{r.count}</span>
          </button>
          {/* Small × on hover removes the user's own reaction with
              this emoji. Idempotent — Chat returns 404 if the user
              didn't have one, which we surface as the error inline. */}
          <button
            type="button"
            className="chat-reaction-remove"
            onClick={() => call(r.emoji, "remove")}
            disabled={isPending}
            title="הסר את התגובה שלי"
            aria-label="הסר תגובה"
          >
            ×
          </button>
        </span>
      ))}
      <button
        type="button"
        className="chat-reaction-add"
        onClick={() => setPickerOpen((o) => !o)}
        disabled={isPending}
        title="הוסף תגובה חדשה"
        aria-label="הוסף תגובה חדשה"
      >
        +
      </button>
      {pickerOpen && (
        <div className="chat-reaction-picker" role="menu">
          {COMMON_EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              className="chat-reaction-picker-item"
              onClick={() => call(e, "add")}
              disabled={isPending}
            >
              {e}
            </button>
          ))}
        </div>
      )}
      {error && (
        <span className="chat-reaction-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
