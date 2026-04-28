"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const MAX = 4000;

/**
 * Inline composer at the bottom of the client (לקוח) tab.
 *
 * Mirrors `InternalChatComposer`'s shape: textarea with role-aware
 * placeholder, a single send button, ⌘/Ctrl+Enter submits, Esc
 * clears. Posts via `/api/tasks/create` (the comment row append +
 * notification fan-out path that the legacy `+ הודעה ללקוח` modal
 * also used).
 *
 * Scope of v1: text only. No @-mention picker, no due date, no
 * attachments. Staff who need those flow through `/tasks/new` for
 * the full task form. Keeps the inline composer lean so it actually
 * feels like a chat input rather than a mini form.
 *
 * Role gating: `isClientUser` flips the placeholder + button title
 * so the language matches who's typing — clients see "הודעה לצוות",
 * staff/admin see "הודעה ללקוח". The endpoint is identical either
 * way (the row lands in the project's Comments sheet, audible to
 * everyone with project access).
 */
export default function ClientChatComposer({
  project,
  isClientUser,
}: {
  project: string;
  isClientUser: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const audience = isClientUser ? "לצוות" : "ללקוח";
  const placeholder = isClientUser
    ? "כתוב הודעה לצוות... (⌘/Ctrl+Enter לשליחה)"
    : "כתוב הודעה ללקוח... (⌘/Ctrl+Enter לשליחה)";

  function submit() {
    const text = body.trim();
    if (!text) {
      setError("הודעה לא יכולה להיות ריקה.");
      return;
    }
    if (text.length > MAX) {
      setError(`ארוך מדי (${text.length}/${MAX}).`);
      return;
    }
    setError(null);
    const sending = text;
    setBody("");
    startTransition(async () => {
      try {
        const res = await fetch("/api/tasks/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project,
            body: sending,
            assignees: [],
            due: "",
          }),
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
        // Restore the body so the user doesn't lose what they typed,
        // surface the error inline, and re-focus the textarea so they
        // can retry without clicking back in.
        setBody(sending);
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
      setBody("");
      setError(null);
    }
  }

  const count = body.trim().length;
  const over = count > MAX;
  const empty = count === 0;

  return (
    <div className="client-chat-composer">
      <textarea
        ref={textareaRef}
        className="reply-textarea client-chat-composer-input"
        rows={2}
        value={body}
        placeholder={placeholder}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={isPending}
        maxLength={MAX + 1}
        aria-label={`הודעה חדשה ${audience}`}
      />
      <div className="client-chat-composer-foot">
        {error && (
          <span className="reply-error" role="alert">
            {error}
          </span>
        )}
        <span className={`reply-count ${over ? "is-over" : ""}`}>
          {count}/{MAX}
        </span>
        <button
          type="button"
          className="reply-btn reply-btn-primary"
          onClick={submit}
          disabled={isPending || empty || over}
          title={
            isClientUser
              ? "פרסם הודעה לצוות בפרוייקט"
              : "פרסם הודעה לערוץ הלקוח"
          }
        >
          {isPending ? "שולח…" : `שלח הודעה ${audience}`}
        </button>
      </div>
    </div>
  );
}
