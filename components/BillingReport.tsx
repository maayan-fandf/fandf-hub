"use client";

import { useMemo, useState } from "react";
import type { PricingLogRow } from "@/lib/pricingLog";

const fmtILS = (n: number) =>
  "₪" + Math.round(n).toLocaleString("he-IL");

/**
 * Month-end billing report. Reads the PricingLog ledger, filters by
 * month (+ optional company), groups by company with subtotals + a
 * grand total, and exports the filtered view as CSV for finance.
 */
export default function BillingReport({ rows }: { rows: PricingLogRow[] }) {
  const months = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.month).filter(Boolean))).sort(
        (a, b) => b.localeCompare(a),
      ),
    [rows],
  );
  const [month, setMonth] = useState<string>(months[0] ?? "");
  const [company, setCompany] = useState<string>("__all__");

  const monthRows = useMemo(
    () => rows.filter((r) => (month ? r.month === month : true)),
    [rows, month],
  );
  const companies = useMemo(
    () =>
      Array.from(
        new Set(monthRows.map((r) => r.company).filter(Boolean)),
      ).sort((a, b) => a.localeCompare(b, "he")),
    [monthRows],
  );
  const filtered = useMemo(
    () =>
      monthRows.filter((r) =>
        company === "__all__" ? true : r.company === company,
      ),
    [monthRows, company],
  );

  const groups = useMemo(() => {
    const m = new Map<string, PricingLogRow[]>();
    for (const r of filtered) {
      const k = r.company || "(ללא חברה)";
      let arr = m.get(k);
      if (!arr) {
        arr = [];
        m.set(k, arr);
      }
      arr.push(r);
    }
    return Array.from(m.entries())
      .map(([co, rs]) => ({
        company: co,
        rows: rs.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        subtotal: rs.reduce((s, r) => s + (r.price || 0), 0),
      }))
      .sort((a, b) => a.company.localeCompare(b.company, "he"));
  }, [filtered]);

  const grandTotal = filtered.reduce((s, r) => s + (r.price || 0), 0);

  function exportCsv() {
    const head = [
      "month",
      "created_at",
      "company",
      "project",
      "departments",
      "kind",
      "price",
      "task_id",
      "created_by",
    ];
    const esc = (v: string) =>
      /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [head.join(",")];
    for (const g of groups) {
      for (const r of g.rows) {
        lines.push(
          [
            r.month,
            r.createdAt,
            r.company,
            r.project,
            r.departments,
            r.kind,
            String(r.price),
            r.taskId,
            r.createdBy,
          ]
            .map((x) => esc(String(x ?? "")))
            .join(","),
        );
      }
    }
    const blob = new Blob(["﻿" + lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `billing_${month || "all"}_${
      company === "__all__" ? "all" : company
    }.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (rows.length === 0) {
    return (
      <div className="billing-empty">
        אין עדיין חיובים. ה־ledger מתמלא אוטומטית עם כל משימה חדשה
        שנוצרת עם מחיר (כולל כל שלב בשרשרת). חזור/י לכאן אחרי שייווצרו
        משימות עם תמחור.
      </div>
    );
  }

  return (
    <div className="billing-report">
      <div className="billing-controls">
        <label>
          חודש
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          חברה
          <select
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          >
            <option value="__all__">כל החברות</option>
            {companies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={exportCsv}
          disabled={filtered.length === 0}
        >
          ⬇ ייצוא CSV
        </button>
        <span className="billing-grand">
          סה״כ לחיוב {month}: <b>{fmtILS(grandTotal)}</b>
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="billing-empty">אין חיובים בחודש/חברה שנבחרו.</div>
      ) : (
        groups.map((g) => (
          <div key={g.company} className="billing-group">
            <div className="billing-group-head">
              <span className="billing-company">{g.company}</span>
              <span className="billing-subtotal">{fmtILS(g.subtotal)}</span>
            </div>
            <div className="billing-table" role="table">
              <div className="billing-row billing-row-head" role="row">
                <span>תאריך</span>
                <span>פרוייקט</span>
                <span>מחלקה</span>
                <span>סוג</span>
                <span>מחיר</span>
                <span>נוצר ע״י</span>
              </div>
              {g.rows.map((r) => (
                <div className="billing-row" role="row" key={r.taskId}>
                  <span title={r.createdAt}>
                    {r.createdAt.slice(0, 10)}
                  </span>
                  <span>{r.project || "—"}</span>
                  <span>{r.departments || "—"}</span>
                  <span>{r.kind || "—"}</span>
                  <span className="billing-price">{fmtILS(r.price)}</span>
                  <span className="billing-by">
                    {r.createdBy.split("@")[0]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
