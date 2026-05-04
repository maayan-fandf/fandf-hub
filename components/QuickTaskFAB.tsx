"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DatePicker from "./DatePicker";

const MAX_TITLE = 200;

export type QuickTaskProjectOption = {
  name: string;
  company: string;
};

type Props = {
  /** Server-prefetched accessible projects (from layout.tsx). Used as the
   *  datalist for the project picker so the modal opens instant — no
   *  extra round-trip on first click. */
  projects: QuickTaskProjectOption[];
};

/**
 * Bottom-left floating action button (FAB) — global "+" entry for quick
 * task creation from anywhere on the hub. Distinct from QuickNoteModal:
 *
 *   - Quick note  (Ctrl+Shift+M / "g n"): personal __personal__ scope,
 *     stays open after save for serial captures, no redirect
 *   - Quick task  (this FAB):              real-project scope, redirects
 *     to `/tasks/<id>?edit=1` after save so the user can keep filling
 *     details (departments, description, assignees) on the full edit
 *     panel
 *
 * Capture-then-refine pattern: title + project + optional due is enough
 * to land the row; the edit page handles everything else.
 */
export default function QuickTaskFAB({ projects }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  // Keyboard: Esc closes when the modal is open.
  useEffect(() => {
    if (!open) return;
    setError(null);
    requestAnimationFrame(() => titleRef.current?.focus());
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Reset transient fields between sessions so each FAB-open is a fresh
  // capture surface, not a stale draft from last time.
  useEffect(() => {
    if (!open) {
      setTitle("");
      setProject("");
      setDue("");
    }
  }, [open]);

  async function submit() {
    const t = title.trim();
    const p = project.trim();
    if (!t) {
      setError("נדרשת כותרת");
      titleRef.current?.focus();
      return;
    }
    if (!p) {
      setError("נדרש פרויקט — או השתמש ב־Ctrl+Shift+M להערה אישית");
      return;
    }
    if (p.startsWith("__")) {
      setError("שם פרויקט לא חוקי");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/worktasks/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: p,
          title: t,
          requested_date: due,
          // Default the assignee to self — the user is the natural owner
          // of a task they just captured. They can change this on the
          // edit page if it's actually for someone else.
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        task?: { id?: string };
      };
      if (!res.ok || !data?.ok || !data.task?.id) {
        setError(data?.error || `שגיאה (${res.status})`);
        return;
      }
      // Redirect to edit page — capture-then-refine. The user just
      // dropped the bare minimum (title + project); the edit panel is
      // where they fill departments, description, assignees, etc.
      setOpen(false);
      router.push(`/tasks/${encodeURIComponent(data.task.id)}?edit=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="quick-task-fab"
        onClick={() => setOpen(true)}
        aria-label="יצירת משימה מהירה"
        title="משימה מהירה — תיפתח לעריכה אחרי השמירה"
      >
        +
      </button>

      {open && (
        <div
          className="quick-note-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            className="quick-note-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quick-task-heading"
            dir="rtl"
          >
            <div className="quick-note-head">
              <h2 id="quick-task-heading">⚡ משימה מהירה</h2>
              <button
                type="button"
                className="quick-note-close"
                onClick={() => setOpen(false)}
                aria-label="סגור"
              >
                ✕
              </button>
            </div>

            <input
              ref={titleRef}
              type="text"
              className="quick-note-title"
              placeholder="מה צריך לקרות?"
              value={title}
              maxLength={MAX_TITLE}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              disabled={saving}
            />

            <input
              type="text"
              className="quick-note-title"
              placeholder="פרויקט (חובה)"
              value={project}
              list="quick-task-project-list"
              onChange={(e) => setProject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              disabled={saving}
            />
            <datalist id="quick-task-project-list">
              {projects.map((p) => (
                <option key={`${p.company}|${p.name}`} value={p.name}>
                  {p.company ? `${p.company} · ${p.name}` : p.name}
                </option>
              ))}
            </datalist>

            <div className="quick-note-row">
              <span className="quick-note-due-label">
                <span>📅 לתאריך:</span>
                <DatePicker value={due} onChange={setDue} ariaLabel="תאריך יעד" />
              </span>
              {due && (
                <button
                  type="button"
                  className="quick-note-due-clear"
                  onClick={() => setDue("")}
                  title="ללא תאריך"
                  aria-label="ללא תאריך"
                >
                  ✕
                </button>
              )}
            </div>

            {error && <div className="quick-note-error">{error}</div>}

            <div className="quick-note-actions">
              <button
                type="button"
                className="quick-note-save"
                onClick={() => void submit()}
                disabled={saving || !title.trim() || !project.trim()}
              >
                {saving ? "יוצר…" : "צור והמשך לעריכה"}
              </button>
              <button
                type="button"
                className="quick-note-cancel"
                onClick={() => setOpen(false)}
                disabled={saving}
              >
                סגור (Esc)
              </button>
            </div>

            <div className="quick-note-hint">
              טיפ: תעבור לעריכת המשימה אחרי השמירה — שם תוסיף מחלקה, תיאור,
              משויכים וכו׳ · להערה אישית בלי פרויקט: Ctrl+Shift+M
            </div>
          </div>
        </div>
      )}
    </>
  );
}
