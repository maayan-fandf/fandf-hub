"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { TaskFormSchema } from "@/lib/taskFormSchema";

/**
 * Read-only viewer for the task-form schema, sourced directly from
 * Drive (`<shared>/סכמות משימה/<Dept>/<Kind>/`). Two write actions
 * for admins:
 *
 *   1. **+ הוסף מחלקה** — creates a new dept folder under סכמות משימה.
 *   2. **+ הוסף סוג** — creates a new kind folder under a chosen dept.
 *
 * Renames + deletes are deliberately NOT in this UI — admins manage
 * those via Drive's own UI (right-click → rename / delete on the
 * folder), where they can also see the templates inside each kind
 * folder. The hub viewer keeps focus on adding new options to the
 * form's dropdowns.
 *
 * Display kept as <details> blocks per dept so the layout matches
 * what admins are used to from the previous sheet-backed editor.
 *
 * NOTE: the file is named `TaskFormSchemaEditor.tsx` (not Viewer) for
 * git-history continuity with the previous sheet-based editor.
 */

type Props = {
  schema: TaskFormSchema;
};

const TEMPLATES_ROOT_NAME = "סכמות משימה";

export default function TaskFormSchemaViewer({ schema }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  /** When set to a dept name, the inline "add kind" form is shown
   *  beneath that dept. When "__new_dept__", the inline "add dept"
   *  form is shown above the list. */
  const [adding, setAdding] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState("");

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      // The folder-create endpoint invalidates the in-process cache;
      // here we want a no-op invalidation purely to bust the cache,
      // then a router.refresh() to re-render with fresh data. Calling
      // POST without a `dept` returns 400 (bad request) which we
      // treat as success for the cache-bust side effect — but it's
      // cleaner to add a dedicated invalidate endpoint. For v1 we
      // just refresh; cache TTL is 5 min so the worst case is a
      // brief delay before new Drive folders show up.
      router.refresh();
    } finally {
      setRefreshing(false);
    }
  }

  async function createFolder(dept: string, kind?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/task-form-folder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dept, kind: kind || undefined }),
      });
      const data = (await res.json()) as
        | { ok: true; folderId: string; dept: string; kind: string | null }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error("error" in data ? data.error : `HTTP ${res.status}`);
      }
      setAdding(null);
      setPendingName("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function startAddDept() {
    setAdding("__new_dept__");
    setPendingName("");
  }
  function startAddKind(dept: string) {
    setAdding(dept);
    setPendingName("");
  }
  function cancelAdd() {
    setAdding(null);
    setPendingName("");
  }

  return (
    <div className="task-form-schema-editor">
      {error && <div className="error">{error}</div>}

      <div className="task-form-schema-toolbar">
        <button
          type="button"
          className="btn-ghost"
          onClick={startAddDept}
          disabled={busy}
        >
          + הוסף מחלקה
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={refresh}
          disabled={refreshing || busy}
          title="טען מחדש את התיקיות מ-Drive"
        >
          {refreshing ? "טוען…" : "🔄 רענן"}
        </button>
      </div>

      {adding === "__new_dept__" && (
        <div className="task-form-schema-inline-add">
          <span>שם מחלקה חדשה:</span>
          <input
            type="text"
            value={pendingName}
            onChange={(e) => setPendingName(e.target.value)}
            placeholder="לדוג': Designer"
            autoFocus
          />
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={busy || !pendingName.trim()}
            onClick={() => createFolder(pendingName.trim())}
          >
            {busy ? "יוצר…" : "צור תיקייה"}
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={cancelAdd}
            disabled={busy}
          >
            ביטול
          </button>
        </div>
      )}

      {schema.departments.length === 0 ? (
        <div className="task-form-schema-empty-block">
          אין מחלקות עדיין. לחץ על &quot;+ הוסף מחלקה&quot; כדי להתחיל, או
          צור תיקייה ישירות תחת <code>{TEMPLATES_ROOT_NAME}/</code> ב-Drive.
        </div>
      ) : (
        <div className="task-form-schema-groups">
          {schema.departments.map((dept) => {
            const kinds = schema.kindsByDepartment[dept] ?? [];
            const folders = schema.templatesByDeptAndKind[dept] ?? {};
            return (
              <details
                key={dept}
                className="task-form-schema-group"
                open
              >
                <summary>
                  <span className="task-form-schema-group-name">{dept}</span>
                  <span className="task-form-schema-group-count">
                    {kinds.length}{" "}
                    {kinds.length === 1 ? "סוג" : "סוגים"}
                  </span>
                  <span className="task-form-schema-group-spacer" />
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={(e) => {
                      e.preventDefault();
                      startAddKind(dept);
                    }}
                    disabled={busy}
                    title={`הוסף סוג ל-${dept}`}
                  >
                    + הוסף סוג
                  </button>
                </summary>
                <div className="task-form-schema-kinds">
                  {kinds.map((kind) => {
                    const kindFolderId = folders[kind] || "";
                    return (
                      <div className="task-form-schema-kind-row" key={kind}>
                        <span className="task-form-schema-kind-name">
                          {kind}
                        </span>
                        {kindFolderId && (
                          <a
                            href={`https://drive.google.com/drive/folders/${kindFolderId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="task-form-schema-kind-link"
                            title={kindFolderId}
                          >
                            📁 פתח תיקייה
                          </a>
                        )}
                      </div>
                    );
                  })}
                  {kinds.length === 0 && (
                    <div className="task-form-schema-kind-row task-form-schema-kind-empty">
                      <span>אין סוגים בתיקייה הזו עדיין.</span>
                    </div>
                  )}
                  {adding === dept && (
                    <div className="task-form-schema-inline-add">
                      <span>שם סוג חדש:</span>
                      <input
                        type="text"
                        value={pendingName}
                        onChange={(e) => setPendingName(e.target.value)}
                        placeholder="לדוג': קריאייטיב פרסומי"
                        autoFocus
                      />
                      <button
                        type="button"
                        className="btn-primary btn-sm"
                        disabled={busy || !pendingName.trim()}
                        onClick={() => createFolder(dept, pendingName.trim())}
                      >
                        {busy ? "יוצר…" : "צור תיקייה"}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={cancelAdd}
                        disabled={busy}
                      >
                        ביטול
                      </button>
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}
