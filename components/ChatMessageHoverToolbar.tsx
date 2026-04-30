"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import EditChatMessageDrawer from "@/components/EditChatMessageDrawer";
import DeleteChatMessageButton from "@/components/DeleteChatMessageButton";
import ConvertChatMessageToTaskButton from "@/components/ConvertChatMessageToTaskButton";

const COMMON_EMOJIS = ["👍", "❤️", "😄", "🎉", "👀", "🙏", "✅", "🔥"];
const MAX_REPLY = 4000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type ReplyAttachment = {
  /** Local id assigned client-side so we can match a chip to its
   *  upload completion / error event without relying on (filename,
   *  status) pairs that aren't unique. */
  tempId: string;
  name: string;
  mimeType: string;
  isImage: boolean;
  uploading: boolean;
  /** Set once /api/chat/upload returns. Used in the POST payload. */
  resourceName: string;
  /** Set when the upload failed; renders an inline ⚠️ + error tip. */
  error?: string;
};

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
  const [attachments, setAttachments] = useState<ReplyAttachment[]>([]);
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadingCount = attachments.filter((a) => a.uploading).length;

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

  async function uploadFile(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setReplyError(
        `הקובץ גדול מדי (${Math.round(file.size / 1024 / 1024)}MB, מקסימום 25MB).`,
      );
      return;
    }
    const tempId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `att_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const isImage = (file.type || "").startsWith("image/");
    setAttachments((prev) => [
      ...prev,
      {
        tempId,
        name: file.name || "file",
        mimeType: file.type || "application/octet-stream",
        isImage,
        uploading: true,
        resourceName: "",
      },
    ]);
    const form = new FormData();
    form.set("project", project);
    form.set("file", file, file.name || "pasted-image.png");
    try {
      const res = await fetch("/api/chat/upload", {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        resourceName?: string;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.resourceName) {
        throw new Error(data.error || `Upload failed (${res.status})`);
      }
      setAttachments((prev) =>
        prev.map((a) =>
          a.tempId === tempId
            ? { ...a, uploading: false, resourceName: data.resourceName! }
            : a,
        ),
      );
    } catch (e) {
      setAttachments((prev) =>
        prev.map((a) =>
          a.tempId === tempId
            ? {
                ...a,
                uploading: false,
                error: e instanceof Error ? e.message : String(e),
              }
            : a,
        ),
      );
    }
  }

  function pickFiles(files: FileList | null) {
    if (!files) return;
    Array.from(files).forEach((f) => void uploadFile(f));
    // Reset input so picking the same file twice still triggers onChange.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeAttachment(tempId: string) {
    setAttachments((prev) => prev.filter((a) => a.tempId !== tempId));
  }

  function submitReply() {
    const t = replyValue.trim();
    const okAttachments = attachments.filter(
      (a) => !a.uploading && !a.error && a.resourceName,
    );
    if (!t && okAttachments.length === 0) {
      setReplyError("תגובה לא יכולה להיות ריקה.");
      return;
    }
    if (t.length > MAX_REPLY) {
      setReplyError(`ארוך מדי (${t.length}/${MAX_REPLY}).`);
      return;
    }
    if (uploadingCount > 0) {
      setReplyError("ממתינים להעלאה לסיום…");
      return;
    }
    setReplyError(null);
    const sending = t;
    const sendingAtt = okAttachments.map((a) => ({
      resourceName: a.resourceName,
    }));
    setReplyValue("");
    setAttachments([]);
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
            attachments: sendingAtt.length > 0 ? sendingAtt : undefined,
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
        // Restore the user's draft + any attachments so they can retry.
        setReplyValue(sending);
        setAttachments((prev) => [...okAttachments, ...prev]);
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
          {attachments.length > 0 && (
            <div className="chat-composer-attachments">
              {attachments.map((a) => (
                <span key={a.tempId} className="chat-composer-attachment">
                  <span
                    className="chat-composer-attachment-icon"
                    aria-hidden
                  >
                    {a.isImage ? "🖼" : "📎"}
                  </span>
                  <span className="chat-composer-attachment-name">
                    {a.name}
                  </span>
                  {a.uploading && (
                    <span className="chat-composer-attachment-status">
                      ⏳
                    </span>
                  )}
                  {a.error && (
                    <span
                      className="chat-composer-attachment-status"
                      title={a.error}
                    >
                      ⚠️
                    </span>
                  )}
                  {a.error && (
                    <span
                      className="chat-composer-attachment-error"
                      title={a.error}
                    >
                      {a.error.length > 60
                        ? a.error.slice(0, 57) + "…"
                        : a.error}
                    </span>
                  )}
                  <button
                    type="button"
                    className="chat-composer-attachment-remove"
                    onClick={() => removeAttachment(a.tempId)}
                    title="הסר קובץ"
                    aria-label="הסר קובץ"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="chat-message-toolbar-reply-foot">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => pickFiles(e.target.files)}
            />
            <button
              type="button"
              className="reply-btn reply-btn-ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={isPending}
              title="צרף קובץ — נשמר במרחב הצ׳אט של הפרויקט"
            >
              📎
            </button>
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
                uploadingCount > 0 ||
                (replyValue.trim().length === 0 &&
                  attachments.filter(
                    (a) => !a.uploading && !a.error && a.resourceName,
                  ).length === 0) ||
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
