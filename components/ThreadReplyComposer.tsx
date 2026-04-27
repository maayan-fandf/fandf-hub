"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const MAX = 4000;

/**
 * Inline thread-reply composer. Renders as a small "↩ השב לשרשור"
 * button by default; clicking expands into a textarea + send/cancel.
 * Submits to /api/chat/post with `threadName` set, which makes the
 * Chat API post the message AS A REPLY to that thread (rather than
 * starting a new top-level thread the way the main composer does).
 *
 * Smaller surface than InternalChatComposer — no @-mention picker
 * here. Most thread replies are quick acks ("Got it", "On it",
 * "merged") and don't need to tag people; the picker can be added
 * later if usage signals demand.
 */
export default function ThreadReplyComposer({
  project,
  threadName,
}: {
  project: string;
  /** Full thread resource name `spaces/<sid>/threads/<tid>` — passed
   *  through to the Chat API so the new message lands in this
   *  thread's reply chain. */
  threadName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function openDrawer() {
    setOpen(true);
    setError(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function closeDrawer() {
    setOpen(false);
    setValue("");
    setError(null);
  }

  function submit() {
    const text = value.trim();
    if (!text) {
      setError("תגובה לא יכולה להיות ריקה.");
      return;
    }
    if (text.length > MAX) {
      setError(`ארוך מדי (${text.length}/${MAX}).`);
      return;
    }
    setError(null);
    closeDrawer();
    startTransition(async () => {
      try {
        const res = await fetch("/api/chat/post", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project, text, threadName }),
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
        setOpen(true);
      }
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeDrawer();
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="thread-reply-trigger"
        onClick={openDrawer}
        title="הוסף תגובה לשרשור"
      >
        ↩ השב לשרשור
      </button>
    );
  }

  const count = value.trim().length;
  const over = count > MAX;

  return (
    <div className="thread-reply-composer">
      <textarea
        ref={textareaRef}
        className="reply-textarea"
        rows={2}
        value={value}
        placeholder="כתוב תגובה לשרשור… (⌘/Ctrl+Enter לשליחה, Esc לביטול)"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={isPending}
        maxLength={MAX + 1}
      />
      <div className="thread-reply-composer-foot">
        <span className={`reply-count ${over ? "is-over" : ""}`}>
          {count}/{MAX}
        </span>
        {error && <span className="reply-error">{error}</span>}
        <span className="reply-drawer-spacer" />
        <button
          type="button"
          className="reply-btn reply-btn-ghost"
          onClick={closeDrawer}
          disabled={isPending}
        >
          ביטול
        </button>
        <button
          type="button"
          className="reply-btn reply-btn-primary"
          onClick={submit}
          disabled={isPending || count === 0 || over}
        >
          {isPending ? "שולח…" : "שלח"}
        </button>
      </div>
    </div>
  );
}
