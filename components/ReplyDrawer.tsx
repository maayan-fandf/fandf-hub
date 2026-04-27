"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  /** The top-level comment being replied to. Replies to replies aren't allowed. */
  parentCommentId: string;
  /** Project the comment lives on. Required to enable file attachments —
   *  uploads land in `<Shared Drive>/<company>/<project>/הערות/`. When
   *  absent, the attach UI is hidden (some callers render this drawer
   *  without project context). */
  project?: string;
  /** Optional label for the trigger button. Default: "השב". */
  label?: string;
  /** If true, render the trigger as an icon-only button (↩) with the label in
   *  a tooltip. Used by CardActions for the unified icon-row layout. */
  iconOnly?: boolean;
};

const MAX = 4000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type UploadResponse =
  | {
      ok: true;
      fileId: string;
      name: string;
      mimeType: string;
      viewUrl: string;
      embedUrl: string;
    }
  | { ok: false; error: string };

/**
 * Click "Reply" → reveals an inline textarea. Submit posts via
 * /api/comments/reply and calls router.refresh() on success.
 * Esc closes the drawer without sending.
 *
 * When `project` is set, the drawer also accepts file attachments via
 * paste, drag-drop, or a small "📎 צרף קובץ" button. Files upload to
 * the project's הערות subfolder via /api/comments/upload and are
 * inserted into the body as markdown links / images — same convention
 * as CreateTaskDrawer / TaskReplyComposer.
 */
export default function ReplyDrawer({
  parentCommentId,
  project,
  label = "השב",
  iconOnly = false,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function openDrawer() {
    setOpen(true);
    setError(null);
    setUploadError(null);
    // Focus after the textarea mounts.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function closeDrawer() {
    setOpen(false);
    setValue("");
    setError(null);
    setUploadError(null);
    setUploading(0);
  }

  /** Insert text at the textarea cursor (or append). Used by the
   *  upload helpers to drop the markdown link/image into the body
   *  exactly where the user's cursor was. */
  function insertAtCursor(text: string) {
    setValue((prev) => {
      const ta = textareaRef.current;
      if (!ta) return prev + text;
      const start = ta.selectionStart ?? prev.length;
      const end = ta.selectionEnd ?? prev.length;
      const next = prev.slice(0, start) + text + prev.slice(end);
      requestAnimationFrame(() => {
        const pos = start + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
      });
      return next;
    });
  }

  async function uploadFile(file: File): Promise<void> {
    if (!project) {
      setUploadError("צירוף קבצים אינו זמין כאן.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError(
        `הקובץ גדול מדי (${Math.round(file.size / 1024 / 1024)}MB, מקסימום 25MB).`,
      );
      return;
    }
    const form = new FormData();
    form.set("project", project);
    form.set("file", file, file.name || "pasted-image.png");
    setUploading((n) => n + 1);
    setUploadError(null);
    try {
      const res = await fetch("/api/comments/upload", {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as UploadResponse;
      if (!res.ok || !("ok" in data) || !data.ok) {
        const msg =
          ("error" in data && data.error) || `העלאה נכשלה (${res.status})`;
        throw new Error(msg);
      }
      const safeName = (data.name || file.name || "file").replace(
        /[\[\]()]/g,
        "",
      );
      const mimeType = (file.type || data.mimeType || "").toLowerCase();
      const fromMime = mimeType.startsWith("image/");
      const fromExt = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i.test(
        safeName,
      );
      const isImage = fromMime || fromExt;
      const token = isImage
        ? `\n![${safeName}](${data.viewUrl})\n`
        : `\n[📎 ${safeName}](${data.viewUrl})\n`;
      insertAtCursor(token);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading((n) => Math.max(0, n - 1));
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!project) return;
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
    if (!project) return;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    Array.from(files).forEach((f) => {
      void uploadFile(f);
    });
  }

  function onDragOver(e: React.DragEvent<HTMLTextAreaElement>) {
    if (!project) return;
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
    }
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    Array.from(files).forEach((f) => {
      void uploadFile(f);
    });
    e.target.value = "";
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
      setError("ממתינים להעלאת קבצים…");
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
  const placeholder = project
    ? "כתוב תגובה… (הדבק/גרור קובץ לצירוף · ⌘/Ctrl+Enter לשליחה · Esc לביטול)"
    : "כתוב תגובה… (⌘/Ctrl+Enter לשליחה, Esc לביטול)";

  return (
    <div className="reply-drawer">
      <textarea
        ref={textareaRef}
        className="reply-textarea"
        rows={3}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={onDragOver}
        disabled={isPending}
        maxLength={MAX + 1}
      />
      <div className="reply-drawer-foot">
        {project && (
          <>
            <button
              type="button"
              className="create-task-attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={isPending}
              title="צרף קובץ — נשמר בתיקיית 'הערות' של הפרויקט ב-Drive"
            >
              📎 צרף קובץ
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={onPickFiles}
            />
            {uploading > 0 && (
              <span className="create-task-upload-status">
                מעלה… ({uploading})
              </span>
            )}
          </>
        )}
        <span className={`reply-count ${over ? "is-over" : ""}`}>
          {count}/{MAX}
        </span>
        {error && <span className="reply-error">{error}</span>}
        {uploadError && <span className="reply-error">{uploadError}</span>}
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
