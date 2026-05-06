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
import type { WorkTask, TasksPerson } from "@/lib/appsScript";
import Avatar, { avatarHoverText } from "./Avatar";
import { roleEmoji, roleLabel } from "./RoleChip";
import { displayNameOf, personDisplayName } from "@/lib/personDisplay";

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
 *     page (where the user gets comments, files, status history,
 *     drag-and-drop chains, etc.)
 *   - Body scroll-locked while open
 *   - Mobile: drawer fills the viewport; desktop: ~440px wide
 *
 * Out of scope for v1:
 *   - Inline editing (the row already has inline editors, and the
 *     full detail page is just one click away)
 *   - Comments preview / files preview (would each require their own
 *     fetch round-trip; defer until users ask)
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

        <footer className="task-preview-foot">
          <Link
            href={`/tasks/${encodeURIComponent(task.id)}`}
            className="btn-primary btn-sm"
            onClick={onClose}
          >
            פתח משימה →
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
