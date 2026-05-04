"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DatePicker from "./DatePicker";

const MAX_TITLE = 200;
const MAX_BODY = 2000;

type LastSaved = {
  id: string;
  title: string;
};

/**
 * Self-note quick-capture modal. Opens via:
 *   - `Ctrl+Shift+M` / `⌘+Shift+M` global shortcut (m for "memo" — Ctrl+Shift+N
 *     is reserved by Chrome for incognito mode at the OS level, so we can't
 *     use it; M was the closest free alternative across Chrome/Firefox/Edge/Safari)
 *   - The "g n" chord in CommandPalette → calls window.dispatchEvent('hub:open-quick-note')
 *   - The CommandPalette static action (search "הערה אישית" / "note")
 *
 * Saves via POST /api/worktasks/quick-note → tasksCreateDirect with the
 * `__personal__` pseudo-project. The created task lands in /tasks
 * automatically (filtered to only the assignee/author by the read gate).
 *
 * Mounted once globally in app/layout.tsx.
 */
export default function QuickNoteModal() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<LastSaved | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Global shortcut + custom open event.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Ctrl+Shift+M / ⌘+Shift+M — open the modal regardless of where focus is.
      // (Ctrl+Shift+N is reserved by Chrome for incognito and can't be intercepted
      // by web pages — this is enforced at the OS / browser level.)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (open && e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    }
    function onCustomOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("hub:open-quick-note", onCustomOpen as EventListener);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(
        "hub:open-quick-note",
        onCustomOpen as EventListener,
      );
    };
  }, [open]);

  // Reset transient state on close, focus title on open.
  useEffect(() => {
    if (open) {
      setError(null);
      // Run after the dialog mounts so the input exists in the DOM.
      requestAnimationFrame(() => titleRef.current?.focus());
    } else {
      // Keep `title` / `body` cleared between sessions so the next open
      // is always a fresh capture surface, not a stale draft.
      setTitle("");
      setBody("");
      setDue("");
      setLastSaved(null);
    }
  }, [open]);

  async function save() {
    const t = title.trim();
    if (!t) {
      setError("נדרשת כותרת");
      titleRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/worktasks/quick-note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: t,
          description: body.trim(),
          due: due.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        task?: { id?: string; title?: string };
      };
      if (!res.ok || !data?.ok || !data.task?.id) {
        setError(data?.error || `שגיאה (${res.status})`);
        return;
      }
      setLastSaved({ id: data.task.id, title: data.task.title || t });
      setTitle("");
      setBody("");
      setDue("");
      titleRef.current?.focus();
      // Don't auto-navigate — many notes are write-and-forget. The
      // success line shows a link if the user wants to open it.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="quick-note-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        ref={dialogRef}
        className="quick-note-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-note-heading"
        dir="rtl"
      >
        <div className="quick-note-head">
          <h2 id="quick-note-heading">📝 הערה אישית</h2>
          <button
            type="button"
            className="quick-note-close"
            onClick={() => setOpen(false)}
            aria-label="סגור"
            title="סגור (Esc)"
          >
            ✕
          </button>
        </div>

        <input
          ref={titleRef}
          type="text"
          className="quick-note-title"
          placeholder="מה לזכור?"
          value={title}
          maxLength={MAX_TITLE}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            // Enter saves; Shift+Enter falls into the body field (default
            // behavior with a single-line input is just to submit, so we
            // handle Enter explicitly here).
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void save();
            }
          }}
          disabled={saving}
        />

        <textarea
          className="quick-note-body"
          placeholder="תיאור (אופציונלי) — Ctrl+Enter לשמירה"
          value={body}
          maxLength={MAX_BODY}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
          disabled={saving}
        />

        {/* NOT a <label> — wrapping the DatePicker in a label would redirect
            clicks on the day cells to the first form control inside (the
            trigger button), closing the popover before the day's onClick
            could fire. Keep this a plain <div>. */}
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

        {lastSaved && (
          <div className="quick-note-saved">
            ✓ נשמר —{" "}
            <a
              href={`/tasks/${encodeURIComponent(lastSaved.id)}?edit=1`}
              onClick={() => setOpen(false)}
            >
              פתח “{lastSaved.title}” לעריכה
            </a>
          </div>
        )}

        <div className="quick-note-actions">
          <button
            type="button"
            className="quick-note-save"
            onClick={() => void save()}
            disabled={saving || !title.trim()}
          >
            {saving ? "שומר…" : "שמור (Enter)"}
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
          טיפ: Ctrl+Shift+M לפתיחה מכל מקום בהאב · המשימה תופיע ב־📋 משימות שלך
        </div>
      </div>
    </div>
  );
}
