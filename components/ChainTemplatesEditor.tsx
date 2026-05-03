"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ChainTemplate } from "@/lib/chainTemplates";

/**
 * Editor for the sheet-backed chain templates store. List of
 * collapsible cards (one per template), each with inline edit of:
 *   - label
 *   - default umbrella title
 *   - sequential steps list (title + department dropdown +
 *     assigneeHint), with add/remove/reorder
 *
 * Save and delete are per-template (not bulk) — each card has its
 * own buttons so a typo in one template doesn't block saving another.
 *
 * Phase 10 of dependencies feature, 2026-05-03.
 */
export default function ChainTemplatesEditor({
  initialTemplates,
  departmentOptions,
  seeded,
}: {
  initialTemplates: ChainTemplate[];
  departmentOptions: string[];
  /** True when the sheet was empty and the parent page seeded the
   *  editor with the hardcoded defaults — surfaced as a banner so
   *  the admin knows the first save will write the initial rows. */
  seeded: boolean;
}) {
  const router = useRouter();
  const [templates, setTemplates] = useState<ChainTemplate[]>(initialTemplates);

  function updateTemplate(idx: number, patch: Partial<ChainTemplate>) {
    setTemplates((cur) => {
      const next = [...cur];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  function addTemplate() {
    setTemplates((cur) => [
      ...cur,
      {
        id: `template-${Date.now().toString(36)}`,
        label: "תבנית חדשה",
        defaultUmbrellaTitle: "",
        steps: [{ title: "", department: "", assigneeHint: "" }],
      },
    ]);
  }

  return (
    <div className="chain-templates-editor">
      {seeded && (
        <div className="chain-templates-seed-banner">
          הרשימה למטה נטענה ממצב ברירת המחדל ההסטורי שהיה מוטמע בקוד —
          לחץ &quot;שמור&quot; על כל תבנית כדי לכתוב אותה ללשונית
          <code>ChainTemplates</code> ולהפוך אותה לסמכותית.
        </div>
      )}

      <div className="chain-templates-list">
        {templates.map((tpl, i) => (
          <TemplateCard
            key={tpl.id}
            template={tpl}
            departmentOptions={departmentOptions}
            onChange={(patch) => updateTemplate(i, patch)}
            onSaved={() => router.refresh()}
            onDeleted={() => {
              setTemplates((cur) => cur.filter((_, j) => j !== i));
              router.refresh();
            }}
          />
        ))}
      </div>

      <div className="chain-templates-add-row">
        <button
          type="button"
          className="btn-primary btn-sm"
          onClick={addTemplate}
        >
          + תבנית חדשה
        </button>
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  departmentOptions,
  onChange,
  onSaved,
  onDeleted,
}: {
  template: ChainTemplate;
  departmentOptions: string[];
  onChange: (patch: Partial<ChainTemplate>) => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/chain-templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(template),
      });
      const data = (await res.json()) as
        | { ok: true; created: boolean; rowIndex: number }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error("error" in data ? data.error : "Failed to save");
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function deleteIt() {
    if (!confirm(`למחוק את התבנית "${template.label}"?`)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/chain-templates", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: template.id }),
      });
      const data = (await res.json()) as
        | { ok: true; deleted: boolean }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error("error" in data ? data.error : "Failed to delete");
      }
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  function updateStep(idx: number, patch: Partial<ChainTemplate["steps"][0]>) {
    onChange({
      steps: template.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    });
  }
  function addStep() {
    onChange({
      steps: [...template.steps, { title: "", department: "", assigneeHint: "" }],
    });
  }
  function removeStep(idx: number) {
    onChange({ steps: template.steps.filter((_, i) => i !== idx) });
  }
  function moveStep(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= template.steps.length) return;
    const next = [...template.steps];
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange({ steps: next });
  }

  return (
    <details className="chain-template-card" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="chain-template-card-summary">
        <span className="chain-template-card-label">{template.label || "(ללא שם)"}</span>
        <span className="chain-template-card-meta">
          {template.steps.length} שלבים
        </span>
      </summary>
      {error && <div className="error">{error}</div>}
      <div className="chain-template-card-body">
        <label>
          מזהה (לא להציג / לא לשנות בדרך כלל)
          <input
            type="text"
            value={template.id}
            onChange={(e) => onChange({ id: e.target.value })}
            placeholder="kebab-case-en"
          />
        </label>
        <label>
          תווית (כותרת שתופיע בבורר)
          <input
            type="text"
            value={template.label}
            onChange={(e) => onChange({ label: e.target.value })}
          />
        </label>
        <label>
          כותרת ברירת מחדל לעטיפה
          <input
            type="text"
            value={template.defaultUmbrellaTitle}
            onChange={(e) =>
              onChange({ defaultUmbrellaTitle: e.target.value })
            }
            placeholder="לדוגמה: עדכון ויזואל"
          />
        </label>

        <fieldset className="chain-template-steps">
          <legend>שלבים</legend>
          {template.steps.map((s, i) => (
            <div key={i} className="chain-template-step-row">
              <span className="chain-template-step-num">{i + 1}</span>
              <input
                type="text"
                value={s.title}
                onChange={(e) => updateStep(i, { title: e.target.value })}
                placeholder={`שלב ${i + 1} — כותרת`}
                className="chain-template-step-title"
              />
              <select
                value={s.department || ""}
                onChange={(e) => updateStep(i, { department: e.target.value })}
                className="chain-template-step-dept"
                title="המבצע יסונן רק לאנשים מהמחלקה הזו"
              >
                <option value="">— ללא סינון מחלקה —</option>
                {departmentOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={s.assigneeHint || ""}
                onChange={(e) =>
                  updateStep(i, { assigneeHint: e.target.value })
                }
                placeholder="רמז (אופציונלי, בעברית)"
                className="chain-template-step-hint"
              />
              <div className="chain-template-step-controls">
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  onClick={() => moveStep(i, -1)}
                  disabled={i === 0}
                  aria-label="הזז למעלה"
                  title="הזז למעלה"
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  onClick={() => moveStep(i, +1)}
                  disabled={i === template.steps.length - 1}
                  aria-label="הזז למטה"
                  title="הזז למטה"
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  onClick={() => removeStep(i)}
                  disabled={template.steps.length === 1}
                  aria-label="הסר שלב"
                  title="הסר שלב"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={addStep}
          >
            + הוסף שלב
          </button>
        </fieldset>

        <div className="chain-template-actions">
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={save}
            disabled={saving}
          >
            {saving ? "שומר…" : "שמור"}
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={deleteIt}
            disabled={saving}
          >
            מחק
          </button>
        </div>
      </div>
    </details>
  );
}
