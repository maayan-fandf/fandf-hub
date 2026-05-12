"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkTaskStatus } from "@/lib/appsScript";

/** All transitions that should pop the submission modal. Each kind
 *  shapes the modal's copy and the discussion-comment prefix:
 *
 *    submit    — any → awaiting_approval. The assignee attaches the
 *                deliverable they want the approver to review.
 *    clarify   — any → awaiting_clarification. The asker (assignee
 *                from in_progress, or approver from awaiting_approval)
 *                attaches what's unclear + a question.
 *    reject    — awaiting_approval → in_progress | awaiting_handling.
 *                The approver bounces work back with feedback on what
 *                to fix. Without this, an assignee just saw a "task
 *                returned" ping with no explanation. */
export type TransitionKind = "submit" | "clarify" | "reject" | "answer";

/** Resolve the modal kind for a (from, to) transition, or `null` if
 *  this transition shouldn't pop the modal. Exported so call sites
 *  (TaskStatusCell / TasksKanban / TaskStatusActions) share one rule
 *  for "should the modal open?" and "what kind is it?" instead of
 *  maintaining parallel Sets that can drift. */
export function getModalTransitionKind(
  from: WorkTaskStatus | string,
  to: WorkTaskStatus | string,
): TransitionKind | null {
  if (to === "awaiting_approval") return "submit";
  if (to === "awaiting_clarification") return "clarify";
  if (
    from === "awaiting_approval" &&
    (to === "in_progress" || to === "awaiting_handling")
  ) {
    return "reject";
  }
  // Author answering an approver's clarification request — captured by
  // the 💬 ענה והחזר לעבודה button on the clarification-mode banner. Without
  // this case the modal returned null and clicking the button silently
  // did nothing. Reported by Maayan 2026-05-12.
  if (from === "awaiting_clarification" && to === "in_progress") {
    return "answer";
  }
  return null;
}

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

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_NOTE = 800;

type Props = {
  taskId: string;
  /** Current status the task is being moved away from. Required so the
   *  modal can distinguish "approver rejects" (awaiting_approval →
   *  in_progress) from "assignee picks up" (awaiting_handling →
   *  in_progress) — only the former should open this UI. */
  fromStatus: WorkTaskStatus;
  /** Target status. Combined with `fromStatus` via
   *  `getModalTransitionKind` to pick the modal's copy + comment
   *  prefix. */
  newStatus: WorkTaskStatus;
  open: boolean;
  onClose: () => void;
};

/**
 * Submission modal that pops in when the user transitions a task to
 * "ממתין לאישור" or "ממתין לבירור". Captures one of:
 *   - a Drive file (uploaded via /api/worktasks/upload, same path the
 *     comment composer uses)
 *   - a URL link (e.g. Figma, external preview)
 *   - a free-text note (optional alongside either, or by itself)
 *
 * On submit:
 *   1. Posts a comment to the task discussion via /api/comments/reply
 *      with a header line like "🔍 הוגש לאישור" so the approver / author
 *      sees the submission in the regular discussion feed.
 *   2. Flips the task status via /api/worktasks/update — that fires the
 *      existing task_awaiting_approval / task_returned notification so
 *      the recipient gets pinged about it.
 *   3. router.refresh() pulls in both the new comment + the new status.
 *
 * Either a file OR a link OR a non-empty note is required — submitting
 * blank doesn't fit the flow (the recipient would have nothing to act
 * on). Both file + link are fine if the user wants to attach multiple.
 */
export default function TaskTransitionModal({
  taskId,
  fromStatus,
  newStatus,
  open,
  onClose,
}: Props) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset whenever the modal closes so a second open doesn't carry
  // over a half-typed previous submission.
  useEffect(() => {
    if (!open) {
      setFile(null);
      setUrl("");
      setNote("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const kind = getModalTransitionKind(fromStatus, newStatus);
  // Defensive: caller is expected to only mount the modal for
  // transitions that have a kind. If somehow we slip in with a
  // non-modal pair we render nothing rather than show a confusing
  // half-configured dialog.
  if (!kind) return null;

  const titleText =
    kind === "submit"
      ? "הגשה לאישור"
      : kind === "clarify"
        ? "מה לא ברור?"
        : kind === "reject"
          ? "החזרה לתיקון"
          : "מענה לבקשת בירור";
  const subtitle =
    kind === "submit"
      ? "צרף קובץ או קישור לעבודה שאתה מגיש לאישור. הגורם המאשר יקבל התראה ויראה את ההגשה בדיון."
      : kind === "clarify"
        ? "צרף קובץ או קישור (למשל צילום של החלק הלא ברור) ופרט במה צריך עזרה. הכותב יקבל התראה ויראה את הבקשה בדיון."
        : kind === "reject"
          ? "פרט/י מה לא אושר ומה צריך לתקן. אפשר לצרף קובץ או קישור עם הערות. המבצע/ת יקבל/ת התראה ויראה/תראה את המשוב בדיון."
          : "כתוב/י את התשובה לבקשת הבירור. אפשר לצרף קובץ או קישור. הגורם המאשר יקבל התראה ויראה את התשובה בדיון, והמשימה תחזור לסטטוס בעבודה.";
  const submitLabel =
    kind === "submit"
      ? "שלח לאישור"
      : kind === "clarify"
        ? "בקש בירור"
        : kind === "reject"
          ? "שלח לתיקון"
          : "ענה והחזר לעבודה";
  const commentPrefix =
    kind === "submit"
      ? "🔍 הוגש לאישור"
      : kind === "clarify"
        ? "❓ ממתין לבירור"
        : kind === "reject"
          ? "🔄 הוחזר לתיקון"
          : "💬 מענה לבירור";

  function pickFile() {
    fileInputRef.current?.click();
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) {
      setError(
        `הקובץ גדול מדי (${Math.round(f.size / 1024 / 1024)}MB, מקסימום 25MB).`,
      );
      return;
    }
    if (f.size === 0) {
      setError("הקובץ ריק. נסה/י לבחור אחר.");
      return;
    }
    setFile(f);
    setError(null);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) {
      setError(
        `הקובץ גדול מדי (${Math.round(f.size / 1024 / 1024)}MB, מקסימום 25MB).`,
      );
      return;
    }
    setFile(f);
    setError(null);
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  }

  async function uploadFile(f: File): Promise<UploadResponse> {
    const form = new FormData();
    form.set("taskId", taskId);
    form.set("file", f, f.name || "attachment");
    const res = await fetch("/api/worktasks/upload", {
      method: "POST",
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as UploadResponse;
    if (!res.ok || !("ok" in data) || !data.ok) {
      const msg = ("error" in data && data.error) || `העלאה נכשלה (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  function buildCommentBody(
    uploaded: Extract<UploadResponse, { ok: true }> | null,
  ): string {
    const lines: string[] = [];
    const headLine = note.trim()
      ? `${commentPrefix}: ${note.trim()}`
      : commentPrefix;
    lines.push(headLine);

    if (url.trim()) lines.push(url.trim());

    if (uploaded) {
      const safeName = (uploaded.name || "file").replace(/[\[\]()]/g, "");
      const mime = (uploaded.mimeType || "").toLowerCase();
      const isImage =
        mime.startsWith("image/") ||
        /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i.test(safeName);
      lines.push(
        isImage
          ? `![${safeName}](${uploaded.viewUrl})`
          : `[📎 ${safeName}](${uploaded.viewUrl})`,
      );
    }
    return lines.join("\n\n");
  }

  async function submit() {
    setError(null);
    const hasUrl = !!url.trim();
    const hasFile = !!file;
    const hasNote = !!note.trim();
    if (!hasUrl && !hasFile && !hasNote) {
      setError("צרף/י קובץ, הדבק/י קישור או כתוב/י הסבר.");
      return;
    }
    if (note.length > MAX_NOTE) {
      setError(`ההסבר ארוך מדי (${note.length}/${MAX_NOTE}).`);
      return;
    }
    setBusy(true);
    try {
      // 1. Upload the file first (if any) so the comment we post next
      //    can already reference the Drive viewUrl. Doing it in this
      //    order means a transient upload failure aborts the whole
      //    submission BEFORE we change the task's status — the user can
      //    correct and retry without leaving the task half-flipped.
      let uploaded: Extract<UploadResponse, { ok: true }> | null = null;
      if (file) {
        const r = await uploadFile(file);
        if (!("ok" in r) || !r.ok) {
          throw new Error("upload failed");
        }
        uploaded = r;
      }

      // 2. Post the submission comment. Same /api/comments/reply
      //    endpoint the discussion composer uses; parentCommentId=taskId
      //    makes the task row itself the parent.
      const commentBody = buildCommentBody(uploaded);
      const commentRes = await fetch("/api/comments/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentCommentId: taskId, body: commentBody }),
      });
      if (!commentRes.ok) {
        const data = (await commentRes.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || `Comment failed (${commentRes.status})`);
      }

      // 3. Flip the status. The patch's `note` field is logged into
      //    status_history; we now build a rich one-line summary so the
      //    timeline reads usefully without the user having to scroll
      //    to the discussion. Shape:
      //      <label> · <note snippet> · <attachment hint>
      //    where each segment is optional and any combination of
      //    file/url/note feeds in. The full submission detail still
      //    lives on the comment we just posted — this is just the
      //    timeline-friendly summary. ~200 chars cap keeps the row
      //    visually tidy even for long feedback.
      const label =
        kind === "submit"
          ? "הוגש לאישור"
          : kind === "clarify"
            ? "בקשת בירור"
            : kind === "reject"
              ? "החזרה לתיקון"
              : "מענה לבירור";
      const NOTE_SNIPPET_MAX = 140;
      const snippet = note.trim().slice(0, NOTE_SNIPPET_MAX);
      const noteEllipsis = note.trim().length > NOTE_SNIPPET_MAX ? "…" : "";
      const attachmentHint = uploaded
        ? `קובץ: ${uploaded.name}`
        : url.trim()
          ? "קישור מצורף"
          : "";
      const shortNote = [
        label,
        snippet ? `${snippet}${noteEllipsis}` : "",
        attachmentHint,
      ]
        .filter(Boolean)
        .join(" · ");
      const updateRes = await fetch("/api/worktasks/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: taskId,
          patch: { status: newStatus, note: shortNote },
        }),
      });
      const updateData = (await updateRes.json().catch(() => ({}))) as
        | { ok: true }
        | { ok: false; error: string };
      if (!updateRes.ok || !("ok" in updateData) || !updateData.ok) {
        const msg =
          "error" in updateData && updateData.error
            ? updateData.error
            : `Update failed (${updateRes.status})`;
        throw new Error(msg);
      }

      router.refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget && !busy) onClose();
  }

  return (
    <div
      className="task-transition-modal-backdrop"
      onClick={onBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-transition-modal-title"
    >
      <div className="task-transition-modal">
        <header className="task-transition-modal-head">
          <h2 id="task-transition-modal-title">{titleText}</h2>
          <button
            type="button"
            className="task-transition-modal-close"
            onClick={onClose}
            disabled={busy}
            aria-label="סגור"
          >
            ×
          </button>
        </header>
        <p className="task-transition-modal-subtitle">{subtitle}</p>

        <div
          className="task-transition-modal-dropzone"
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          <input
            ref={fileInputRef}
            type="file"
            className="task-transition-modal-fileinput"
            onChange={onFileChosen}
          />
          {file ? (
            <div className="task-transition-modal-filechip">
              <span aria-hidden>📎</span>
              <span className="task-transition-modal-filename" dir="auto">
                {file.name}
              </span>
              <button
                type="button"
                className="task-transition-modal-removefile"
                onClick={() => setFile(null)}
                disabled={busy}
                aria-label="הסר קובץ"
              >
                ×
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="task-transition-modal-pick"
              onClick={pickFile}
              disabled={busy}
            >
              📎 בחר/י קובץ או גרור/י לכאן
            </button>
          )}
        </div>

        <label className="task-transition-modal-label">
          או הדבק/י קישור
          <input
            type="url"
            placeholder="https://www.figma.com/... · https://drive.google.com/..."
            className="task-transition-modal-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
            dir="ltr"
          />
        </label>

        <label className="task-transition-modal-label">
          {kind === "submit"
            ? "הערה (אופציונלי)"
            : kind === "clarify"
              ? "מה לא ברור?"
              : kind === "reject"
                ? "מה צריך לתקן?"
                : "התשובה"}
          <textarea
            className="task-transition-modal-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={MAX_NOTE + 1}
            disabled={busy}
            placeholder={
              kind === "submit"
                ? "הוסף/י הקשר על מה לבדוק…"
                : kind === "clarify"
                  ? "תאר/י את הנקודה שלא ברורה כדי שהכותב יוכל לענות…"
                  : kind === "reject"
                    ? "פרט/י מה לא אושר ומה צריך לתקן…"
                    : "כתוב/י את התשובה לבקשת הבירור…"
            }
            dir="auto"
          />
          <span className="task-transition-modal-count">
            {note.length}/{MAX_NOTE}
          </span>
        </label>

        {error && <div className="task-transition-modal-error">{error}</div>}

        <footer className="task-transition-modal-foot">
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={onClose}
            disabled={busy}
          >
            ביטול
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={submit}
            disabled={busy}
          >
            {busy ? "שולח…" : submitLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
