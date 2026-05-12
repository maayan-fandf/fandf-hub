"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import type { CommentItem, WorkTask, TasksPerson } from "@/lib/appsScript";
import Avatar, { avatarHoverText } from "./Avatar";
import CommentBody from "./CommentBody";
import { roleEmoji, roleLabel } from "./RoleChip";
import { displayNameOf, personDisplayName } from "@/lib/personDisplay";

type PeekFile = {
  fileId: string;
  name: string;
  mimeType: string;
  viewUrl: string;
  thumbnailLink: string;
  iconLink: string;
  modifiedTime: string;
  sizeBytes: number;
};

type PeekData = {
  comments: CommentItem[];
  files: PeekFile[];
  folderUrl: string;
};

/**
 * Task quick-preview side drawer. Mounted once at app/layout.tsx as
 * `<TaskPreviewProvider>`. Click the 👁 button on a task row to call
 * `useTaskPreview().open(task, people?)` — a slide-in panel from the
 * page's start edge (visual right in RTL) shows the task's title +
 * meta + full description without leaving /tasks.
 *
 * Pattern mirrors LightboxProvider's singleton/portal/escape-key
 * shape so the codebase has a consistent "global modal" recipe.
 *
 * UX contract:
 *   - Esc closes
 *   - Click outside the panel closes (overlay backdrop)
 *   - "פתח משימה" link inside the drawer goes to the full detail
 *     page (where the user gets the full discussion composer, status
 *     history, drag-and-drop chains, etc.)
 *   - Body scroll-locked while open
 *   - Mobile: drawer fills the viewport; desktop: ~440px wide
 *   - Discussion (last N comments) and files (Drive attachments)
 *     are fetched lazily from /api/tasks/peek when the drawer opens
 *     for a task. Read-only — the full task page is where editing
 *     happens.
 *
 * Out of scope:
 *   - Inline editing (the row already has inline editors, and the
 *     full detail page is just one click away)
 *   - Comment composer / mention picker / file upload — those live
 *     on the full task page. The peek shows the latest discussion +
 *     attachments so the user can decide whether to open the task,
 *     without lifting the full editor into the drawer.
 */

type PreviewItem = {
  task: WorkTask;
  people: TasksPerson[];
};

type TaskPreviewContextValue = {
  open: (task: WorkTask, people?: TasksPerson[]) => void;
  close: () => void;
};

const Ctx = createContext<TaskPreviewContextValue | null>(null);

export function useTaskPreview(): TaskPreviewContextValue {
  const v = useContext(Ctx);
  if (!v) {
    // Same fallback shape as useLightbox — no-op when no provider is
    // mounted (SSR / isolated tests). Callers that need a guarantee
    // should check for a provider via React DevTools; in practice the
    // layout root mounts it for every authenticated page.
    return { open: () => {}, close: () => {} };
  }
  return v;
}

const STATUS_LABEL_HE: Record<string, string> = {
  awaiting_handling: "ממתין לטיפול",
  blocked: "חסום",
  in_progress: "בעבודה",
  awaiting_clarification: "ממתין לבירור",
  awaiting_approval: "ממתין לאישור",
  done: "בוצע",
  cancelled: "בוטל",
  draft: "טיוטה",
};

export default function TaskPreviewProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [item, setItem] = useState<PreviewItem | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const open = useCallback(
    (task: WorkTask, people: TasksPerson[] = []) => {
      setItem({ task, people });
    },
    [],
  );
  const close = useCallback(() => {
    setItem(null);
  }, []);

  // Esc to close + body-scroll-lock while open.
  useEffect(() => {
    if (!item) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setItem(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [item]);

  return (
    <Ctx.Provider value={{ open, close }}>
      {children}
      {mounted &&
        item &&
        createPortal(
          <PreviewPanel item={item} onClose={close} />,
          document.body,
        )}
    </Ctx.Provider>
  );
}

function PreviewPanel({
  item,
  onClose,
}: {
  item: PreviewItem;
  onClose: () => void;
}) {
  const { task, people } = item;
  const author = people.find(
    (p) => p.email.toLowerCase() === task.author_email.toLowerCase(),
  );
  const approver = people.find(
    (p) => p.email.toLowerCase() === task.approver_email.toLowerCase(),
  );
  const assigneeRows = (task.assignees || []).map((email) => ({
    email,
    person: people.find(
      (p) => p.email.toLowerCase() === email.toLowerCase(),
    ),
  }));
  const statusLabel = STATUS_LABEL_HE[task.status] || task.status;

  // Discussion + files: lazy-fetched from /api/tasks/peek when the
  // drawer opens for a task. Both come back in one round-trip so the
  // open-the-peek interaction stays a single network call. Folder ID
  // and title are passed along from the WorkTask the client already
  // has — saves the server an extra Sheets read.
  const [peek, setPeek] = useState<PeekData | null>(null);
  const [peekLoading, setPeekLoading] = useState(false);
  const [peekError, setPeekError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPeek(null);
    setPeekError(null);
    setPeekLoading(true);
    const params = new URLSearchParams({
      id: task.id,
      folder: task.drive_folder_id || "",
      title: task.title || "",
    });
    fetch(`/api/tasks/peek?${params.toString()}`)
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as
          | { ok: true; comments: CommentItem[]; files: PeekFile[]; folderUrl: string }
          | { ok: false; error: string };
        if (cancelled) return;
        if (!r.ok || !("ok" in data) || !data.ok) {
          const msg =
            "error" in data && data.error
              ? data.error
              : `שגיאה בטעינה (${r.status})`;
          setPeekError(msg);
          return;
        }
        setPeek({
          comments: data.comments,
          files: data.files,
          folderUrl: data.folderUrl,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setPeekError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setPeekLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, task.drive_folder_id, task.title]);

  // Show the most recent few comments. The full discussion lives on
  // the task detail page — the peek is a "what just happened" glance.
  const COMMENTS_VISIBLE = 6;
  const recentComments = peek
    ? peek.comments.slice(-COMMENTS_VISIBLE)
    : [];
  const olderCount = peek
    ? Math.max(0, peek.comments.length - recentComments.length)
    : 0;

  return (
    <div
      className="task-preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`תצוגה מקדימה — ${task.title}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        className="task-preview-panel themed-scrollbar"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="task-preview-head">
          <div className="task-preview-head-meta">
            {(task.company || task.project) && (
              <div className="task-preview-crumbs">
                {task.company}
                {task.company && task.project && (
                  <span aria-hidden> · </span>
                )}
                {task.project}
              </div>
            )}
            <h2 className="task-preview-title" dir="auto">
              {task.title || "(ללא כותרת)"}
            </h2>
            <div className="task-preview-chips">
              <span className={`task-preview-status status-${task.status}`}>
                {statusLabel}
              </span>
              {task.priority === 1 && (
                <span className="task-preview-chip">🔥 גבוהה</span>
              )}
              {task.priority === 3 && (
                <span className="task-preview-chip">⏬ נמוכה</span>
              )}
              {task.is_umbrella && (
                <span className="task-preview-chip">🪆 עטיפה</span>
              )}
              {(task.departments || []).map((d) => (
                <span key={d} className="task-preview-chip" title={roleLabel(d)}>
                  {roleEmoji(d) || "🏷"} {roleLabel(d)}
                </span>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="task-preview-close"
            onClick={onClose}
            aria-label="סגור (Esc)"
            title="סגור (Esc)"
          >
            ✕
          </button>
        </header>

        <dl className="task-preview-fields">
          {task.requested_date && (
            <div className="task-preview-field">
              <dt>תאריך יעד</dt>
              <dd>{task.requested_date}</dd>
            </div>
          )}
          {task.author_email && (
            <div className="task-preview-field">
              <dt>כותב</dt>
              <dd>
                <span
                  className="task-preview-person"
                  title={avatarHoverText(
                    personDisplayName(task.author_email, people),
                    task.author_email,
                    author?.role,
                  )}
                >
                  <Avatar
                    name={task.author_email}
                    role={author?.role}
                    title={author ? displayNameOf(author) : task.author_email}
                    size={20}
                  />
                  <span>
                    {personDisplayName(task.author_email, people) ||
                      task.author_email}
                  </span>
                </span>
              </dd>
            </div>
          )}
          {task.approver_email && (
            <div className="task-preview-field">
              <dt>מאשר</dt>
              <dd>
                <span
                  className="task-preview-person"
                  title={avatarHoverText(
                    personDisplayName(task.approver_email, people),
                    task.approver_email,
                    approver?.role,
                  )}
                >
                  <Avatar
                    name={task.approver_email}
                    role={approver?.role}
                    title={
                      approver ? displayNameOf(approver) : task.approver_email
                    }
                    size={20}
                  />
                  <span>
                    {personDisplayName(task.approver_email, people) ||
                      task.approver_email}
                  </span>
                </span>
              </dd>
            </div>
          )}
          {assigneeRows.length > 0 && (
            <div className="task-preview-field">
              <dt>עובדים במשימה</dt>
              <dd>
                <span className="task-preview-people-list">
                  {assigneeRows.map(({ email, person }) => (
                    <span
                      key={email}
                      className="task-preview-person"
                      title={avatarHoverText(
                        personDisplayName(email, people),
                        email,
                        person?.role,
                      )}
                    >
                      <Avatar
                        name={email}
                        role={person?.role}
                        title={person ? displayNameOf(person) : email}
                        size={20}
                      />
                      <span>{personDisplayName(email, people) || email}</span>
                    </span>
                  ))}
                </span>
              </dd>
            </div>
          )}
          {task.campaign && (
            <div className="task-preview-field">
              <dt>בריף</dt>
              <dd>📣 {task.campaign}</dd>
            </div>
          )}
        </dl>

        {task.description && (
          <section className="task-preview-description" dir="auto">
            <h3 className="task-preview-section-head">תיאור</h3>
            <div className="task-preview-description-body">
              {task.description}
            </div>
          </section>
        )}

        <section className="task-preview-discussion" dir="auto">
          <h3 className="task-preview-section-head">
            דיון
            {peek && peek.comments.length > 0 && (
              <span className="task-preview-section-count">
                ({peek.comments.length})
              </span>
            )}
          </h3>
          {peekLoading && (
            <div className="task-preview-loading">טוען דיון…</div>
          )}
          {peekError && !peekLoading && (
            <div className="task-preview-empty">
              לא ניתן לטעון את הדיון: {peekError}
            </div>
          )}
          {peek && !peekLoading && peek.comments.length === 0 && (
            <div className="task-preview-empty">אין תגובות עדיין.</div>
          )}
          {peek && peek.comments.length > 0 && (
            <>
              {olderCount > 0 && (
                <Link
                  href={`/tasks/${encodeURIComponent(task.id)}`}
                  className="task-preview-discussion-older"
                  onClick={onClose}
                >
                  הצג {olderCount} תגובות קודמות במשימה ←
                </Link>
              )}
              <ul className="task-preview-discussion-list">
                {recentComments.map((c) => {
                  const cAuthor = people.find(
                    (p) =>
                      p.email.toLowerCase() === c.author_email.toLowerCase(),
                  );
                  return (
                    <li
                      key={c.comment_id}
                      className="task-preview-discussion-item"
                    >
                      <Avatar
                        name={c.author_email}
                        role={cAuthor?.role}
                        title={
                          cAuthor ? displayNameOf(cAuthor) : c.author_email
                        }
                        size={20}
                      />
                      <div className="task-preview-discussion-content">
                        <div className="task-preview-discussion-head">
                          <span className="task-preview-discussion-author">
                            {personDisplayName(c.author_email, people) ||
                              c.author_email}
                          </span>
                          <span
                            className="task-preview-discussion-time"
                            title={c.timestamp}
                          >
                            {formatRelative(c.timestamp)}
                          </span>
                        </div>
                        <CommentBody
                          body={c.body}
                          className="task-preview-discussion-body"
                          people={people}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <section className="task-preview-files" dir="auto">
          <h3 className="task-preview-section-head">
            קבצים
            {peek && peek.files.length > 0 && (
              <span className="task-preview-section-count">
                ({peek.files.length})
              </span>
            )}
            {peek && peek.folderUrl && (
              <a
                href={peek.folderUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="task-preview-section-action"
                title="פתח את התיקייה ב-Drive"
              >
                פתח ב-Drive ↗
              </a>
            )}
          </h3>
          {peekLoading && (
            <div className="task-preview-loading">טוען קבצים…</div>
          )}
          {peek && !peekLoading && peek.files.length === 0 && !peekError && (
            <div className="task-preview-empty">אין קבצים מצורפים.</div>
          )}
          {peek && peek.files.length > 0 && (
            <ul className="task-preview-files-grid">
              {peek.files.map((f) => {
                const isImage =
                  (f.mimeType || "").startsWith("image/") ||
                  /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i.test(
                    f.name,
                  );
                return (
                  <li key={f.fileId} className="task-preview-file-tile">
                    <a
                      href={f.viewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={f.name}
                    >
                      <div className="task-preview-file-thumb">
                        {f.thumbnailLink ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={f.thumbnailLink}
                            alt=""
                            referrerPolicy="no-referrer"
                          />
                        ) : f.iconLink ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={f.iconLink}
                            alt=""
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span aria-hidden>{isImage ? "🖼" : "📎"}</span>
                        )}
                      </div>
                      <div className="task-preview-file-name">{f.name}</div>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <footer className="task-preview-foot">
          <Link
            href={`/tasks/${encodeURIComponent(task.id)}`}
            className="btn-primary btn-sm"
            onClick={onClose}
          >
            פתח משימה ←
          </Link>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={onClose}
          >
            סגור
          </button>
        </footer>
      </aside>
    </div>
  );
}

/**
 * Compact Hebrew relative-time formatter for comment timestamps in the
 * peek drawer. Same shape as the one in TaskStatusHistory / TaskApprovalBanner
 * — duplicated locally to keep the peek a self-contained component.
 * Falls back to the raw ISO string when the input isn't parseable.
 */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return "עכשיו";
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `לפני ${mins} ד׳`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `לפני ${hrs} ש׳`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `לפני ${days} י׳`;
  return iso.slice(0, 10);
}
