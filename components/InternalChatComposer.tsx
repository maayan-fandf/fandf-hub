"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const MAX = 4000;

/**
 * Inline composer at the bottom of the internal Chat tab. Posts a
 * message into the project's Chat space via /api/chat/post, then
 * router.refresh()es so the new message shows up in the feed above.
 *
 * UX patterns mirror ReplyDrawer / TaskReplyComposer:
 *   - ⌘/Ctrl+Enter sends
 *   - Esc clears
 *   - Optimistic clear on send (errors restore the typed text)
 *   - Server-driven cache invalidation: the API revalidates the
 *     chat-messages tag, so a single router.refresh() picks up the
 *     new message instead of waiting up to 60s for TTL expiry.
 *
 * Phase-1-style basic textarea — no @-mention picker (Chat handles
 * its own native @-mentions for users who type the message in Chat;
 * cross-pollinating the hub composer with Chat-native @-syntax is a
 * bigger lift and the hub user can include @-emails as plain text).
 */
export default function InternalChatComposer({
  project,
}: {
  project: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function submit() {
    const text = value.trim();
    if (!text) {
      setError("הודעה לא יכולה להיות ריקה.");
      return;
    }
    if (text.length > MAX) {
      setError(`ארוך מדי (${text.length}/${MAX}).`);
      return;
    }
    setError(null);
    // Optimistic clear — same rationale as ReplyDrawer. If the post
    // fails we restore the typed text + show the error inline.
    setValue("");
    startTransition(async () => {
      try {
        const res = await fetch("/api/chat/post", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project, text }),
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
        setValue(text);
        setError(e instanceof Error ? e.message : String(e));
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setValue("");
      setError(null);
    }
  }

  const count = value.trim().length;
  const over = count > MAX;

  return (
    <div className="chat-composer">
      <textarea
        ref={textareaRef}
        className="reply-textarea"
        rows={3}
        value={value}
        placeholder="כתוב הודעה לחלל הצ׳אט הפנימי… (⌘/Ctrl+Enter לשליחה, Esc לניקוי)"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={isPending}
        maxLength={MAX + 1}
      />
      <div className="chat-composer-foot">
        <span className={`reply-count ${over ? "is-over" : ""}`}>
          {count}/{MAX}
        </span>
        {error && <span className="reply-error">{error}</span>}
        <span className="reply-drawer-spacer" />
        <button
          type="button"
          className="reply-btn reply-btn-primary"
          onClick={submit}
          disabled={isPending || count === 0 || over}
          title="ההודעה תופיע בחלל הצ׳אט הפנימי בשמך"
        >
          {isPending ? "שולח…" : "שלח לצ׳אט"}
        </button>
      </div>
    </div>
  );
}
