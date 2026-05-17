"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { PricingRow } from "@/lib/pricingMatch";

type Props = {
  initialRows: PricingRow[];
  companies: string[];
  /** company → its project names (for the project dropdown). */
  projectsByCompany: Record<string, string[]>;
  departmentOptions: string[];
  kindOptions: string[];
};

type EditRow = PricingRow & { _k: number };

let _seq = 0;
const mk = (r: Partial<PricingRow> = {}): EditRow => ({
  _k: ++_seq,
  company: r.company ?? "",
  project: r.project ?? "",
  department: r.department ?? "",
  type: r.type ?? "",
  unitPrice: r.unitPrice ?? 0,
});

/**
 * Admin editor for the per-company/project rate card (Pricingsetup
 * tab). Submits the WHOLE table on Save — matches replacePricingRows.
 * Project is OPTIONAL: leave it "— כל הפרויקטים (לפי חברה)" for a
 * company-level rate, which the new-task panel falls back to when no
 * project-specific row matches (lib/pricingMatch).
 */
export default function PricingEditor({
  initialRows,
  companies,
  projectsByCompany,
  departmentOptions,
  kindOptions,
}: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<EditRow[]>(
    initialRows.length ? initialRows.map((r) => mk(r)) : [mk()],
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const set = (k: number, patch: Partial<PricingRow>) =>
    setRows((rs) => rs.map((r) => (r._k === k ? { ...r, ...patch } : r)));
  const del = (k: number) => setRows((rs) => rs.filter((r) => r._k !== k));
  const add = () => setRows((rs) => [...rs, mk()]);

  const incomplete = useMemo(
    () =>
      rows.some(
        (r) =>
          (r.company || r.department || r.type) &&
          !(r.company && r.department && r.type),
      ),
    [rows],
  );

  async function save() {
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      const payload = rows
        .filter((r) => r.company && r.department && r.type)
        .map(({ company, project, department, type, unitPrice }) => ({
          company: company.trim(),
          project: project.trim(),
          department: department.trim(),
          type: type.trim(),
          unitPrice: Number(unitPrice) || 0,
        }));
      const res = await fetch("/api/admin/pricing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: payload }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        written?: number;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `שמירה נכשלה (${res.status})`);
      }
      setMsg(`✓ נשמרו ${data.written ?? payload.length} שורות תמחור.`);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pricing-editor">
      <p className="pricing-editor-hint">
        כל שורה: <b>חברה</b> + <b>מחלקה</b> + <b>סוג</b> → <b>מחיר יחידה</b>.
        השאר/י את <b>פרוייקט</b> ריק (״כל הפרויקטים״) למחיר ברמת חברה —
        טופס משימה חדשה ישתמש בו כשאין מחיר ספציפי לפרוייקט.
      </p>

      <div className="pricing-editor-table" role="table">
        <div className="pricing-editor-row pricing-editor-head" role="row">
          <span>חברה</span>
          <span>פרוייקט (אופציונלי)</span>
          <span>מחלקה</span>
          <span>סוג</span>
          <span>מחיר ₪</span>
          <span aria-hidden />
        </div>
        {rows.map((r) => {
          const projOpts = projectsByCompany[r.company] ?? [];
          return (
            <div className="pricing-editor-row" role="row" key={r._k}>
              <select
                value={r.company}
                onChange={(e) =>
                  set(r._k, { company: e.target.value, project: "" })
                }
              >
                <option value="">בחר/י חברה…</option>
                {companies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select
                value={r.project}
                onChange={(e) => set(r._k, { project: e.target.value })}
                disabled={!r.company}
              >
                <option value="">— כל הפרויקטים (לפי חברה)</option>
                {projOpts.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <select
                value={r.department}
                onChange={(e) => set(r._k, { department: e.target.value })}
              >
                <option value="">בחר/י מחלקה…</option>
                {departmentOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <select
                value={r.type}
                onChange={(e) => set(r._k, { type: e.target.value })}
              >
                <option value="">בחר/י סוג…</option>
                {kindOptions.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="0"
                step="1"
                value={r.unitPrice}
                onChange={(e) =>
                  set(r._k, { unitPrice: Number(e.target.value) || 0 })
                }
              />
              <button
                type="button"
                className="pricing-editor-del"
                onClick={() => del(r._k)}
                aria-label="מחק שורה"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <div className="pricing-editor-actions">
        <button type="button" className="btn-ghost btn-sm" onClick={add}>
          + הוסף שורה
        </button>
        <button
          type="button"
          className="btn-primary btn-sm"
          onClick={save}
          disabled={saving}
        >
          {saving ? "שומר…" : "שמור"}
        </button>
        {incomplete && (
          <span className="pricing-editor-warn">
            שורות חסרות (חברה/מחלקה/סוג) לא יישמרו.
          </span>
        )}
        {msg && <span className="pricing-editor-ok">{msg}</span>}
        {err && <span className="pricing-editor-err">{err}</span>}
      </div>
    </div>
  );
}
