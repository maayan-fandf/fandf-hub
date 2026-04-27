"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ChatReaction } from "@/lib/chat";
import ConvertChatMessageToTaskButton from "@/components/ConvertChatMessageToTaskButton";
import EditChatMessageDrawer from "@/components/EditChatMessageDrawer";
import DeleteChatMessageButton from "@/components/DeleteChatMessageButton";

const COMMON_EMOJIS = ["👍", "❤️", "😄", "🎉", "👀", "🙏", "✅", "🔥"];
const MAX_REPLY = 4000;

/**
 * Per-message quick-actions row beneath each Chat message. Mirrors
 * the client-tab's CardActions pattern — every action lives inline
 * under the message, no separate hover toolbar:
 *   - existing reaction chips (each with × on hover to remove)
 *   - +    add-reaction picker (8 common emojis)
 *   - ↩    reply-to-this-thread trigger (expands an inline textarea
 *          below the row when clicked)
 *   - 📋   convert this message into a hub task (deeplinks to
 *          /tasks/new with body + author + space-URL prefilled)
 *   - ✏️    edit own message (own messages only — Chat enforces it
 *          server-side too)
 *   - 🗑️    delete own message (own messages only — same)
 */
export default function ChatReactionsRow({
  messageName,
  reactions,
  project,
  threadName,
  text,
  isMine,
  spaceUrl,
  authorName,
}: {
  messageName: string;
  reactions: ChatReaction[];
  /** Project name — used by the inline reply path to resolve the
   *  Chat space ID for posting. */
  project: string;
  /** Thread resource name — replies posted here land in this thread
   *  rather than starting a new one. Falls back to the message's
   *  own name when the thread.name field is unset (single-message
   *  threads). */
  threadName: string;
  /** Plain message body — needed by both convert (prefill) and edit
   *  (initial value), and shown excerpted in delete confirmation. */
  text: string;
  /** True when the viewing user authored the message. Gates ✏️/🗑️. */
  isMine: boolean;
  /** Shareable URL of the project's Chat space — added to the task
   *  body by ConvertChatMessageToTaskButton as a back-pointer. */
  spaceUrl: string;
  /** Author display name — shown in the converted task's body. */
  authorName: string;
}) {
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyValue, setReplyValue] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function reactCall(emoji: string, action: "add" | "remove") {
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

  function submitReply() {
    const t = replyValue.trim();
    if (!t) {
      setReplyError("תגובה לא יכולה להיות ריקה.");
      return;
    }
    if (t.length > MAX_REPLY) {
      setReplyError(`ארוך מדי (${t.length}/${MAX_REPLY}).`);
      return;
    }
    setReplyError(null);
    const sending = t;
    setReplyValue("");
    setReplyOpen(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/chat/post", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project, text: sending, threadName }),
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
        setReplyValue(sending);
        setReplyError(e instanceof Error ? e.message : String(e));
        setReplyOpen(true);
      }
    });
  }

  function onReplyKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submitReply();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setReplyOpen(false);
    }
  }

  return (
    <>
      <div className="chat-reactions">
        {reactions.map((r, i) => (
          <span key={i} className="chat-reaction-chip">
            <button
              type="button"
              className="chat-reaction"
              onClick={() => reactCall(r.emoji, "add")}
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
              onClick={() => reactCall(r.emoji, "remove")}
              disabled={isPending}
              title="הסר את התגובה שלי"
              aria-label="הסר תגובה"
            >
              ×
            </button>
          </span>
        ))}
        {/* + opens an emoji picker; icon-only, sits inline with chips. */}
        <button
          type="button"
          className="chat-reaction-add"
          onClick={() => {
            setPickerOpen((o) => !o);
            setReplyOpen(false);
          }}
          disabled={isPending}
          title="הוסף תגובה חדשה"
          aria-label="הוסף תגובה חדשה"
        >
          +
        </button>
        {/* ↩ opens an inline reply textarea below this row. Icon-only
            to match the picker button — both are quick-action chips
            of the same visual weight. */}
        <button
          type="button"
          className="chat-reaction-add"
          onClick={() => {
            setReplyOpen((o) => !o);
            setPickerOpen(false);
          }}
          disabled={isPending}
          title="השב לשרשור"
          aria-label="השב לשרשור"
        >
          ↩
        </button>
        {/* 📋 convert this Chat message into a hub task. Server-rendered
            link (no client state) — deeplinks to /tasks/new with the
            body, title, and Chat-space back-pointer prefilled. */}
        <ConvertChatMessageToTaskButton
          project={project}
          messageText={text}
          authorName={authorName}
          chatSpaceUrl={spaceUrl}
        />
        {/* ✏️ / 🗑️ — own messages only. Chat REST enforces author-only
            for both edit and delete; we mirror the gate client-side
            so users don't see actions they can't perform. */}
        {isMine && (
          <EditChatMessageDrawer messageName={messageName} initialText={text} />
        )}
        {isMine && (
          <DeleteChatMessageButton
            messageName={messageName}
            bodyExcerpt={text}
          />
        )}
        {pickerOpen && (
          <div className="chat-reaction-picker" role="menu">
            {COMMON_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                className="chat-reaction-picker-item"
                onClick={() => reactCall(e, "add")}
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
      {replyOpen && (
        <div className="chat-message-toolbar-reply">
          <textarea
            className="reply-textarea"
            rows={2}
            value={replyValue}
            placeholder="כתוב תגובה לשרשור… (⌘/Ctrl+Enter לשליחה, Esc לביטול)"
            onChange={(e) => setReplyValue(e.target.value)}
            onKeyDown={onReplyKeyDown}
            disabled={isPending}
            maxLength={MAX_REPLY + 1}
            autoFocus
          />
          <div className="chat-message-toolbar-reply-foot">
            {replyError && <span className="reply-error">{replyError}</span>}
            <span className="reply-drawer-spacer" />
            <button
              type="button"
              className="reply-btn reply-btn-ghost"
              onClick={() => setReplyOpen(false)}
              disabled={isPending}
            >
              ביטול
            </button>
            <button
              type="button"
              className="reply-btn reply-btn-primary"
              onClick={submitReply}
              disabled={
                isPending ||
                replyValue.trim().length === 0 ||
                replyValue.trim().length > MAX_REPLY
              }
            >
              {isPending ? "שולח…" : "שלח"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
