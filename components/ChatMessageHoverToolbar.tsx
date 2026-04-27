"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import EditChatMessageDrawer from "@/components/EditChatMessageDrawer";
import DeleteChatMessageButton from "@/components/DeleteChatMessageButton";
import ConvertChatMessageToTaskButton from "@/components/ConvertChatMessageToTaskButton";

const COMMON_EMOJIS = ["👍", "❤️", "😄", "🎉", "👀", "🙏", "✅", "🔥"];
const MAX_REPLY = 4000;

/**
 * Chat-style hover toolbar that floats at the top-right of each
 * message. Consolidates the previously-scattered actions into a
 * single discoverable affordance — the user hovers, sees the
 * options, picks one. No more hunting for the reply trigger below
 * the thread or the emoji picker on the chips row.
 *
 * Buttons (RTL order, right-to-left):
 *   - 😊 React  → opens a small popover with 8 common emojis;
 *                 picking one POSTs to /api/chat/react and refreshes
 *   - ↩ Reply   → expands an inline textarea below the message;
 *                 ⌘/Ctrl+Enter sends, Esc cancels
 *   - 📋 Convert → deeplink to /tasks/new with the message prefilled
 *                 (server-rendered; no transition needed)
 *   - ✏️ Edit    → own messages only — same EditChatMessageDrawer
 *                 we used inline before
 *   - 🗑️ Delete  → own messages only — same DeleteChatMessageButton
 *
 * Hidden by default; fades in on parent message hover (always-on
 * for touch). The reactions chips row + the standalone "השב לשרשור"
 * trigger below the thread stay in the layout for users who want
 * them — this toolbar adds another entry point, doesn't replace.
 */
export default function ChatMessageHoverToolbar({
  messageName,
  threadName,
  text,
  isMine,
  project,
  spaceUrl,
  authorName,
}: {
  messageName: string;
  /** Full thread resource name; used by the inline reply composer
   *  to post into the same thread instead of starting a new one. */
  threadName: string;
  text: string;
  isMine: boolean;
  project: string;
  spaceUrl: string;
  authorName: string;
}) {
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyValue, setReplyValue] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function react(emoji: string) {
    if (isPending) return;
    startTransition(async () => {
      try {
        const res = await fetch("/api/chat/react", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageName, emoji, action: "add" }),
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
        // Best-effort — surface in alert; toolbar UI doesn't have a
        // dedicated error region.
        alert(e instanceof Error ? e.message : String(e));
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
          body: JSON.stringify({
            project,
            text: sending,
            threadName,
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
      <div className="chat-message-toolbar" role="toolbar">
        <button
          type="button"
          className="chat-message-toolbar-btn"
          onClick={() => {
            setPickerOpen((o) => !o);
            setReplyOpen(false);
          }}
          disabled={isPending}
          title="הוסף תגובה"
          aria-label="הוסף תגובה"
        >
          😊
        </button>
        <button
          type="button"
          className="chat-message-toolbar-btn"
          onClick={() => {
            setReplyOpen((o) => !o);
            setPickerOpen(false);
          }}
          disabled={isPending}
          title="השב בשרשור"
          aria-label="השב בשרשור"
        >
          ↩
        </button>
        <ConvertChatMessageToTaskButton
          project={project}
          messageText={text}
          authorName={authorName}
          chatSpaceUrl={spaceUrl}
        />
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
          <div className="chat-message-toolbar-picker" role="menu">
            {COMMON_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                className="chat-reaction-picker-item"
                onClick={() => react(e)}
                disabled={isPending}
              >
                {e}
              </button>
            ))}
          </div>
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
            {replyError && (
              <span className="reply-error">{replyError}</span>
            )}
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
