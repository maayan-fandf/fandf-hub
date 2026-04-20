"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  commentId: string;
  /** The current body text of the comment being edited. */
  initialBody: string;
  /**
   * If true, show the edit button as disabled (thread is resolved and the
   * server will reject). We hide the button in that case rather than
   * render a disabled control — cleaner UX.
   */
  locked?: boolean;
  /** Small label on the button. Default "ערוך". */
  label?: string;
};

const MAX = 4000;

/**
 * Inline edit drawer for comment bodies. Mirrors ReplyDrawer's flow:
 * click → textarea pre-filled with the current body → save/cancel.
 * Submits to /api/comments/edit which patches the sheet + syncs the
 * linked Google Tasks' title/notes.
 *
 * Hidden entirely when `locked` is true — the server would reject the
 * edit on resolved threads anyway.
 */
export default function EditDrawer({
  commentId,
  initialBody,
  locked = false,
  label = "ערוך",
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initialBody);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  if (locked) return null;

  function openDrawer() {
    setOpen(true);
    setValue(initialBody);
    setError(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      // Put the caret at the end rather than selecting everything — users
      // editing typos want to tap into the existing text.
      const len = el.value.length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        /* noop for unsupported types */
      }
    });
  }

  function closeDrawer() {
    setOpen(false);
    setValue(initialBody);
    setError(null);
  }

  function submit() {
    const body = value.trim();
    if (!body) {
      setError("גוף ההערה לא יכול להיות ריק.");
      return;
    }
    if (body.length > MAX) {
      setError(`ארוך מדי (${body.length}/${MAX}).`);
      return;
    }
    if (body === initialBody.trim()) {
      // No change → just close.
      closeDrawer();
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/comments/edit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commentId, body }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        closeDrawer();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDrawer();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="reply-btn"
        onClick={openDrawer}
        title="ערוך את גוף ההערה (⌘/Ctrl+Enter לשמירה)"
      >
        {label}
      </button>
    );
  }

  const count = value.trim().length;
  const over = count > MAX;
  const unchanged = value.trim() === initialBody.trim();

  return (
    <div className="reply-drawer">
      <textarea
        ref={textareaRef}
        className="reply-textarea"
        rows={3}
        value={value}
        placeholder="ערוך… (⌘/Ctrl+Enter לשמירה, Esc לביטול)"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={isPending}
        maxLength={MAX + 1}
      />
      <div className="reply-drawer-foot">
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
          disabled={isPending || count === 0 || over || unchanged}
        >
          {isPending ? "שומר…" : "שמור"}
        </button>
      </div>
    </div>
  );
}
