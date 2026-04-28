"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const MAX_BYTES = 25 * 1024 * 1024;

type UploadResponse =
  | { ok: true; fileId: string; name: string; mimeType: string; viewUrl: string }
  | { ok: false; error: string };

/**
 * Drag-and-drop wrapper for the קבצים מהדיון section. Files dropped
 * anywhere on the wrapped block are uploaded to /api/worktasks/upload
 * (same endpoint the discussion composer uses). After all uploads
 * settle, `router.refresh()` re-runs the page's server component so
 * the file list re-renders with the new attachments.
 *
 * The wrapper stays passive (no overlay, no border change) until the
 * user drags files over it — then the dashed-accent ring + drop-here
 * label appear. Errors stay visible until the user dismisses them.
 */
export default function TaskAttachmentsDropzone({
  taskId,
  enabled,
  children,
}: {
  taskId: string;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const depthRef = useRef(0);
  const router = useRouter();

  function onDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!enabled) return;
    if (!e.dataTransfer?.types?.includes("Files")) return;
    depthRef.current += 1;
    setDragging(true);
  }
  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!enabled) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setDragging(false);
  }
  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!enabled) return;
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
    }
  }
  async function onDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!enabled) return;
    e.preventDefault();
    depthRef.current = 0;
    setDragging(false);
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const arr = Array.from(files);
    setError(null);
    let succeeded = 0;
    for (const f of arr) {
      if (f.size > MAX_BYTES) {
        setError(
          `${f.name}: גדול מדי (${Math.round(f.size / 1024 / 1024)}MB, מקסימום 25MB)`,
        );
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const form = new FormData();
        form.set("taskId", taskId);
        form.set("file", f, f.name || `pasted-${Date.now()}`);
        const res = await fetch("/api/worktasks/upload", {
          method: "POST",
          body: form,
        });
        const data = (await res.json().catch(() => ({}))) as UploadResponse;
        if (!res.ok || !("ok" in data) || !data.ok) {
          const msg =
            ("error" in data && data.error) || `העלאה נכשלה (${res.status})`;
          throw new Error(msg);
        }
        succeeded++;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading((n) => Math.max(0, n - 1));
      }
    }
    if (succeeded > 0) router.refresh();
  }

  return (
    <div
      className={`task-attachments-dropzone${dragging ? " is-dragging-over" : ""}${uploading > 0 ? " is-uploading" : ""}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {dragging && enabled && (
        <div className="task-attachments-dropzone-overlay" aria-hidden>
          ⬇️ שחרר/י כאן להעלאה
        </div>
      )}
      {(uploading > 0 || error) && (
        <div className="task-attachments-dropzone-status" role="status">
          {uploading > 0 && (
            <span>
              ⏳ מעלה {uploading} {uploading === 1 ? "קובץ" : "קבצים"}…
            </span>
          )}
          {error && (
            <span className="task-attachments-dropzone-error">
              ⚠️ {error}
              <button
                type="button"
                onClick={() => setError(null)}
                className="task-attachments-dropzone-error-dismiss"
                aria-label="סגור"
              >
                ✕
              </button>
            </span>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
