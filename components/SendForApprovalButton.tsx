"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "📤 שלח לאישור" affordance on the LatestPrisotCard, shown when the
 * latest פריסה isn't already approved. Opens a small dialog to pick
 * recipients (listed from `suggestedClients`, none checked by default)
 * plus an optional message, then POSTs to /api/prisot/send-approval.
 *
 * That endpoint emails each recipient a signed, expiring link to
 * /approve/<token> — a page that renders the plan and its
 * אשר / בקש שינויים buttons with NO login required. On success the
 * hub records the request, and the card's badge flips to
 * "⏳ נשלח לאישור" on the next render (router.refresh() below).
 *
 * REPLACED the Drive Approvals API flow (2026-08-18). That version
 * asked Drive to email each reviewer, which meant every recipient
 * needed a Google identity — the dialog had grown a whole sub-UI for
 * detecting accountless emails and coaching the user through creating
 * one, and clients still didn't complete the approval. None of that is
 * needed now: we send our own mail and own the approval surface, so an
 * address without a Google account is an ordinary case.
 *
 * Suggested-clients source: project's Keys row col E ("Email Client")
 * — same list ensureProjectSharedFolder uses to grant Drive
 * permissions on the per-project shared folder. Threaded down from
 * /projects/[project]/page.tsx via projectMeta.roster.clientEmails.
 */
export default function SendForApprovalButton({
  fileId,
  fileName,
  mimeType,
  project,
  company,
  suggestedClients,
  resend = false,
}: {
  fileId: string;
  fileName: string;
  /** Drive mime type — recorded on the request so the public approve
   *  page can pick a renderer (table / iframe / img / no-preview note)
   *  without an extra Drive call. */
  mimeType: string;
  /** Project name — recorded on the request so a client's change-request
   *  can be posted into the right discussion, and so the approve page's
   *  "sign in instead" link resolves. */
  project: string;
  company: string;
  suggestedClients: string[];
  /** True when an approval is already in flight — relabels the button so
   *  it reads as "send again" rather than a duplicate first send. Sending
   *  overwrites the open request and supersedes its links. */
  resend?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Selected addresses — initialized from suggestedClients with all
  // checked. The "add another email" input feeds into the same set.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [extraEmail, setExtraEmail] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Open with NOTHING checked. The roster is a suggestion, not a default:
  // pre-checking it meant the safe-looking action (just hit שלח) mailed the
  // whole client list, and un-checking is the step people forget. Starting
  // empty makes each recipient a deliberate choice, and the send button stays
  // disabled until at least one is picked.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setExtraEmail("");
    setMessage("");
    setError(null);
    setSuccess(false);
  }, [open, suggestedClients]);

  // Esc + click-outside to close, but don't close while submitting
  // (a half-finished POST should resolve before unmount).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) {
        e.preventDefault();
        setOpen(false);
      }
    }
    function onClick(e: MouseEvent) {
      if (submitting) return;
      const dlg = dialogRef.current;
      if (dlg && !dlg.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open, submitting]);

  function toggleEmail(email: string) {
    const norm = email.toLowerCase().trim();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(norm)) next.delete(norm);
      else next.add(norm);
      return next;
    });
  }

  function addExtra() {
    const norm = extraEmail.toLowerCase().trim();
    if (!norm.includes("@")) return;
    setSelected((prev) => new Set(prev).add(norm));
    setExtraEmail("");
  }

  async function onSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      // Auto-promote any pending email in the "הוסף כתובת אימייל" input.
      // Common pattern is to type an address and click שלח without
      // remembering to click הוסף first. Folding the trailing value into
      // the recipient set on submit removes the dead-end where the user
      // clicks send, gets "יש לבחור לפחות נמען אחד", and stares at the
      // email they thought was the recipient.
      const pending = extraEmail.toLowerCase().trim();
      let finalSelected = selected;
      if (pending.includes("@") && !selected.has(pending)) {
        finalSelected = new Set(selected).add(pending);
        setSelected(finalSelected);
        setExtraEmail("");
      }
      const approvers = [...finalSelected];
      if (approvers.length === 0) {
        setError("יש לבחור לפחות נמען אחד");
        setSubmitting(false);
        return;
      }
      const res = await fetch("/api/prisot/send-approval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fileId,
          fileName,
          mimeType,
          project,
          company,
          approvers,
          message,
        }),
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
      setSuccess(true);
      setSubmitting(false);
      // One message to the whole group — it either went out or it didn't,
      // so there's no partial state to keep the dialog open for.
      setTimeout(() => {
        setOpen(false);
        router.refresh();
      }, 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  const extras = [...selected].filter(
    (e) => !suggestedClients.map((s) => s.toLowerCase().trim()).includes(e),
  );

  // A typed-but-not-yet-added address counts toward "has a recipient".
  // onSubmit folds it into the set anyway (see the auto-promote there), and
  // without this the send button would sit disabled while the user stares
  // at the address they just typed — a dead end that only appeared once
  // the roster stopped being pre-checked.
  const pendingEmail = extraEmail.toLowerCase().trim().includes("@");
  const hasRecipient = selected.size > 0 || pendingEmail;

  return (
    <>
      <button
        type="button"
        className="prisot-send-approval-btn"
        onClick={() => setOpen(true)}
        title={
          resend
            ? "שלח שוב לאישור — הקישורים שנשלחו קודם יפוגו"
            : "שלח את הפריסה לאישור הלקוח"
        }
      >
        {resend ? "🔁 שלח שוב" : "📤 שלח לאישור"}
      </button>
      {open && (
        <div className="quick-note-overlay" role="dialog" aria-modal="true">
          <div
            className="quick-note-dialog send-approval-dialog"
            ref={dialogRef}
            dir="rtl"
          >
            <div className="quick-note-head">
              <h2>📤 שלח לאישור</h2>
              <button
                type="button"
                className="quick-note-close"
                onClick={() => !submitting && setOpen(false)}
                aria-label="סגור"
                disabled={submitting}
              >
                ✕
              </button>
            </div>
            <p className="send-approval-file" title={fileName}>
              קובץ: <b>{fileName}</b>
            </p>
            {/* Suggested clients — pre-checked. Add-another input
                appears below for non-roster emails. Empty list (no
                clients on the project) drops the section heading
                and leans on the manual input. */}
            {suggestedClients.length > 0 && (
              <div className="send-approval-section">
                <div className="send-approval-section-label">
                  לקוחות בפרויקט
                </div>
                <ul className="send-approval-list">
                  {suggestedClients.map((email) => {
                    const norm = email.toLowerCase().trim();
                    return (
                      <li key={norm}>
                        <label className="send-approval-row">
                          <input
                            type="checkbox"
                            checked={selected.has(norm)}
                            onChange={() => toggleEmail(norm)}
                            disabled={submitting}
                          />
                          <span dir="ltr">{email}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {/* Extras already-added (typed into the input below) —
                render only when there are entries beyond the
                suggested list, so we don't double-show. */}
            {extras.length > 0 && (
              <div className="send-approval-section">
                <div className="send-approval-section-label">נמענים נוספים</div>
                <ul className="send-approval-list">
                  {extras.map((email) => (
                    <li key={email}>
                      <label className="send-approval-row">
                        <input
                          type="checkbox"
                          checked
                          onChange={() => toggleEmail(email)}
                          disabled={submitting}
                        />
                        <span dir="ltr">{email}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="send-approval-add">
              <input
                type="email"
                placeholder="הוסף כתובת אימייל…"
                value={extraEmail}
                onChange={(e) => setExtraEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addExtra();
                  }
                }}
                disabled={submitting}
                className="quick-note-title"
                dir="ltr"
              />
              <button
                type="button"
                onClick={addExtra}
                className="btn-ghost btn-sm"
                disabled={submitting || !extraEmail.includes("@")}
              >
                הוסף
              </button>
            </div>
            <textarea
              placeholder="הודעה (אופציונלי) — תופיע בגוף המייל"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={submitting}
              className="quick-note-body"
              rows={3}
            />
            <p className="send-approval-hint">
              יישלח מייל אחד לכל הנמענים יחד, עם קישור לאישור הפריסה — ללא
              צורך בהתחברות או בחשבון Google. הקישור בתוקף לשבועיים.
              {resend && " שליחה חוזרת מבטלת את הקישורים שנשלחו קודם."}
            </p>
            {error && <div className="error send-approval-error">{error}</div>}
            {success && (
              <div className="send-approval-success">
                ✓ נשלח. הנמענים יקבלו מייל עם קישור לצפייה ואישור הפריסה.
              </div>
            )}
            <div className="send-approval-actions">
              <button
                type="button"
                onClick={() => !submitting && setOpen(false)}
                className="btn-ghost"
                disabled={submitting}
              >
                ביטול
              </button>
              <button
                type="button"
                onClick={onSubmit}
                className="btn-primary"
                disabled={submitting || !hasRecipient || success}
              >
                {submitting ? "שולח…" : "שלח לאישור"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
