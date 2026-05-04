"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DatePicker from "./DatePicker";

const MAX_TITLE = 200;

/**
 * Bottom-left floating action button (FAB) — global "+" entry for quick
 * capture from anywhere on the hub. Saves a personal note (`__personal__`
 * pseudo-project) and redirects to the edit page so the user can elaborate
 * (add description, departments, assignees, OR convert to a real project
 * by typing a project name in the now-editable project field).
 *
 * Capture-then-refine pattern. Distinct from QuickNoteModal (which is
 * triggered by Ctrl+Shift+M / "g n" and stays open for serial captures):
 *   - FAB:           save → redirect to edit (single thought, refine now)
 *   - QuickNoteModal: save → stay open ("✓ נשמר — פתח") for batches of
 *                     thoughts where you want to keep capturing
 */
export default function QuickTaskFAB() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
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
      setDue("");
    }
  }, [open]);

  async function submit() {
    const t = title.trim();
    if (!t) {
      setError("נדרשת כותרת");
      titleRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Quick-note endpoint creates a __personal__ task assigned to the
      // session user. Same path the Ctrl+Shift+M modal uses — single
      // server-side surface for personal-scoped captures.
      const res = await fetch("/api/worktasks/quick-note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: t, due }),
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
      // Redirect to edit page — capture-then-refine. From there the user
      // can add description, departments, assignees, and (if it's bigger
      // than a personal note) type a real project name into the now-
      // editable פרויקט field to convert it.
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
                disabled={saving || !title.trim()}
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
              טיפ: תיפתח עריכת המשימה אחרי השמירה — שם תוסיף תיאור, משויכים,
              או תקליד שם פרויקט בשדה “פרויקט” כדי להפוך אותה למשימת פרויקט
              רגילה
            </div>
          </div>
        </div>
      )}
    </>
  );
}
