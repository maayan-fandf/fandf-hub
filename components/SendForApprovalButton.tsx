"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "📤 שלח לאישור" affordance shown on the LatestPrisotCard when the
 * latest פריסה has approvalState === "none". Click opens a small
 * dialog that lets the user pick from the company's client emails
 * (pre-populated from `suggestedClients`) and optionally add a
 * message, then POSTs to /api/drive/approvals/create.
 *
 * On success, the API has already initiated the Drive Approvals
 * workflow — Drive sends each approver an email with the file
 * attached. The hub's badge eventually flips to "⏳ נשלח לאישור" on
 * the next page render (the Approvals API is read every load — see
 * fetchApprovalState in lib/driveFolders.ts). router.refresh()
 * after submit triggers the re-fetch immediately.
 *
 * Suggested-clients source: project's Keys row col E ("Email Client")
 * — same list ensureProjectSharedFolder uses to grant Drive
 * permissions on the per-project shared folder. Threaded down from
 * /projects/[project]/page.tsx via projectMeta.roster.clientEmails.
 */
export default function SendForApprovalButton({
  fileId,
  fileName,
  suggestedClients,
}: {
  fileId: string;
  fileName: string;
  suggestedClients: string[];
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
  // Per-email share failures returned by /api/drive/approvals/create
  // when permissions.create couldn't grant the recipient access.
  // The approval was created successfully (Drive sent its emails),
  // but those recipients will hit "Request access" — the user needs
  // to share manually or pick different reviewers next time.
  const [shareFailures, setShareFailures] = useState<
    { email: string; reason: string }[]
  >([]);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Initialize selected when the dialog opens — pre-check every
  // suggested client. Reset transient state on each open.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(suggestedClients.map((e) => e.toLowerCase().trim())));
    setExtraEmail("");
    setMessage("");
    setError(null);
    setSuccess(false);
    setShareFailures([]);
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
      const approvers = [...selected];
      if (approvers.length === 0) {
        setError("יש לבחור לפחות נמען אחד");
        setSubmitting(false);
        return;
      }
      const res = await fetch("/api/drive/approvals/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileId, approvers, message }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        status?: number;
        shareFailures?: { email: string; reason: string }[];
      };
      if (!res.ok || !data.ok) {
        // Friendly hint for the most-common failure modes — keeps the
        // raw error available for diagnosis but doesn't dump
        // a JSON wall onto the user.
        const status = data.status ?? res.status;
        let hint = "";
        if (status === 403) {
          hint =
            "ייתכן שתכונת האישורים אינה זמינה במנוי Workspace הנוכחי. ";
        } else if (status === 400) {
          hint = "נראה שלא ניתן לשתף את הקובץ עם אחד הנמענים. ";
        }
        setError(hint + (data.error || `שגיאה ${status}`));
        setSubmitting(false);
        return;
      }
      setSuccess(true);
      setShareFailures(data.shareFailures ?? []);
      setSubmitting(false);
      // Auto-close + refresh ONLY when every recipient was shared
      // cleanly — when there are share failures, keep the dialog open
      // so the user sees which recipients need manual handling.
      if (!data.shareFailures || data.shareFailures.length === 0) {
        setTimeout(() => {
          setOpen(false);
          router.refresh();
        }, 1200);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="prisot-send-approval-btn"
        onClick={() => setOpen(true)}
        title="שלח את הפריסה לאישור הלקוח"
      >
        📤 שלח לאישור
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
                    const checked = selected.has(norm);
                    return (
                      <li key={norm}>
                        <label className="send-approval-row">
                          <input
                            type="checkbox"
                            checked={checked}
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
            {(() => {
              const extras = [...selected].filter(
                (e) =>
                  !suggestedClients
                    .map((s) => s.toLowerCase().trim())
                    .includes(e),
              );
              if (extras.length === 0) return null;
              return (
                <div className="send-approval-section">
                  <div className="send-approval-section-label">
                    נמענים נוספים
                  </div>
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
              );
            })()}
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
              placeholder="הודעה (אופציונלי) — תופיע בבקשת האישור"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={submitting}
              className="quick-note-body"
              rows={3}
            />
            {error && <div className="error send-approval-error">{error}</div>}
            {success && shareFailures.length === 0 && (
              <div className="send-approval-success">
                ✓ נשלח. הנמענים יקבלו אימייל מ-Drive עם בקשת אישור
                והרשאת צפייה בקובץ.
              </div>
            )}
            {success && shareFailures.length > 0 && (
              <div className="send-approval-warning">
                <div>
                  ⚠️ הבקשה נשלחה, אבל לא הצלחנו להעניק הרשאת צפייה
                  לכל הנמענים. הם עלולים לראות "בקשת גישה" כשייכנסו
                  לקובץ. שתף ידנית מתוך Drive או בחר נמענים אחרים:
                </div>
                <ul className="send-approval-fail-list">
                  {shareFailures.map((f) => (
                    <li key={f.email}>
                      <b dir="ltr">{f.email}</b>
                      {f.reason && (
                        <span className="send-approval-fail-reason">
                          {" "}— {f.reason}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
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
                disabled={submitting || selected.size === 0 || success}
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
