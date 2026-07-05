"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Client-facing "✏️ בקש שינויים" action on the LatestPrisotCard, shown
 * beside "✓ אשר פריסה" when the plan isn't approved. Opens a small note
 * dialog (reusing the shared quick-note overlay styles); on submit it
 * POSTs to /api/projects/request-changes, which posts the note into the
 * client discussion + fires the team signal + sets the "🔄 התבקשו
 * שינויים" card chip. router.refresh() re-reads the state after.
 */
export default function RequestChangesButton({
  fileId,
  project,
}: {
  fileId: string;
  project: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    const trimmed = note.trim();
    if (!trimmed) {
      setError("נא לפרט מה תרצו לשנות");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/projects/request-changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, fileId, note: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setError(data.error || `שגיאה ${res.status}`);
        setSubmitting(false);
        return;
      }
      setDone(true);
      setOpen(false);
      setTimeout(() => router.refresh(), 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="prisot-request-changes-btn"
        onClick={() => setOpen(true)}
        disabled={done}
        title="בקש שינויים בפריסה — ההערה תישלח לצוות ותופיע בדיון"
      >
        {done ? "🔄 נשלחה בקשה" : "✏️ בקש שינויים"}
      </button>
      {open && (
        <div className="quick-note-overlay" role="dialog" aria-modal="true">
          <div className="quick-note-dialog" dir="rtl">
            <div className="quick-note-head">
              <h2>✏️ בקש שינויים בפריסה</h2>
              <button
                type="button"
                className="quick-note-close"
                onClick={() => !submitting && setOpen(false)}
                disabled={submitting}
                aria-label="סגור"
              >
                ✕
              </button>
            </div>
            <textarea
              className="quick-note-body"
              placeholder="מה תרצו לשנות בפריסה? ההערה תישלח לצוות ותופיע בדיון עם הצוות."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              disabled={submitting}
              autoFocus
            />
            {error && <div className="error">{error}</div>}
            <div className="send-approval-actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => !submitting && setOpen(false)}
                disabled={submitting}
              >
                ביטול
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={submit}
                disabled={submitting || !note.trim()}
              >
                {submitting ? "שולח…" : "שלח לצוות"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
