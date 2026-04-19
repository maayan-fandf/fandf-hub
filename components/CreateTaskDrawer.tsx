"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Assignee } from "@/lib/appsScript";

type Props = {
  project: string;
};

const MAX = 4000;

/**
 * "+ New task" entry point on a project page. Opens a modal-style drawer
 * with:
 *   - body textarea
 *   - assignee multi-picker (fetched lazily on first open, so we don't
 *     round-trip to Apps Script until the user actually wants to create)
 *   - optional due date (native <input type="date">)
 *
 * Submits to /api/tasks/create, which maps to the createTask Apps Script
 * action — same sheet-append + Google Tasks dispatch path as a dashboard
 * @-mention. On success: close + router.refresh().
 */
export default function CreateTaskDrawer({ project }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [due, setDue] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignees, setAssignees] = useState<Assignee[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Lazy-fetch assignees the first time the drawer opens. If it fails, user
  // can still submit — Apps Script will just drop unrecognized emails — but
  // the picker is the main way to select, so we surface the error.
  useEffect(() => {
    if (!open || assignees !== null || loading) return;
    setLoading(true);
    setFetchError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/projects/assignees?project=${encodeURIComponent(project)}`,
        );
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        const data = (await res.json()) as { assignees: Assignee[] };
        setAssignees(data.assignees);
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, project, assignees, loading]);

  function openDrawer() {
    setOpen(true);
    setSubmitError(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function closeDrawer() {
    setOpen(false);
    setBody("");
    setDue("");
    setSelected(new Set());
    setSubmitError(null);
  }

  function toggleAssignee(email: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  function submit() {
    const trimmed = body.trim();
    if (!trimmed) {
      setSubmitError("תוכן המשימה לא יכול להיות ריק.");
      return;
    }
    if (trimmed.length > MAX) {
      setSubmitError(`ארוך מדי (${trimmed.length}/${MAX}).`);
      return;
    }
    setSubmitError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/tasks/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project,
            body: trimmed,
            assignees: Array.from(selected),
            due: due || "",
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || `Request failed (${res.status})`);
        }
        closeDrawer();
        router.refresh();
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDrawer();
    } else if (
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey) &&
      (e.target as HTMLElement).tagName === "TEXTAREA"
    ) {
      e.preventDefault();
      submit();
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="reply-btn reply-btn-primary"
        onClick={openDrawer}
        title="צור משימה חדשה בפרויקט זה"
      >
        + משימה חדשה
      </button>
    );
  }

  const count = body.trim().length;
  const over = count > MAX;

  return (
    <div
      className="create-task-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeDrawer();
      }}
    >
      <div
        className="create-task-modal"
        role="dialog"
        aria-modal="true"
        onKeyDown={onKeyDown}
      >
        <div className="create-task-head">
          <h2>משימה חדשה · {project}</h2>
          <button
            type="button"
            className="create-task-close"
            onClick={closeDrawer}
            aria-label="סגור"
          >
            ×
          </button>
        </div>

        <label className="create-task-label">
          תוכן
          <textarea
            ref={textareaRef}
            className="reply-textarea"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="מה צריך לעשות? (⌘/Ctrl+Enter ליצירה)"
            disabled={isPending}
            maxLength={MAX + 1}
          />
          <span className={`reply-count ${over ? "is-over" : ""}`}>
            {count}/{MAX}
          </span>
        </label>

        <label className="create-task-label">
          אחראים
          {loading && (
            <div className="create-task-loading">טוען אנשים…</div>
          )}
          {fetchError && (
            <div className="reply-error">שגיאה בטעינת אנשים: {fetchError}</div>
          )}
          {assignees && assignees.length === 0 && (
            <div className="create-task-loading">
              לא מוגדרים אנשים עבור פרויקט זה ב-Keys.
            </div>
          )}
          {assignees && assignees.length > 0 && (
            <div className="assignee-grid">
              {assignees.map((a) => {
                const checked = selected.has(a.email);
                return (
                  <label
                    key={a.email}
                    className={`assignee-chip ${checked ? "is-checked" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleAssignee(a.email)}
                      disabled={isPending}
                    />
                    <span className="assignee-name">{a.name}</span>
                    <span className="assignee-role">{a.role}</span>
                  </label>
                );
              })}
            </div>
          )}
        </label>

        <label className="create-task-label">
          תאריך יעד <span className="create-task-hint">(אופציונלי)</span>
          <input
            type="date"
            className="create-task-due"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            disabled={isPending}
          />
        </label>

        <div className="reply-drawer-foot create-task-foot">
          {submitError && <span className="reply-error">{submitError}</span>}
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
            {isPending
              ? "יוצר…"
              : selected.size > 0
                ? `צור · תייג ${selected.size}`
                : "צור"}
          </button>
        </div>
      </div>
    </div>
  );
}
