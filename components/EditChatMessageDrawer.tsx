"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const MAX = 4000;

/**
 * Pencil-icon trigger that expands into an inline edit textarea on
 * click. Submits to /api/chat/edit which calls Chat REST patch
 * impersonating the session user.
 *
 * Same UX shape as the hub's EditDrawer for Comments: optimistic
 * close on save (clear UI immediately + router.refresh), restore on
 * error. Esc cancels without saving.
 *
 * Only rendered for messages where the viewing user is the author —
 * caller (InternalDiscussionTab) gates by senderResource match.
 */
export default function EditChatMessageDrawer({
  messageName,
  initialText,
}: {
  messageName: string;
  initialText: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function openDrawer() {
    setValue(initialText);
    setError(null);
    setOpen(true);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      // Cursor at end of text — most edits are appends or fixes near
      // the end, and end-of-text feels like the natural caret start.
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  function closeDrawer() {
    setOpen(false);
    setError(null);
  }

  function submit() {
    const text = value.trim();
    if (!text) {
      setError("אי אפשר לשמור הודעה ריקה.");
      return;
    }
    if (text.length > MAX) {
      setError(`ארוך מדי (${text.length}/${MAX}).`);
      return;
    }
    if (text === initialText.trim()) {
      // No-op edit — just close.
      closeDrawer();
      return;
    }
    setError(null);
    closeDrawer();
    startTransition(async () => {
      try {
        const res = await fetch("/api/chat/edit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageName, text }),
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
        className="chat-message-action"
        onClick={openDrawer}
        title="ערוך הודעה"
        aria-label="ערוך הודעה"
      >
        ✏️
      </button>
    );
  }

  const count = value.trim().length;
  const over = count > MAX;

  return (
    <div className="chat-edit-drawer">
      <textarea
        ref={textareaRef}
        className="reply-textarea"
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={isPending}
        maxLength={MAX + 1}
      />
      <div className="chat-edit-drawer-foot">
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
          {isPending ? "שומר…" : "שמור"}
        </button>
      </div>
    </div>
  );
}
