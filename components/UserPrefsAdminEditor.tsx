"use client";

import { useState } from "react";
import type { UserPrefs } from "@/lib/userPrefs";
import type { UserPrefRow } from "@/app/admin/user-prefs/page";

/**
 * Admin table for User Preferences. Two sections:
 *   - Top: the admin's own prefs (editable like the gear menu)
 *   - Below: every user with their current toggles, admin can flip
 *
 * Every flip is one POST to /api/admin/user-prefs with {email, partial}.
 * Optimistic UI: row updates immediately, reverts on error.
 *
 * The page reads server-side from the User Preferences sheet on every
 * navigation — there's no client cache. If you edit the sheet directly
 * in Google Sheets and reload, your changes appear here. If you flip
 * a toggle here, the sheet updates within the same request.
 */
export default function UserPrefsAdminEditor({
  myEmail,
  myPrefs,
  rows,
}: {
  myEmail: string;
  myPrefs: UserPrefs;
  rows: UserPrefRow[];
}) {
  const [data, setData] = useState<UserPrefRow[]>(rows);
  const [busy, setBusy] = useState<string | null>(null); // "email|key"
  const [error, setError] = useState<string | null>(null);

  async function flip(email: string, partial: Partial<UserPrefs>) {
    const k = `${email}|${Object.keys(partial).join(",")}`;
    setBusy(k);
    setError(null);
    // Optimistic — patch the row in place.
    const prev = data.map((r) => ({ ...r, prefs: { ...r.prefs } }));
    setData((cur) =>
      cur.map((r) =>
        r.email === email
          ? { ...r, prefs: { ...r.prefs, ...partial }, isDefault: false }
          : r,
      ),
    );
    try {
      const res = await fetch("/api/admin/user-prefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, partial }),
      });
      const body = (await res.json()) as
        | { ok: true; email: string; prefs: UserPrefs }
        | { ok: false; error: string };
      if (!res.ok || !body.ok) {
        throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
      }
      setData((cur) =>
        cur.map((r) =>
          r.email === email
            ? { ...r, prefs: body.prefs, isDefault: false, updatedAt: new Date().toISOString() }
            : r,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(prev); // revert
    } finally {
      setBusy(null);
    }
  }

  const myRow = data.find((r) => r.email === myEmail);
  const otherRows = data.filter((r) => r.email !== myEmail);

  return (
    <div className="user-prefs-admin">
      {error && <div className="error">{error}</div>}

      {myRow && (
        <section className="user-prefs-admin-self">
          <h2>שלך — {myRow.name}</h2>
          <p className="user-prefs-admin-self-hint">
            אותם המתגים שמופיעים בתפריט הגלגל, רק במבט מלא של דף.
          </p>
          <UserPrefsRow
            row={myRow}
            busy={busy}
            onFlip={(partial) => flip(myRow.email, partial)}
            isSelf
          />
        </section>
      )}

      <section className="user-prefs-admin-others">
        <h2>משתמשים אחרים <small>({otherRows.length})</small></h2>
        <div className="user-prefs-admin-table-wrap">
          <table className="user-prefs-admin-table">
            <thead>
              <tr>
                <th>שם</th>
                <th>תפקיד</th>
                <th>אימייל</th>
                <th title="התראות במייל">✉️</th>
                <th title="סנכרון Google Tasks">📋</th>
                <th title="הצג כ">👁️</th>
                <th title="עודכן לאחרונה">⏱</th>
              </tr>
            </thead>
            <tbody>
              {otherRows.map((r) => (
                <tr
                  key={r.email}
                  className={r.isDefault ? "is-default" : ""}
                  title={r.isDefault ? "אין שורה ב-User Preferences — מציג ברירת מחדל" : ""}
                >
                  <td>{r.name}</td>
                  <td className="user-prefs-admin-role">{r.role}</td>
                  <td dir="ltr" className="user-prefs-admin-email">
                    {r.email}
                  </td>
                  <td>
                    <ToggleCell
                      checked={r.prefs.email_notifications}
                      busy={busy === `${r.email}|email_notifications`}
                      onChange={(v) =>
                        flip(r.email, { email_notifications: v })
                      }
                    />
                  </td>
                  <td>
                    <ToggleCell
                      checked={r.prefs.gtasks_sync}
                      busy={busy === `${r.email}|gtasks_sync`}
                      onChange={(v) => flip(r.email, { gtasks_sync: v })}
                    />
                  </td>
                  <td className="user-prefs-admin-viewas" dir="ltr">
                    {r.prefs.view_as_email || (
                      <span className="user-prefs-admin-empty">—</span>
                    )}
                  </td>
                  <td className="user-prefs-admin-updated" dir="ltr">
                    {r.updatedAt
                      ? new Date(r.updatedAt).toLocaleDateString("he-IL", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "2-digit",
                        })
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ToggleCell({
  checked,
  busy,
  onChange,
}: {
  checked: boolean;
  busy: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={busy}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function UserPrefsRow({
  row,
  busy,
  onFlip,
  isSelf,
}: {
  row: UserPrefRow;
  busy: string | null;
  onFlip: (partial: Partial<UserPrefs>) => void;
  isSelf?: boolean;
}) {
  const k = (key: string) => `${row.email}|${key}`;
  return (
    <div className="user-prefs-self-form">
      <label className="user-prefs-self-toggle">
        <input
          type="checkbox"
          checked={row.prefs.email_notifications}
          disabled={busy === k("email_notifications")}
          onChange={(e) =>
            onFlip({ email_notifications: e.target.checked })
          }
        />
        <span>
          ✉️ התראות במייל
          <small>הצמדות במשימות + ממתין לאישור + סיכום יומי</small>
        </span>
      </label>
      <label className="user-prefs-self-toggle">
        <input
          type="checkbox"
          checked={row.prefs.gtasks_sync}
          disabled={busy === k("gtasks_sync")}
          onChange={(e) => onFlip({ gtasks_sync: e.target.checked })}
        />
        <span>
          📋 סנכרון Google Tasks
          <small>הוספה ועדכון של משימות ברשימת ה-Tasks האישית</small>
        </span>
      </label>
      <label className="user-prefs-self-toggle">
        <input
          type="checkbox"
          checked={row.prefs.hide_archived}
          disabled={busy === k("hide_archived")}
          onChange={(e) => onFlip({ hide_archived: e.target.checked })}
        />
        <span>
          📦 הסתר משימות שבוצעו / בוטלו
          <small>הארכיון נכנס תחת תפריט נפתח ב-/tasks</small>
        </span>
      </label>
      {isSelf && row.prefs.view_as_email && (
        <div className="user-prefs-self-viewas">
          <span>👁️ הצג כ:</span>
          <code dir="ltr">{row.prefs.view_as_email}</code>
          <button
            type="button"
            className="btn-ghost btn-sm"
            disabled={busy === k("view_as_email")}
            onClick={() => onFlip({ view_as_email: "" })}
          >
            איפוס
          </button>
        </div>
      )}
    </div>
  );
}
