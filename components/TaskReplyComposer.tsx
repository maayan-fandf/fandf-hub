"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  taskId: string;
};

const MAX = 4000;

/**
 * Permanent composer at the bottom of a task's comment thread. POSTs to
 * `/api/comments/reply` with `parentCommentId=taskId` — the Apps Script
 * `postReplyForUser_` handler treats a task row as a valid top-level parent
 * (it just needs `parent_id===''`, which tasks satisfy).
 */
export default function TaskReplyComposer({ taskId }: Props) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
    startTransition(async () => {
      try {
        const res = await fetch("/api/comments/reply", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentCommentId: taskId, body }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        setValue("");
        router.refresh();
        requestAnimationFrame(() => textareaRef.current?.focus());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  const count = value.trim().length;
  const over = count > MAX;

  return (
    <div className="task-reply-composer">
      <textarea
        ref={textareaRef}
        className="reply-textarea"
        rows={3}
        value={value}
        placeholder="כתוב תגובה… (⌘/Ctrl+Enter לשליחה)"
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
