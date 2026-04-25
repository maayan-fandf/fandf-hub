"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  /** The top-level comment being replied to. Replies to replies aren't allowed. */
  parentCommentId: string;
  /** Optional label for the trigger button. Default: "השב". */
  label?: string;
  /** If true, render the trigger as an icon-only button (↩) with the label in
   *  a tooltip. Used by CardActions for the unified icon-row layout. */
  iconOnly?: boolean;
};

const MAX = 4000;

/**
 * Click "Reply" → reveals an inline textarea. Submit posts via
 * /api/comments/reply and calls router.refresh() on success.
 * Esc closes the drawer without sending.
 */
export default function ReplyDrawer({
  parentCommentId,
  label = "השב",
  iconOnly = false,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function openDrawer() {
    setOpen(true);
    setError(null);
    // Focus after the textarea mounts.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function closeDrawer() {
    setOpen(false);
    setValue("");
    setError(null);
  }

  function submit() {
    const body = value.trim();
    if (!body) {
      setError("תגובה לא יכולה להיות ריקה.");
      return;
    }
    if (body.length > MAX) {
      setError(`ארוך מדי (${body.length}/${MAX}).`);
      return;
    }
    setError(null);

    // Snappier UX: close the drawer the instant the user hits send and
    // run the fetch in the background. The drawer's "שולח…" state was
    // the most visible source of perceived latency on comment writes —
    // even with the post-5090d39 cord-cut the API is ~1 s, so the user
    // was watching the drawer wait for a beat. With the drawer gone the
    // action feels done; router.refresh() materializes the actual reply
    // a moment later. On error we reopen the drawer with the body
    // restored so the user can retry without retyping.
    closeDrawer();
    startTransition(async () => {
      try {
        const res = await fetch("/api/comments/reply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentCommentId, body }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        router.refresh();
      } catch (err) {
        setValue(body);
        setError(err instanceof Error ? err.message : String(err));
        setOpen(true);
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
        className={iconOnly ? "card-action" : "reply-btn"}
        onClick={openDrawer}
        title={iconOnly ? label : "השב לשיחה זו (⌘/Ctrl+Enter לשליחה)"}
        aria-label={iconOnly ? label : undefined}
      >
        {iconOnly ? "↩" : label}
      </button>
    );
  }

  const count = value.trim().length;
  const over = count > MAX;

  return (
    <div className="reply-drawer">
      <textarea
        ref={textareaRef}
        className="reply-textarea"
        rows={3}
        value={value}
        placeholder="כתוב תגובה… (⌘/Ctrl+Enter לשליחה, Esc לביטול)"
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
          disabled={isPending || count === 0 || over}
        >
          {isPending ? "שולח…" : "שלח"}
        </button>
      </div>
    </div>
  );
}
