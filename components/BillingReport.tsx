"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { PricingLogRow } from "@/lib/pricingLog";

const fmtILS = (n: number) => "₪" + Math.round(n).toLocaleString("he-IL");

/**
 * Month-end billing report. Reads the PricingLog ledger, filters by
 * month (+ optional company), groups by company with subtotals + a
 * grand total, and exports the filtered view as CSV for finance.
 *
 * The amount to invoice each entry is editable: an inline edit writes
 * a `billed` override on that ledger row ONLY (POST
 * /api/admin/billing/edit). The recorded `price`, the task, and the
 * rate card (/admin/pricing) are never touched — it's purely "bill
 * this entry higher/lower this month". Totals use the effective amount
 * (billed ?? price).
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

  // Per-session edits: taskId → override (number) or null (= cleared,
  // bill the price). Absent key = use the server's r.billed.
  const [edited, setEdited] = useState<Record<string, number | null>>({});
  const [editing, setEditing] = useState<string>(""); // taskId being edited
  const [draft, setDraft] = useState<string>("");
  const [busyId, setBusyId] = useState<string>("");
  const [actionErr, setActionErr] = useState<string>("");

  // Effective override for a row: session edit wins, else server value.
  const overrideOf = (r: PricingLogRow): number | null =>
    Object.prototype.hasOwnProperty.call(edited, r.taskId)
      ? edited[r.taskId]
      : r.billed ?? null;
  const billOf = (r: PricingLogRow): number => {
    const ov = overrideOf(r);
    return ov == null ? r.price || 0 : ov;
  };

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
        subtotal: rs.reduce((s, r) => s + billOf(r), 0),
      }))
      .sort((a, b) => a.company.localeCompare(b.company, "he"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, edited]);

  const grandTotal = filtered.reduce((s, r) => s + billOf(r), 0);

  async function saveBilled(taskId: string, reset: boolean) {
    setBusyId(taskId);
    setActionErr("");
    try {
      const body = reset
        ? { taskId, reset: true }
        : { taskId, billed: Number(draft.replace(",", ".")) };
      if (!reset) {
        const n = Number(draft.replace(",", "."));
        if (!Number.isFinite(n) || n < 0) {
          setActionErr("יש להזין סכום תקין");
          setBusyId("");
          return;
        }
      }
      const res = await fetch("/api/admin/billing/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "save failed");
      setEdited((prev) => ({
        ...prev,
        [taskId]: reset
          ? null
          : typeof data.billed === "number"
            ? data.billed
            : null,
      }));
      setEditing("");
      setDraft("");
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId("");
    }
  }

  function exportCsv() {
    const head = [
      "month",
      "created_at",
      "company",
      "project",
      "task",
      "brief",
      "worker",
      "departments",
      "kind",
      "price",
      "billed",
      "adjusted",
      "task_id",
      "created_by",
    ];
    const esc = (v: string) =>
      /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [head.join(",")];
    for (const g of groups) {
      for (const r of g.rows) {
        const ov = overrideOf(r);
        lines.push(
          [
            r.month,
            r.createdAt,
            r.company,
            r.project,
            r.title ?? "",
            r.brief ?? "",
            r.worker ?? "",
            r.departments,
            r.kind,
            String(r.price),
            String(billOf(r)),
            ov != null ? "1" : "",
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
      {actionErr && (
        <div className="time-tracker-error" role="alert">
          {actionErr}
        </div>
      )}

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
              <div className="billing-row bill-row billing-row-head" role="row">
                <span>תאריך</span>
                <span>משימה</span>
                <span>בריף</span>
                <span>פרוייקט</span>
                <span>מחלקה</span>
                <span>סוג</span>
                <span>מחיר</span>
                <span>חיוב</span>
                <span>נוצר ע״י</span>
              </div>
              {g.rows.map((r) => {
                const ov = overrideOf(r);
                const adjusted = ov != null;
                const bill = billOf(r);
                const isEditing = editing === r.taskId;
                return (
                  <div
                    className="billing-row bill-row"
                    role="row"
                    key={r.taskId}
                  >
                    <span title={r.createdAt}>
                      {r.createdAt.slice(0, 10)}
                    </span>
                    <span
                      className="time-task-cell"
                      title={r.title || r.taskId}
                    >
                      {r.taskId ? (
                        <Link
                          href={`/tasks/${encodeURIComponent(r.taskId)}`}
                          className="time-task-link"
                        >
                          {r.title || r.taskId}
                        </Link>
                      ) : (
                        <span className="time-task-link">
                          {r.title || "—"}
                        </span>
                      )}
                    </span>
                    <span title={r.brief || ""}>{r.brief || "—"}</span>
                    <span>{r.project || "—"}</span>
                    <span>{r.departments || "—"}</span>
                    <span>{r.kind || "—"}</span>
                    <span
                      className={
                        "billing-price" + (adjusted ? " is-struck" : "")
                      }
                      title={adjusted ? "המחיר הרשום (לא משתנה)" : ""}
                    >
                      {fmtILS(r.price)}
                    </span>
                    {isEditing ? (
                      <span className="bill-edit">
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="any"
                          className="bill-edit-input"
                          value={draft}
                          autoFocus
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter")
                              void saveBilled(r.taskId, false);
                            if (e.key === "Escape") {
                              setEditing("");
                              setDraft("");
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          disabled={busyId === r.taskId}
                          onClick={() => void saveBilled(r.taskId, false)}
                        >
                          {busyId === r.taskId ? "…" : "שמור"}
                        </button>
                        {adjusted && (
                          <button
                            type="button"
                            className="btn-ghost btn-sm"
                            disabled={busyId === r.taskId}
                            title="חזרה למחיר הרשום"
                            onClick={() => void saveBilled(r.taskId, true)}
                          >
                            איפוס
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          disabled={busyId === r.taskId}
                          onClick={() => {
                            setEditing("");
                            setDraft("");
                            setActionErr("");
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={
                          "bill-cell" + (adjusted ? " is-adjusted" : "")
                        }
                        title={
                          adjusted
                            ? `מותאם לחיוב — מחיר רשום ${fmtILS(r.price)}. לחיצה לעריכה`
                            : "לחיצה לעריכת סכום החיוב לשורה זו"
                        }
                        onClick={() => {
                          setEditing(r.taskId);
                          setDraft(String(bill));
                          setActionErr("");
                        }}
                      >
                        <span className="bill-amount">{fmtILS(bill)}</span>
                        {adjusted && (
                          <span className="bill-tag">מותאם</span>
                        )}
                        <span className="bill-pencil" aria-hidden>
                          ✎
                        </span>
                      </button>
                    )}
                    <span className="billing-by">
                      {r.createdBy.split("@")[0]}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
