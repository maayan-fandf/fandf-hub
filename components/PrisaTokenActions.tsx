"use client";

import { useState } from "react";

/**
 * Approve / request-changes buttons on the login-free /approve/<token>
 * page. Same two outcomes as the in-hub ApprovePrisaButton +
 * RequestChangesButton pair, but authenticated by the token in the URL
 * instead of a session — so a client with no Google account (or no
 * patience for a sign-in) can still sign the plan off.
 *
 * There's no router.refresh() here: the page is public and stateless, so
 * on success we swap to a terminal confirmation panel in place rather
 * than re-reading server state the visitor has no session for.
 */
export default function PrisaTokenActions({
  token,
  projectHref,
  approvers,
}: {
  token: string;
  /** Deep link into the hub for the "prefer to sign in?" escape hatch. */
  projectHref: string;
  /** Everyone who may be named as the approver: the addressees of the
   *  email PLUS the project's client roster. Approval mail gets
   *  forwarded — one live request's own note reads
   *  "יכולה להעביר את המייל לצרפתי" — so the person who actually signs
   *  off is often not an addressee, and offering only the To: line made
   *  them sign under someone else's name. The server re-derives this
   *  same list from Keys and rejects anything outside it, so the choice
   *  here is a label, not a grant. One entry means there is nothing to
   *  ask and the question is skipped. */
  approvers: string[];
}) {
  const [mode, setMode] = useState<"idle" | "confirm" | "changes">("idle");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"approved" | "changes" | null>(null);
  const mustPick = approvers.length > 1;
  const [who, setWho] = useState("");

  async function post(action: "approve" | "changes") {
    if (mustPick && !who) {
      setError("נא לבחור מי מאשר");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/prisot/token-action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, action, note: note.trim(), as: who }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        // The API always sends Hebrew for the cases a client can hit
        // (expired / already-resolved / write failed). A bare status is
        // the last-resort fallback for a transport-level surprise —
        // still phrased for a client, not a developer.
        setError(
          data.error ||
            "משהו השתבש בשליחה. נסו שוב, או פנו לצוות ונטפל בזה ידנית.",
        );
        setSubmitting(false);
        return;
      }
      setDone(action === "approve" ? "approved" : "changes");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  if (done === "approved") {
    return (
      <div className="prisa-approve-result prisa-approve-result-ok" dir="rtl">
        <div className="prisa-approve-result-icon">✓</div>
        <h2>הפריסה אושרה</h2>
        <p>
          תודה! הצוות עודכן והפריסה ננעלה כגרסה המאושרת. אפשר לסגור את
          החלון הזה.
        </p>
      </div>
    );
  }
  if (done === "changes") {
    return (
      <div className="prisa-approve-result" dir="rtl">
        <div className="prisa-approve-result-icon">✏️</div>
        <h2>בקשת השינויים נשלחה</h2>
        <p>
          ההערה הועברה לצוות. תקבלו פריסה מעודכנת לאישור בהמשך. אפשר לסגור
          את החלון הזה.
        </p>
      </div>
    );
  }

  // Rendered inside both the confirm and the changes panels — asked only
  // once the visitor has committed to an action, so the resting state
  // stays a clean single click.
  const picker = mustPick ? (
    <div className="prisa-approve-who">
      <label htmlFor="prisa-who" className="prisa-approve-who-label">
        מי מאשר?
      </label>
      <select
        id="prisa-who"
        className="prisa-approve-who-select"
        value={who}
        onChange={(e) => setWho(e.target.value)}
        disabled={submitting}
        dir="ltr"
      >
        <option value="">— בחרו —</option>
        {approvers.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    </div>
  ) : null;

  return (
    <div className="prisa-approve-actions" dir="rtl">
      {mode === "changes" ? (
        <div className="prisa-approve-changes">
          <label htmlFor="prisa-note" className="prisa-approve-changes-label">
            מה תרצו לשנות בפריסה?
          </label>
          <textarea
            id="prisa-note"
            className="quick-note-body"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            disabled={submitting}
            placeholder="ההערה תישלח לצוות ותופיע בדיון על הפרויקט."
            autoFocus
          />
          {picker}
          <div className="prisa-approve-btnrow">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setMode("idle")}
              disabled={submitting}
            >
              חזרה
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => post("changes")}
              disabled={submitting || !note.trim() || (mustPick && !who)}
            >
              {submitting ? "שולח…" : "שלח לצוות"}
            </button>
          </div>
        </div>
      ) : mode === "confirm" ? (
        <div className="prisa-approve-confirm">
          <span className="prisa-approve-confirm-q">
            לאשר את הפריסה? הקובץ יינעל כגרסה המאושרת.
          </span>
          {picker}
          <div className="prisa-approve-btnrow">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setMode("idle")}
              disabled={submitting}
            >
              ביטול
            </button>
            <button
              type="button"
              className="prisa-approve-yes"
              onClick={() => post("approve")}
              disabled={submitting || (mustPick && !who)}
            >
              {submitting ? "מאשר…" : "כן, אשר את הפריסה"}
            </button>
          </div>
        </div>
      ) : (
        <div className="prisa-approve-btnrow prisa-approve-btnrow-primary">
          <button
            type="button"
            className="prisa-approve-yes"
            onClick={() => setMode("confirm")}
          >
            ✓ אשר פריסה
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setMode("changes")}
          >
            ✏️ בקש שינויים
          </button>
        </div>
      )}
      {error && <div className="error prisa-approve-error">{error}</div>}
      <p className="prisa-approve-signin-hint">
        מעדיפים לעבוד מתוך המערכת?{" "}
        <a href={projectHref}>כניסה לעמוד הפרויקט ב-Hub</a>
      </p>
    </div>
  );
}
