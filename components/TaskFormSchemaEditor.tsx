"use client";

import { useState } from "react";
import type { TaskFormSchemaRow } from "@/lib/taskFormSchema";

/**
 * Two-column editor for TaskFormSchema (מחלקה | סוג). Single-shot
 * save model — every Save button click POSTs the entire table to
 * /api/admin/task-form-schema, which clears the data area and
 * rewrites it. Simpler than a row-level CRUD for an admin tool with
 * one user editing at a time, and the sheet ↔ UI alignment stays
 * trivially correct.
 *
 * Local edits are dirty until saved; the page intentionally doesn't
 * autosave on every keystroke (Hebrew typing makes that noisy).
 *
 * Layout: rows are visually grouped into per-department <details>
 * sections so the editor scales as more departments accrue. Each
 * group has its own "+ הוסף סוג" inline button. Rows with an empty
 * department land in a trailing "ללא מחלקה" group so a freshly-added
 * blank row is always findable. Editing a row's department in-place
 * makes it jump to the matching group on the next render — that
 * matches the actual data semantics ("dept is a property of the
 * row") so the visible structure stays honest.
 */
export default function TaskFormSchemaEditor({
  initialRows,
}: {
  initialRows: TaskFormSchemaRow[];
}) {
  // Sort initial rows by department for visual grouping; preserve
  // the original order WITHIN each department so admin curation of
  // kind order is honored.
  const [rows, setRows] = useState<TaskFormSchemaRow[]>(() => {
    const byDept = new Map<string, TaskFormSchemaRow[]>();
    for (const r of initialRows) {
      const list = byDept.get(r.department) ?? [];
      list.push(r);
      byDept.set(r.department, list);
    }
    return Array.from(byDept.entries())
      .sort(([a], [b]) => a.localeCompare(b, "he"))
      .flatMap(([, list]) => list);
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  function update(idx: number, partial: Partial<TaskFormSchemaRow>) {
    setRows((cur) =>
      cur.map((r, i) => (i === idx ? { ...r, ...partial } : r)),
    );
    setDirty(true);
  }

  function addRow(template?: Partial<TaskFormSchemaRow>) {
    setRows((cur) => [
      ...cur,
      { department: template?.department ?? "", kind: template?.kind ?? "" },
    ]);
    setDirty(true);
  }

  function removeRow(idx: number) {
    setRows((cur) => cur.filter((_, i) => i !== idx));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Strip blanks before sending — saves a server round-trip on
      // empty rows the user added but didn't fill in.
      const cleaned = rows
        .map((r) => ({
          department: r.department.trim(),
          kind: r.kind.trim(),
        }))
        .filter((r) => r.department && r.kind);
      const res = await fetch("/api/admin/task-form-schema", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: cleaned }),
      });
      const body = (await res.json()) as
        | { ok: true; rows: TaskFormSchemaRow[] }
        | { ok: false; error: string };
      if (!res.ok || !body.ok) {
        throw new Error("error" in body ? body.error : `HTTP ${res.status}`);
      }
      setRows(body.rows);
      setSavedAt(new Date().toISOString());
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // Group rows by department for the collapsible per-dept sections.
  // Each entry remembers the row's absolute index in `rows` so the
  // update / removeRow callbacks keep working unchanged.
  const grouped: Array<{
    dept: string;
    rows: Array<{ row: TaskFormSchemaRow; idx: number }>;
  }> = (() => {
    const map = new Map<
      string,
      Array<{ row: TaskFormSchemaRow; idx: number }>
    >();
    rows.forEach((row, idx) => {
      const key = row.department.trim() || "__none__";
      const list = map.get(key) ?? [];
      list.push({ row, idx });
      map.set(key, list);
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => {
        // Push the "no department" bucket to the end so it doesn't
        // dominate the top of the list when the user adds blank rows.
        if (a === "__none__") return 1;
        if (b === "__none__") return -1;
        return a.localeCompare(b, "he");
      })
      .map(([key, list]) => ({
        dept: key === "__none__" ? "" : key,
        rows: list,
      }));
  })();

  // Distinct departments for the datalist — same source as the
  // grouping above, minus the "no dept" sentinel.
  const distinctDepts = grouped.map((g) => g.dept).filter(Boolean);

  return (
    <div className="task-form-schema-editor">
      {error && <div className="error">{error}</div>}

      <div className="task-form-schema-toolbar">
        <button
          type="button"
          className="btn-primary"
          onClick={save}
          disabled={saving || !dirty}
        >
          {saving ? "שומר…" : dirty ? "שמור שינויים" : "אין שינויים"}
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => addRow()}
          disabled={saving}
        >
          + שורה
        </button>
        {savedAt && !dirty && (
          <span className="task-form-schema-saved" dir="ltr">
            נשמר ב-{new Date(savedAt).toLocaleTimeString("he-IL")}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="task-form-schema-empty-block">
          אין שורות עדיין. לחץ על &quot;+ שורה&quot; כדי להתחיל, או ערוך
          ישירות את לשונית <code>TaskFormSchema</code> ב-Google Sheets.
        </div>
      ) : (
        <div className="task-form-schema-groups">
          {grouped.map(({ dept, rows: groupRows }) => (
            <details
              key={dept || "__none__"}
              className="task-form-schema-group"
              open
            >
              <summary>
                <span className="task-form-schema-group-name">
                  {dept || "ללא מחלקה"}
                </span>
                <span className="task-form-schema-group-count">
                  {groupRows.length}{" "}
                  {groupRows.length === 1 ? "סוג" : "סוגים"}
                </span>
                <span className="task-form-schema-group-spacer" />
                {dept && (
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={(e) => {
                      // Don't toggle the <details> open/closed state.
                      e.preventDefault();
                      addRow({ department: dept });
                    }}
                    disabled={saving}
                    title={`הוסף סוג ל-${dept}`}
                  >
                    + הוסף סוג
                  </button>
                )}
              </summary>
              <div className="task-form-schema-table-wrap themed-scrollbar">
                <table className="task-form-schema-table">
                  <thead>
                    <tr>
                      <th>מחלקה</th>
                      <th>סוג</th>
                      <th aria-label="פעולות" />
                    </tr>
                  </thead>
                  <tbody>
                    {groupRows.map(({ row: r, idx: i }) => (
                      <tr key={i}>
                        <td>
                          <input
                            type="text"
                            value={r.department}
                            onChange={(e) =>
                              update(i, { department: e.target.value })
                            }
                            placeholder="לדוג': קריאייטיב"
                            list="task-form-schema-departments"
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={r.kind}
                            onChange={(e) =>
                              update(i, { kind: e.target.value })
                            }
                            placeholder="לדוג': קריאייטיב פרסומי"
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            onClick={() => removeRow(i)}
                            disabled={saving}
                            aria-label="מחק שורה"
                            title="מחק"
                          >
                            🗑
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </div>
      )}

      <datalist id="task-form-schema-departments">
        {distinctDepts.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
    </div>
  );
}
