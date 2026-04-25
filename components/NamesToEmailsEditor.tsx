"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { NameEmailRow } from "@/lib/appsScript";
import {
  CANONICAL_ROLE_OPTIONS,
  classifyRoleText,
  defaultViewLabel,
} from "@/lib/userRoleHelpers";

type Props = { initial: NameEmailRow[] };

type DraftRow = {
  // stable key for React — NOT the name (names can change mid-edit)
  uiKey: string;
  // the name this row was loaded with — `""` for a brand-new local row.
  // Used as the identifier for upsert/delete against the server.
  canonicalName: string;
  draftName: string;
  draftEmail: string;
  draftRole: string;
  isEditing: boolean;
  isBusy: boolean;
  error: string | null;
};

function makeKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function rowsFromInitial(initial: NameEmailRow[]): DraftRow[] {
  return initial.map((r) => ({
    uiKey: makeKey(),
    canonicalName: r.full_name,
    draftName: r.full_name,
    draftEmail: r.email,
    draftRole: r.role ?? "",
    isEditing: false,
    isBusy: false,
    error: null,
  }));
}

/**
 * Table editor for the `names to emails` sheet. Each row can be edited in
 * place; the save button POSTs to /api/admin/names-to-emails with upsert
 * semantics on `fullName`. Delete is DELETE on the same route.
 *
 * "canonicalName" (the name as last-persisted) is the key the server uses
 * for upsert/delete. When the user edits the name, we treat a name change
 * as "rename": on save, we call upsert with the new name AND also delete
 * the old canonical row — but only if the name actually changed and the
 * new name isn't already in the list.
 */
export default function NamesToEmailsEditor({ initial }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<DraftRow[]>(() => rowsFromInitial(initial));
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function update(uiKey: string, patch: Partial<DraftRow>) {
    setRows((rs) => rs.map((r) => (r.uiKey === uiKey ? { ...r, ...patch } : r)));
  }

  function beginEdit(uiKey: string) {
    update(uiKey, { isEditing: true, error: null });
  }

  function cancelEdit(uiKey: string) {
    setRows((rs) =>
      rs.map((r) => {
        if (r.uiKey !== uiKey) return r;
        // Rollback draft values to what the server last knew.
        if (!r.canonicalName && !r.draftEmail) {
          // Brand-new row with nothing entered — remove it.
          return null as unknown as DraftRow;
        }
        return {
          ...r,
          isEditing: false,
          draftName: r.canonicalName,
          draftEmail: r.canonicalName ? r.draftEmail : "",
          error: null,
        };
      }),
    );
    setRows((rs) => rs.filter(Boolean));
  }

  function addRow() {
    setRows((rs) => [
      ...rs,
      {
        uiKey: makeKey(),
        canonicalName: "",
        draftName: "",
        draftEmail: "",
        draftRole: "",
        isEditing: true,
        isBusy: false,
        error: null,
      },
    ]);
  }

  function save(row: DraftRow) {
    const newName = row.draftName.trim();
    const newEmail = row.draftEmail.trim().toLowerCase();

    if (!newName) {
      update(row.uiKey, { error: "שם מלא חובה" });
      return;
    }
    if (!newEmail || !newEmail.includes("@")) {
      update(row.uiKey, { error: "אימייל לא תקין" });
      return;
    }
    // If this is a rename AND the new name collides with another row, block.
    const nameConflict = rows.some(
      (r) =>
        r.uiKey !== row.uiKey &&
        r.canonicalName.toLowerCase() === newName.toLowerCase(),
    );
    if (nameConflict) {
      update(row.uiKey, { error: "השם כבר קיים ברשימה" });
      return;
    }

    update(row.uiKey, { isBusy: true, error: null });
    setGlobalError(null);

    startTransition(async () => {
      try {
        // Upsert new/current name.
        const upsertRes = await fetch("/api/admin/names-to-emails", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fullName: newName,
            email: newEmail,
            role: row.draftRole.trim(),
          }),
        });
        if (!upsertRes.ok) {
          const data = (await upsertRes.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(data.error || `Upsert failed (${upsertRes.status})`);
        }

        // Handle rename: if canonicalName was set AND differs from new name,
        // delete the old canonical row. Skip if it was a brand-new row.
        const renamedFrom = row.canonicalName.trim();
        if (
          renamedFrom &&
          renamedFrom.toLowerCase() !== newName.toLowerCase()
        ) {
          const delRes = await fetch("/api/admin/names-to-emails", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fullName: renamedFrom }),
          });
          if (!delRes.ok) {
            // Partial failure — new row saved, old not removed. Surface it
            // so admin can clean up.
            const data = (await delRes.json().catch(() => ({}))) as {
              error?: string;
            };
            setGlobalError(
              `נוצר שם חדש (${newName}) אבל לא נמחק הישן (${renamedFrom}): ${data.error ?? delRes.status}`,
            );
          }
        }

        // Commit locally: update canonical + exit edit mode.
        update(row.uiKey, {
          canonicalName: newName,
          draftName: newName,
          draftEmail: newEmail,
          draftRole: row.draftRole.trim(),
          isEditing: false,
          isBusy: false,
          error: null,
        });
        router.refresh();
      } catch (err) {
        update(row.uiKey, {
          isBusy: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  function remove(row: DraftRow) {
    // Brand-new (never saved) row: just drop it locally.
    if (!row.canonicalName) {
      setRows((rs) => rs.filter((r) => r.uiKey !== row.uiKey));
      return;
    }
    if (
      !window.confirm(`למחוק את "${row.canonicalName}"? לא ניתן לבטל.`)
    ) {
      return;
    }
    update(row.uiKey, { isBusy: true, error: null });
    setGlobalError(null);

    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/names-to-emails", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fullName: row.canonicalName }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(data.error || `Delete failed (${res.status})`);
        }
        setRows((rs) => rs.filter((r) => r.uiKey !== row.uiKey));
        router.refresh();
      } catch (err) {
        update(row.uiKey, {
          isBusy: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  return (
    <div className="admin-editor">
      {globalError && <div className="error">{globalError}</div>}

      <details className="admin-role-help">
        <summary>
          ערכי תפקיד קנוניים — בחר אחד כדי שהמערכת תזהה את ברירת המחדל בתצוגה
        </summary>
        <ul>
          {CANONICAL_ROLE_OPTIONS.map((o) => (
            <li key={o.value}>
              <code>{o.value}</code> — {o.hint}
            </li>
          ))}
        </ul>
        <p className="subtitle">
          כל ערך אחר ייכנס ל-Sheets כפי שהוקלד, והמערכת תנסה לסווג אותו אוטומטית
          (למשל <code>media</code> → קריאייטיב, <code>client manager</code> → מנהל).
          אם הסיווג לא מצליח, ברירת המחדל היא &quot;משימות שיצרת&quot;.
        </p>
      </details>

      <datalist id="role-suggestions">
        {CANONICAL_ROLE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.hint}
          </option>
        ))}
      </datalist>

      <table className="admin-table">
        <thead>
          <tr>
            <th>שם מלא</th>
            <th>אימייל</th>
            <th>תפקיד</th>
            <th>ברירת מחדל בתצוגה</th>
            <th className="admin-table-actions-head">פעולות</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="empty-small">
                הרשימה ריקה. לחץ על &quot;הוסף שורה&quot;.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr
              key={r.uiKey}
              className={r.isBusy ? "is-busy" : ""}
            >
              <td>
                {r.isEditing ? (
                  <input
                    type="text"
                    className="admin-input"
                    value={r.draftName}
                    dir="auto"
                    placeholder="לדוגמה: Maayan Sachs"
                    onChange={(e) =>
                      update(r.uiKey, { draftName: e.target.value })
                    }
                    disabled={r.isBusy}
                    autoFocus={!r.canonicalName}
                  />
                ) : (
                  <span dir="auto">{r.canonicalName}</span>
                )}
              </td>
              <td>
                {r.isEditing ? (
                  <input
                    type="email"
                    className="admin-input"
                    value={r.draftEmail}
                    dir="ltr"
                    placeholder="person@fandf.co.il"
                    onChange={(e) =>
                      update(r.uiKey, { draftEmail: e.target.value })
                    }
                    disabled={r.isBusy}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        save(r);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEdit(r.uiKey);
                      }
                    }}
                  />
                ) : (
                  <span dir="ltr">{r.draftEmail}</span>
                )}
              </td>
              <td>
                {r.isEditing ? (
                  <input
                    type="text"
                    className="admin-input"
                    list="role-suggestions"
                    value={r.draftRole}
                    dir="auto"
                    placeholder="קריאייטיב / מנהל / לקוח…"
                    onChange={(e) =>
                      update(r.uiKey, { draftRole: e.target.value })
                    }
                    disabled={r.isBusy}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        save(r);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEdit(r.uiKey);
                      }
                    }}
                  />
                ) : r.draftRole ? (
                  <span className="admin-role-chip" dir="auto">
                    {r.draftRole}
                  </span>
                ) : (
                  <span className="subtitle">—</span>
                )}
              </td>
              <td>
                {(() => {
                  const cls = classifyRoleText(r.draftRole);
                  const cn = `admin-default-chip admin-default-${cls}`;
                  return (
                    <span className={cn} title={defaultViewLabel(cls)}>
                      {defaultViewLabel(cls)}
                    </span>
                  );
                })()}
              </td>
              <td className="admin-table-actions">
                {r.isEditing ? (
                  <>
                    <button
                      type="button"
                      className="reply-btn reply-btn-primary"
                      onClick={() => save(r)}
                      disabled={r.isBusy}
                    >
                      {r.isBusy ? "שומר…" : "שמור"}
                    </button>
                    <button
                      type="button"
                      className="reply-btn reply-btn-ghost"
                      onClick={() => cancelEdit(r.uiKey)}
                      disabled={r.isBusy}
                    >
                      ביטול
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="reply-btn"
                      onClick={() => beginEdit(r.uiKey)}
                      disabled={r.isBusy}
                    >
                      ערוך
                    </button>
                    <button
                      type="button"
                      className="delete-btn is-minimal"
                      onClick={() => remove(r)}
                      disabled={r.isBusy}
                      title="מחק"
                    >
                      ✕
                    </button>
                  </>
                )}
                {r.error && (
                  <span className="resolve-btn-error">{r.error}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="admin-editor-foot">
        <button
          type="button"
          className="reply-btn"
          onClick={addRow}
          disabled={isPending}
        >
          + הוסף שורה
        </button>
        <span className="subtitle">
          סה&quot;כ {rows.filter((r) => r.canonicalName).length} רשומות
        </span>
      </div>
    </div>
  );
}
