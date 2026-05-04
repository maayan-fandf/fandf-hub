"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Project } from "@/lib/appsScript";

type Props = {
  taskId: string;
  /** The user's accessible projects, prefetched server-side by the
   *  /tasks/[id] page so the picker is instant. Reuses the same
   *  navProjects payload the layout already loads. */
  projects: Pick<Project, "name" | "company">[];
};

/**
 * Renders next to "✏️ ערוך" on /tasks/[id] for personal-note rows.
 * Opens a small modal with a project picker (datalist over the user's
 * accessible projects) + optional campaign field. POSTs to
 * /api/worktasks/promote-personal which validates, resolves company,
 * backfills Drive folder, and patches the row's project + company.
 */
export default function PromoteToProjectButton({ taskId, projects }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState("");
  const [campaign, setCampaign] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  async function submit() {
    const p = project.trim();
    if (!p) {
      setError("נדרש פרויקט");
      inputRef.current?.focus();
      return;
    }
    if (p.startsWith("__")) {
      setError("שם פרויקט לא חוקי");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/worktasks/promote-personal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: taskId,
          project: p,
          campaign: campaign.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data?.ok) {
        setError(data?.error || `שגיאה (${res.status})`);
        return;
      }
      setOpen(false);
      router.refresh();
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
        className="btn-ghost btn-sm"
        onClick={() => setOpen(true)}
        title="הפוך את ההערה האישית למשימה רגילה תחת פרויקט"
      >
        🚀 הפוך למשימה רגילה
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
            aria-labelledby="promote-heading"
            dir="rtl"
          >
            <div className="quick-note-head">
              <h2 id="promote-heading">🚀 הפוך למשימה רגילה</h2>
              <button
                type="button"
                className="quick-note-close"
                onClick={() => setOpen(false)}
                aria-label="סגור"
              >
                ✕
              </button>
            </div>

            <p className="quick-note-hint" style={{ textAlign: "right" }}>
              ההערה תועבר לפרויקט שתבחר. החברה תיקבע אוטומטית מתוך Keys, ותיקיית
              Drive תיווצר אם זו המשימה הראשונה שלך בפרויקט. אפשר לערוך הכל גם
              אחרי כן דרך כפתור “✏️ ערוך”.
            </p>

            <input
              ref={inputRef}
              type="text"
              className="quick-note-title"
              placeholder="הקלד שם פרויקט"
              value={project}
              list="promote-project-list"
              onChange={(e) => setProject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              disabled={saving}
            />
            <datalist id="promote-project-list">
              {projects.map((p) => (
                <option key={`${p.company}|${p.name}`} value={p.name}>
                  {p.company ? `${p.company} · ${p.name}` : p.name}
                </option>
              ))}
            </datalist>

            <input
              type="text"
              className="quick-note-body"
              placeholder="קמפיין (אופציונלי)"
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
              disabled={saving}
            />

            {error && <div className="quick-note-error">{error}</div>}

            <div className="quick-note-actions">
              <button
                type="button"
                className="quick-note-save"
                onClick={() => void submit()}
                disabled={saving || !project.trim()}
              >
                {saving ? "מעביר…" : "העבר לפרויקט"}
              </button>
              <button
                type="button"
                className="quick-note-cancel"
                onClick={() => setOpen(false)}
                disabled={saving}
              >
                סגור
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
