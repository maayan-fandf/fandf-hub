"use client";

import { useMemo, useState } from "react";
import type { TimeLogRow } from "@/lib/timeLog";

function fmtDur(min: number): string {
  const m = Math.max(0, Math.round(min || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} דק׳`;
  return r ? `${h}:${String(r).padStart(2, "0")} שע׳` : `${h} שע׳`;
}

/**
 * Time-tracking report — the informational sibling of /admin/billing.
 * Reads the TimeLog ledger, filters by month (+ optional company),
 * groups by company with sub-totals + a grand total (all in time, not
 * money — time does not drive a charge), and exports the filtered view
 * as CSV. Mirrors BillingReport so the two admin reports read the same.
 */
export default function TimeReport({ rows }: { rows: TimeLogRow[] }) {
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
    const m = new Map<string, TimeLogRow[]>();
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
        rows: rs.slice().sort((a, b) => a.loggedAt.localeCompare(b.loggedAt)),
        subtotal: rs.reduce((s, r) => s + (r.minutes || 0), 0),
      }))
      .sort((a, b) => a.company.localeCompare(b.company, "he"));
  }, [filtered]);

  const grandTotal = filtered.reduce((s, r) => s + (r.minutes || 0), 0);

  function exportCsv() {
    const head = [
      "month",
      "logged_at",
      "company",
      "project",
      "departments",
      "kind",
      "minutes",
      "hours",
      "note",
      "task_id",
      "logged_by",
    ];
    const esc = (v: string) =>
      /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = [head.join(",")];
    for (const g of groups) {
      for (const r of g.rows) {
        lines.push(
          [
            r.month,
            r.loggedAt,
            r.company,
            r.project,
            r.departments,
            r.kind,
            String(r.minutes),
            (r.minutes / 60).toFixed(2),
            r.note,
            r.taskId,
            r.loggedBy,
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
    a.download = `time_${month || "all"}_${
      company === "__all__" ? "all" : company
    }.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (rows.length === 0) {
    return (
      <div className="billing-empty">
        אין עדיין תיעוד זמן. ה־ledger מתמלא אוטומטית בכל פעם שמישהו מתעד
        זמן על משימה (בלוק ״מעקב זמן״ בעמוד המשימה). הזמן הוא מידע בלבד —
        אינו משפיע על החיוב ללקוח. חזור/י לכאן אחרי שיתועד זמן.
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
          סה״כ זמן {month}: <b>{fmtDur(grandTotal)}</b>
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="billing-empty">אין תיעוד בחודש/חברה שנבחרו.</div>
      ) : (
        groups.map((g) => (
          <div key={g.company} className="billing-group">
            <div className="billing-group-head">
              <span className="billing-company">{g.company}</span>
              <span className="billing-subtotal">{fmtDur(g.subtotal)}</span>
            </div>
            <div className="billing-table" role="table">
              <div className="billing-row time-row billing-row-head" role="row">
                <span>תאריך</span>
                <span>פרוייקט</span>
                <span>מחלקה</span>
                <span>הערה</span>
                <span>זמן</span>
                <span>תועד ע״י</span>
              </div>
              {g.rows.map((r, i) => (
                <div
                  className="billing-row time-row"
                  role="row"
                  key={`${r.taskId}-${r.loggedAt}-${i}`}
                >
                  <span title={r.loggedAt}>{r.loggedAt.slice(0, 10)}</span>
                  <span>{r.project || "—"}</span>
                  <span>{r.departments || "—"}</span>
                  <span title={r.note}>{r.note || "—"}</span>
                  <span className="billing-price">{fmtDur(r.minutes)}</span>
                  <span className="billing-by">
                    {r.loggedBy.split("@")[0]}
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
