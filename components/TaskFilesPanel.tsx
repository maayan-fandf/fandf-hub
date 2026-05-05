"use client";

/**
 * Unified files panel for a task — replaces the scattered "folder
 * picker / Drive Picker / no-tile-UI" model with a single component
 * that does:
 *   1. Show the current folder breadcrumb (company › project › בריף).
 *   2. List files inside the folder as draggable tiles.
 *   3. Persist a per-task manual order via `task.file_order`.
 *   4. Accept drag-drop uploads directly into the folder (zero clicks
 *      — files go straight up via /api/drive/folders/upload, which
 *      uses the SA so it doesn't depend on the user's drive.file
 *      OAuth scope).
 *
 * Mounted on /tasks/[id] today; will eventually replace the inline
 * DriveFolderPicker on /tasks/new too. The custom inline picker stays
 * dormant in the repo for now in case we need to revert.
 *
 * Drift handling — Drive is the source of truth for the FILE SET; we
 * only own the manual ORDER. Files appearing in Drive but not in
 * `file_order` render appended (modified-date desc, the natural
 * upload order). IDs in `file_order` no longer in Drive are silently
 * dropped on the next reorder save.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  iconLink: string;
  webViewLink: string;
  modifiedTime: string;
  size?: string;
  thumbnailLink?: string;
};

type Props = {
  taskId: string;
  /** The task's Drive folder ID. When empty, the panel renders an
   *  empty state pointing the user to either pick or create a folder
   *  via the existing DriveFolderPicker affordances on the edit panel. */
  folderId: string;
  /** Open-in-Drive URL for the folder itself — surfaces as the
   *  breadcrumb's right-side action button. */
  folderUrl?: string;
  /** Breadcrumb pieces — derived from existing task fields, no extra
   *  Drive call needed. */
  company?: string;
  project?: string;
  campaign?: string;
  taskTitle?: string;
  /** Stored file order CSV. Empty string means no manual order yet —
   *  files render in modified-date desc. */
  fileOrder: string;
};

export default function TaskFilesPanel({
  taskId,
  folderId,
  folderUrl,
  company,
  project,
  campaign,
  taskTitle,
  fileOrder,
}: Props) {
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [orderCsv, setOrderCsv] = useState(fileOrder);
  const [savingOrder, setSavingOrder] = useState(false);
  const [uploadingNames, setUploadingNames] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Tiny activation distance so accidental clicks don't start
      // drags but a deliberate drag starts immediately.
      activationConstraint: { distance: 4 },
    }),
  );

  const reload = useCallback(async () => {
    if (!folderId) {
      setFiles([]);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(
        `/api/drive/folders/files?parent=${encodeURIComponent(folderId)}`,
        { cache: "no-store" },
      );
      const d = (await r.json()) as
        | { ok: true; files: DriveFile[] }
        | { ok: false; error: string };
      if (!r.ok || !("ok" in d) || !d.ok) {
        throw new Error(("error" in d && d.error) || `HTTP ${r.status}`);
      }
      setFiles(d.files);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Apply the stored order to the freshly-fetched file set:
  //   - IDs in orderCsv that still exist → in stored order
  //   - Files in Drive but not in orderCsv → appended (Drive returns
  //     modifiedTime desc, so naturally newest-first)
  const ordered = useMemo<DriveFile[]>(() => {
    if (!files || files.length === 0) return [];
    const orderIds = orderCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const byId = new Map(files.map((f) => [f.id, f]));
    const seen = new Set<string>();
    const out: DriveFile[] = [];
    for (const id of orderIds) {
      const f = byId.get(id);
      if (f && !seen.has(id)) {
        out.push(f);
        seen.add(id);
      }
    }
    for (const f of files) {
      if (!seen.has(f.id)) {
        out.push(f);
        seen.add(f.id);
      }
    }
    return out;
  }, [files, orderCsv]);

  async function persistOrder(nextOrder: string[]) {
    setSavingOrder(true);
    try {
      const r = await fetch(`/api/worktasks/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: taskId,
          patch: { file_order: nextOrder.join(",") },
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error || `HTTP ${r.status}`);
      }
    } catch (e) {
      // Roll back on save failure so the UI doesn't lie about state.
      setOrderCsv(fileOrder);
      setErr(
        "שמירת הסדר נכשלה: " +
          (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setSavingOrder(false);
    }
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const activeIdx = ordered.findIndex((f) => f.id === active.id);
    const overIdx = ordered.findIndex((f) => f.id === over.id);
    if (activeIdx < 0 || overIdx < 0) return;
    const next = arrayMove(ordered, activeIdx, overIdx).map((f) => f.id);
    setOrderCsv(next.join(","));
    void persistOrder(next);
  }

  async function handleFiles(filesToUpload: FileList | File[]) {
    if (!folderId) return;
    const list = Array.from(filesToUpload);
    if (list.length === 0) return;
    setUploadingNames((cur) => [...cur, ...list.map((f) => f.name)]);
    try {
      // Upload sequentially — keeps the App Hosting container's memory
      // bounded (each upload buffers the file fully before sending) and
      // surfaces errors in order. Parallel would be faster but the
      // failure mode (partial upload, mixed success/error) is messier.
      for (const f of list) {
        const fd = new FormData();
        fd.append("parent", folderId);
        fd.append("file", f);
        const r = await fetch("/api/drive/folders/upload", {
          method: "POST",
          body: fd,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d?.ok) {
          throw new Error(d?.error || `HTTP ${r.status}`);
        }
      }
      // Re-fetch after all uploads land — simpler than splicing
      // returned files into local state and avoids drift if multiple
      // uploads from different sessions race.
      await reload();
    } catch (e) {
      setErr(
        "העלאה נכשלה: " + (e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setUploadingNames((cur) =>
        cur.filter((n) => !list.some((f) => f.name === n)),
      );
    }
  }

  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <section
      className="task-files-panel"
      onDragOver={(e) => {
        if (!folderId) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!folderId) return;
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length > 0) {
          void handleFiles(e.dataTransfer.files);
        }
      }}
      data-drag-over={dragOver ? "1" : undefined}
    >
      <header className="task-files-panel-head">
        <div className="task-files-breadcrumb">
          <span aria-hidden>📁</span>
          {[company, project, campaign, taskTitle]
            .filter(Boolean)
            .map((s, i, arr) => (
              <span key={i}>
                <span className="task-files-breadcrumb-piece">{s}</span>
                {i < arr.length - 1 && (
                  <span aria-hidden className="task-files-breadcrumb-sep">
                    {" › "}
                  </span>
                )}
              </span>
            ))}
        </div>
        <div className="task-files-panel-actions">
          {folderUrl && (
            <a
              href={folderUrl}
              target="_blank"
              rel="noreferrer"
              className="btn-ghost btn-sm"
              title="פתח את התיקייה ב-Drive"
            >
              ↗ פתח ב-Drive
            </a>
          )}
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={!folderId || uploadingNames.length > 0}
          >
            ⬆ העלה קבצים
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </header>

      {!folderId && (
        <div className="task-files-empty">
          אין תיקיית Drive מקושרת. עבור למצב עריכה כדי לבחור או ליצור תיקייה.
        </div>
      )}

      {folderId && loading && files === null && (
        <div className="task-files-empty">טוען…</div>
      )}

      {folderId && err && (
        <div className="task-files-error" role="alert">
          {err}
          <button
            type="button"
            className="task-files-error-retry"
            onClick={() => void reload()}
          >
            נסה שוב
          </button>
        </div>
      )}

      {folderId && files && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={ordered.map((f) => f.id)}
            strategy={rectSortingStrategy}
          >
            <div className="task-files-grid">
              {ordered.map((f) => (
                <FileTile key={f.id} file={f} />
              ))}
              {uploadingNames.map((n) => (
                <div key={`up-${n}`} className="task-files-tile is-uploading">
                  <div className="task-files-tile-icon">⬆</div>
                  <div className="task-files-tile-name">{n}</div>
                </div>
              ))}
              {ordered.length === 0 && uploadingNames.length === 0 && (
                <div className="task-files-empty task-files-empty-grid">
                  אין קבצים. גרור לכאן או לחץ ״העלה קבצים״.
                </div>
              )}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {savingOrder && (
        <div className="task-files-saving" aria-live="polite">
          שומר סדר…
        </div>
      )}

      <div className="task-files-drop-hint" aria-hidden>
        גרור קבצים מהמחשב לכל מקום בתוך הפאנל כדי להעלות.
      </div>
    </section>
  );
}

function FileTile({ file }: { file: DriveFile }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: file.id });
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`task-files-tile${isDragging ? " is-dragging" : ""}`}
      {...attributes}
      {...listeners}
    >
      <a
        href={file.webViewLink}
        target="_blank"
        rel="noreferrer"
        // The drag listeners cover the whole tile; we still need the
        // anchor to fire on click. Stop propagation so a click doesn't
        // race the drag's pointer-down activation.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className="task-files-tile-link"
        title={file.name}
      >
        {file.iconLink ? (
          // Drive's `iconLink` is a small (16x16) icon URL. We render
          // it 2x scaled for tile clarity. Falls back to a 📄 emoji
          // when missing.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={file.iconLink.replace(/\/16\//, "/32/")}
            alt=""
            className="task-files-tile-icon"
            width={32}
            height={32}
          />
        ) : (
          <div className="task-files-tile-icon">📄</div>
        )}
        <div className="task-files-tile-name">{file.name}</div>
      </a>
    </div>
  );
}
