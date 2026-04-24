"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  taskId: string;
};

const MAX = 4000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type UploadResponse =
  | { ok: true; fileId: string; name: string; mimeType: string; viewUrl: string; embedUrl: string }
  | { ok: false; error: string };

/**
 * Permanent composer at the bottom of a task's comment thread. POSTs to
 * `/api/comments/reply` with `parentCommentId=taskId` — the Apps Script
 * `postReplyForUser_` handler treats a task row as a valid top-level parent
 * (it just needs `parent_id===''`, which tasks satisfy).
 *
 * Paste/drop an image → uploads the bytes to the task's Drive folder via
 * `/api/worktasks/upload`, then inserts an `![name](driveUrl)` token into
 * the textarea at the cursor. The comment renderer detects these tokens
 * and shows the image inline.
 */
export default function TaskReplyComposer({ taskId }: Props) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function insertAtCursor(text: string) {
    const el = textareaRef.current;
    if (!el) {
      setValue((v) => v + text);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    setValue(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  }

  async function uploadFile(file: File): Promise<void> {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`הקובץ גדול מדי (${Math.round(file.size / 1024 / 1024)}MB, מקסימום 25MB).`);
      return;
    }
    const form = new FormData();
    form.set("taskId", taskId);
    form.set("file", file, file.name || "pasted-image.png");
    setUploading((n) => n + 1);
    setError(null);
    try {
      const res = await fetch("/api/worktasks/upload", {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as UploadResponse;
      if (!res.ok || !("ok" in data) || !data.ok) {
        const msg = ("error" in data && data.error) || `העלאה נכשלה (${res.status})`;
        throw new Error(msg);
      }
      const isImage = (file.type || data.mimeType || "").startsWith("image/");
      const safeName = (data.name || file.name || "file").replace(/[\[\]()]/g, "");
      const token = isImage
        ? `\n![${safeName}](${data.viewUrl})\n`
        : `\n[📎 ${safeName}](${data.viewUrl})\n`;
      insertAtCursor(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading((n) => Math.max(0, n - 1));
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    e.preventDefault();
    imgs.forEach((f) => {
      void uploadFile(f);
    });
  }

  function onDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    Array.from(files).forEach((f) => {
      void uploadFile(f);
    });
  }

  function onDragOver(e: React.DragEvent<HTMLTextAreaElement>) {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
    }
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
    if (uploading > 0) {
      setError("ממתינים להעלאה לסיום…");
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
        placeholder="כתוב תגובה… (⌘/Ctrl+Enter לשליחה · הדבק צילום מסך או גרור קובץ)"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={onDragOver}
        disabled={isPending}
        maxLength={MAX + 1}
      />
      <div className="reply-drawer-foot">
        <span className={`reply-count ${over ? "is-over" : ""}`}>
          {count}/{MAX}
        </span>
        {uploading > 0 && (
          <span className="reply-uploading">
            ⏳ מעלה {uploading > 1 ? `(${uploading})` : ""}…
          </span>
        )}
        {error && <span className="reply-error">{error}</span>}
        <span className="reply-drawer-spacer" />
        <button
          type="button"
          className="reply-btn reply-btn-primary"
          onClick={submit}
          disabled={isPending || count === 0 || over || uploading > 0}
        >
          {isPending ? "שולח…" : "שלח"}
        </button>
      </div>
    </div>
  );
}
