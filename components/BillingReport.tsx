"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { PricingLogRow } from "@/lib/pricingLog";

const fmtILS = (n: number) => "₪" + Math.round(n).toLocaleString("he-IL");
const fmtInt = (n: number) => n.toLocaleString("he-IL");
const ALL = "__all__";
// Synthetic taskId prefix for manual (not-task-backed) ledger rows.
// Mirrors MANUAL_TASK_PREFIX in lib/pricingLog.ts (inlined to avoid
// pulling the server lib into the client bundle).
const MANUAL_PREFIX = "manual:";

/** Today's date (Asia/Jerusalem) as YYYY-MM-DD — default for the
 *  manual-entry date picker. */
function todayIL(): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

/**
 * Month-end billing report + workbench. Reads the PricingLog ledger and
 * lets the billing team:
 *   - filter (month / company / worker / department / kind / free-text /
 *     date range / "adjusted only" / "has note"),
 *   - read a live summary (item count, price vs billed, adjustment delta)
 *     and per-worker / per-department breakdowns,
 *   - adjust the amount to invoice per entry (a `billed` override that
 *     never touches the recorded `price` or the rate card), and
 *   - attach a free-text note per entry (pure annotation),
 *   - export the filtered view as CSV.
 *
 * Both per-entry edits (billed / note) write to that ledger row ONLY via
 * the admin APIs; totals use the effective amount (billed ?? price).
 */

const tokensOf = (s: string | undefined): string[] =>
  (s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export default function BillingReport({ rows }: { rows: PricingLogRow[] }) {
  // Manually-added rows (this session) are merged ahead of the
  // server-rendered ledger so they show without a full reload.
  const [extraRows, setExtraRows] = useState<PricingLogRow[]>([]);
  const allRows = useMemo(() => [...extraRows, ...rows], [extraRows, rows]);

  const months = useMemo(
    () =>
      Array.from(new Set(allRows.map((r) => r.month).filter(Boolean))).sort(
        (a, b) => b.localeCompare(a),
      ),
    [allRows],
  );

  // ── Filter state ──────────────────────────────────────────────────
  const [month, setMonth] = useState<string>(months[0] ?? ALL);
  const [company, setCompany] = useState<string>(ALL);
  const [worker, setWorker] = useState<string>(ALL);
  const [department, setDepartment] = useState<string>(ALL);
  const [kind, setKind] = useState<string>(ALL);
  const [search, setSearch] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [adjustedOnly, setAdjustedOnly] = useState<boolean>(false);
  const [notedOnly, setNotedOnly] = useState<boolean>(false);

  // ── Per-session edits (override what the server returned) ──────────
  // billed: taskId → number (override) | null (cleared → bill the price).
  const [edited, setEdited] = useState<Record<string, number | null>>({});
  // note: taskId → string (absent key = use the server's r.note).
  const [notesEdited, setNotesEdited] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string>(""); // billed cell taskId
  const [draft, setDraft] = useState<string>("");
  const [editingNote, setEditingNote] = useState<string>(""); // note cell taskId
  const [noteDraft, setNoteDraft] = useState<string>("");
  const [busyId, setBusyId] = useState<string>("");
  const [busyNoteId, setBusyNoteId] = useState<string>("");
  const [actionErr, setActionErr] = useState<string>("");

  // ── Manual-entry form ─────────────────────────────────────────────
  const [showAdd, setShowAdd] = useState(false);
  const [addCompany, setAddCompany] = useState("");
  const [addProject, setAddProject] = useState("");
  const [addAmount, setAddAmount] = useState("");
  const [addNote, setAddNote] = useState("");
  const [addDate, setAddDate] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState("");

  // Effective billed override / amount for a row.
  const overrideOf = (r: PricingLogRow): number | null =>
    Object.prototype.hasOwnProperty.call(edited, r.taskId)
      ? edited[r.taskId]
      : r.billed ?? null;
  const billOf = (r: PricingLogRow): number => {
    const ov = overrideOf(r);
    return ov == null ? r.price || 0 : ov;
  };
  // Effective note for a row.
  const noteOf = (r: PricingLogRow): string =>
    Object.prototype.hasOwnProperty.call(notesEdited, r.taskId)
      ? notesEdited[r.taskId]
      : r.note ?? "";

  // Rows in the chosen month (drives the dependent filter option lists).
  const monthRows = useMemo(
    () => (month === ALL ? allRows : allRows.filter((r) => r.month === month)),
    [allRows, month],
  );

  // Every company ever seen (for the manual-entry datalist), independent
  // of the month filter.
  const allCompanies = useMemo(
    () =>
      Array.from(new Set(allRows.map((r) => r.company).filter(Boolean))).sort(
        (a, b) => a.localeCompare(b, "he"),
      ),
    [allRows],
  );

  const companies = useMemo(
    () =>
      Array.from(new Set(monthRows.map((r) => r.company).filter(Boolean))).sort(
        (a, b) => a.localeCompare(b, "he"),
      ),
    [monthRows],
  );
  const workers = useMemo(() => {
    const s = new Set<string>();
    for (const r of monthRows) for (const w of tokensOf(r.worker)) s.add(w);
    return Array.from(s).sort((a, b) => a.localeCompare(b, "he"));
  }, [monthRows]);
  const departments = useMemo(() => {
    const s = new Set<string>();
    for (const r of monthRows) for (const d of tokensOf(r.departments)) s.add(d);
    return Array.from(s).sort((a, b) => a.localeCompare(b, "he"));
  }, [monthRows]);
  const kinds = useMemo(
    () =>
      Array.from(new Set(monthRows.map((r) => r.kind).filter(Boolean))).sort(
        (a, b) => a.localeCompare(b, "he"),
      ),
    [monthRows],
  );

  // ── Apply the advanced filters ────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return monthRows.filter((r) => {
      if (company !== ALL && r.company !== company) return false;
      if (worker !== ALL && !tokensOf(r.worker).includes(worker)) return false;
      if (department !== ALL && !tokensOf(r.departments).includes(department))
        return false;
      if (kind !== ALL && r.kind !== kind) return false;
      if (adjustedOnly && overrideOf(r) == null) return false;
      if (notedOnly && !noteOf(r)) return false;
      const day = r.createdAt.slice(0, 10);
      if (dateFrom && day < dateFrom) return false;
      if (dateTo && day > dateTo) return false;
      if (q) {
        const hay = [
          r.title,
          r.brief,
          r.project,
          r.company,
          r.worker,
          r.kind,
          noteOf(r),
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    monthRows,
    company,
    worker,
    department,
    kind,
    adjustedOnly,
    notedOnly,
    dateFrom,
    dateTo,
    search,
    edited,
    notesEdited,
  ]);

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

  // ── Summary + breakdowns over the filtered cohort ─────────────────
  const summary = useMemo(() => {
    let totalPrice = 0;
    let totalBilled = 0;
    let adjusted = 0;
    let noted = 0;
    for (const r of filtered) {
      totalPrice += r.price || 0;
      totalBilled += billOf(r);
      if (overrideOf(r) != null) adjusted++;
      if (noteOf(r)) noted++;
    }
    return {
      count: filtered.length,
      totalPrice,
      totalBilled,
      delta: totalBilled - totalPrice,
      adjusted,
      noted,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, edited, notesEdited]);

  const byWorker = useMemo(
    () => breakdown(filtered, (r) => r.worker || "(לא משויך)", billOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, edited],
  );
  const byDepartment = useMemo(
    () => breakdown(filtered, (r) => r.departments || "(ללא מחלקה)", billOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, edited],
  );

  const grandTotal = summary.totalBilled;
  const anyAdvanced =
    company !== ALL ||
    worker !== ALL ||
    department !== ALL ||
    kind !== ALL ||
    !!search ||
    !!dateFrom ||
    !!dateTo ||
    adjustedOnly ||
    notedOnly;

  function clearFilters() {
    setCompany(ALL);
    setWorker(ALL);
    setDepartment(ALL);
    setKind(ALL);
    setSearch("");
    setDateFrom("");
    setDateTo("");
    setAdjustedOnly(false);
    setNotedOnly(false);
  }

  async function saveBilled(taskId: string, reset: boolean) {
    setBusyId(taskId);
    setActionErr("");
    try {
      let body: Record<string, unknown>;
      if (reset) {
        body = { taskId, reset: true };
      } else {
        const n = Number(draft.replace(",", "."));
        if (!Number.isFinite(n) || n < 0) {
          setActionErr("יש להזין סכום תקין");
          setBusyId("");
          return;
        }
        body = { taskId, billed: n };
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

  async function saveNote(taskId: string) {
    setBusyNoteId(taskId);
    setActionErr("");
    try {
      const res = await fetch("/api/admin/billing/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, note: noteDraft }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "save failed");
      setNotesEdited((prev) => ({
        ...prev,
        [taskId]: typeof data.note === "string" ? data.note : "",
      }));
      setEditingNote("");
      setNoteDraft("");
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyNoteId("");
    }
  }

  function openAddForm() {
    setAddErr("");
    setAddDate(todayIL());
    setShowAdd(true);
  }

  async function submitAdd() {
    setAddErr("");
    const company = addCompany.trim();
    const amt = Number(addAmount.replace(",", "."));
    if (!company) {
      setAddErr("יש לבחור/להזין חברה");
      return;
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      setAddErr("יש להזין סכום תקין");
      return;
    }
    setAddBusy(true);
    try {
      const res = await fetch("/api/admin/billing/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company,
          project: addProject.trim(),
          amount: amt,
          note: addNote,
          date: addDate,
        }),
      });
      const data = await res.json();
      if (!data.ok || !data.row) throw new Error(data.error || "save failed");
      const row = data.row as PricingLogRow;
      setExtraRows((prev) => [row, ...prev]);
      // Make sure the new row is visible: jump to its month, clear the
      // company filter (it may have been narrowed elsewhere).
      setMonth(row.month);
      setCompany(ALL);
      setShowAdd(false);
      setAddCompany("");
      setAddProject("");
      setAddAmount("");
      setAddNote("");
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAddBusy(false);
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
      "note",
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
            noteOf(r),
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
    a.download = `billing_${month === ALL ? "all" : month}_${
      company === ALL ? "all" : company
    }.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (allRows.length === 0) {
    return (
      <div className="billing-report">
        <div className="billing-empty">
          אין עדיין חיובים. ה־ledger מתמלא אוטומטית עם כל משימה חדשה
          שנוצרת עם מחיר (כולל כל שלב בשרשרת). אפשר גם להוסיף חיוב ידני.
        </div>
        <div className="billing-controls" style={{ marginTop: "1em" }}>
          <button type="button" className="btn-primary btn-sm" onClick={openAddForm}>
            ➕ הוסף חיוב ידני
          </button>
        </div>
        {showAdd && (
          <ManualAddForm
            companies={allCompanies}
            company={addCompany}
            setCompany={setAddCompany}
            project={addProject}
            setProject={setAddProject}
            amount={addAmount}
            setAmount={setAddAmount}
            note={addNote}
            setNote={setAddNote}
            date={addDate}
            setDate={setAddDate}
            busy={addBusy}
            err={addErr}
            onSubmit={submitAdd}
            onCancel={() => setShowAdd(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="billing-report">
      {/* Primary controls */}
      <div className="billing-controls">
        <label>
          חודש
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value={ALL}>כל החודשים</option>
            {months.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          חברה
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value={ALL}>כל החברות</option>
            {companies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="billing-search">
          חיפוש
          <input
            type="search"
            value={search}
            placeholder="משימה, בריף, פרויקט, עובד, הערה…"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn-primary btn-sm"
          onClick={openAddForm}
          title="הוסף שורת חיוב ידנית — לא קשורה למשימה"
        >
          ➕ הוסף חיוב ידני
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={exportCsv}
          disabled={filtered.length === 0}
        >
          ⬇ ייצוא CSV
        </button>
        <span className="billing-grand">
          סה״כ לחיוב{month === ALL ? "" : ` ${month}`}:{" "}
          <b>{fmtILS(grandTotal)}</b>
        </span>
      </div>

      {showAdd && (
        <ManualAddForm
          companies={allCompanies}
          company={addCompany}
          setCompany={setAddCompany}
          project={addProject}
          setProject={setAddProject}
          amount={addAmount}
          setAmount={setAddAmount}
          note={addNote}
          setNote={setAddNote}
          date={addDate}
          setDate={setAddDate}
          busy={addBusy}
          err={addErr}
          onSubmit={submitAdd}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {/* Advanced filters */}
      <div className="billing-filters">
        <label>
          עובד
          <select value={worker} onChange={(e) => setWorker(e.target.value)}>
            <option value={ALL}>כל העובדים</option>
            {workers.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <label>
          מחלקה
          <select
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
          >
            <option value={ALL}>כל המחלקות</option>
            {departments.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label>
          סוג
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value={ALL}>כל הסוגים</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          מתאריך
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label>
          עד תאריך
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
        <label className="billing-toggle">
          <input
            type="checkbox"
            checked={adjustedOnly}
            onChange={(e) => setAdjustedOnly(e.target.checked)}
          />
          מותאמים בלבד
        </label>
        <label className="billing-toggle">
          <input
            type="checkbox"
            checked={notedOnly}
            onChange={(e) => setNotedOnly(e.target.checked)}
          />
          עם הערה בלבד
        </label>
        {anyAdvanced && (
          <button
            type="button"
            className="btn-ghost btn-sm billing-clear"
            onClick={clearFilters}
          >
            ✕ נקה סינון
          </button>
        )}
      </div>

      {actionErr && (
        <div className="time-tracker-error" role="alert">
          {actionErr}
        </div>
      )}

      {/* Summary stats */}
      <div className="billing-summary">
        <SummaryTile label="פריטים" value={fmtInt(summary.count)} />
        <SummaryTile label="מחיר רשום" value={fmtILS(summary.totalPrice)} />
        <SummaryTile label="לחיוב" value={fmtILS(summary.totalBilled)} accent />
        <SummaryTile
          label="פער התאמה"
          value={(summary.delta >= 0 ? "+" : "−") + fmtILS(Math.abs(summary.delta))}
          tone={summary.delta === 0 ? undefined : summary.delta > 0 ? "up" : "down"}
        />
        <SummaryTile
          label="מותאמים"
          value={fmtInt(summary.adjusted)}
          sub={`מתוך ${fmtInt(summary.count)}`}
        />
        <SummaryTile label="עם הערה" value={fmtInt(summary.noted)} />
      </div>

      {/* Breakdowns */}
      {filtered.length > 0 && (
        <details className="billing-breakdowns">
          <summary>פילוח לפי עובד ומחלקה</summary>
          <div className="billing-breakdowns-grid">
            <BreakdownList title="לפי עובד" rows={byWorker} />
            <BreakdownList title="לפי מחלקה" rows={byDepartment} />
          </div>
        </details>
      )}

      {groups.length === 0 ? (
        <div className="billing-empty">אין חיובים שתואמים את הסינון.</div>
      ) : (
        groups.map((g) => (
          <div key={g.company} className="billing-group">
            <div className="billing-group-head">
              <span className="billing-company">
                {g.company}{" "}
                <span className="billing-group-count">
                  ({fmtInt(g.rows.length)})
                </span>
              </span>
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
                <span>הערה</span>
                <span>נוצר ע״י</span>
              </div>
              {g.rows.map((r) => {
                const ov = overrideOf(r);
                const adjusted = ov != null;
                const bill = billOf(r);
                const note = noteOf(r);
                const isEditing = editing === r.taskId;
                const isEditingNote = editingNote === r.taskId;
                const isManual = r.taskId.startsWith(MANUAL_PREFIX);
                return (
                  <div
                    className="billing-row bill-row"
                    role="row"
                    key={r.taskId}
                  >
                    <span title={r.createdAt}>{r.createdAt.slice(0, 10)}</span>
                    <span
                      className="time-task-cell"
                      title={isManual ? "חיוב ידני (לא קשור למשימה)" : r.title || r.taskId}
                    >
                      {isManual ? (
                        <span className="billing-manual-name">✍️ חיוב ידני</span>
                      ) : r.taskId ? (
                        <Link
                          href={`/tasks/${encodeURIComponent(r.taskId)}`}
                          className="time-task-link"
                        >
                          {r.title || r.taskId}
                        </Link>
                      ) : (
                        <span className="time-task-link">{r.title || "—"}</span>
                      )}
                    </span>
                    <span title={r.brief || ""}>{r.brief || "—"}</span>
                    <span title={r.project || ""}>{r.project || "—"}</span>
                    <span title={r.departments || ""}>
                      {r.departments || "—"}
                    </span>
                    <span title={r.kind || ""}>{r.kind || "—"}</span>
                    <span
                      className={"billing-price" + (adjusted ? " is-struck" : "")}
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
                        className={"bill-cell" + (adjusted ? " is-adjusted" : "")}
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
                        {adjusted && <span className="bill-tag">מותאם</span>}
                        <span className="bill-pencil" aria-hidden>
                          ✎
                        </span>
                      </button>
                    )}
                    {/* Note cell */}
                    {isEditingNote ? (
                      <span className="bill-edit bill-note-edit">
                        <input
                          type="text"
                          className="bill-note-input"
                          value={noteDraft}
                          autoFocus
                          maxLength={2000}
                          placeholder="הערת חיוב…"
                          onChange={(e) => setNoteDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void saveNote(r.taskId);
                            if (e.key === "Escape") {
                              setEditingNote("");
                              setNoteDraft("");
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          disabled={busyNoteId === r.taskId}
                          onClick={() => void saveNote(r.taskId)}
                        >
                          {busyNoteId === r.taskId ? "…" : "שמור"}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          disabled={busyNoteId === r.taskId}
                          onClick={() => {
                            setEditingNote("");
                            setNoteDraft("");
                            setActionErr("");
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={"bill-note-cell" + (note ? " has-note" : "")}
                        title={note || "לחיצה להוספת הערת חיוב"}
                        onClick={() => {
                          setEditingNote(r.taskId);
                          setNoteDraft(note);
                          setActionErr("");
                        }}
                      >
                        {note ? (
                          <span className="bill-note-text">{note}</span>
                        ) : (
                          <span className="bill-note-add">+ הערה</span>
                        )}
                      </button>
                    )}
                    <span className="billing-by" title={r.createdBy}>
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

/** Sum the effective billed amount per group key, sorted desc. */
function breakdown(
  rows: PricingLogRow[],
  keyOf: (r: PricingLogRow) => string,
  billOf: (r: PricingLogRow) => number,
): { label: string; count: number; total: number }[] {
  const m = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    const k = keyOf(r);
    const cur = m.get(k) || { count: 0, total: 0 };
    cur.count += 1;
    cur.total += billOf(r);
    m.set(k, cur);
  }
  return Array.from(m.entries())
    .map(([label, v]) => ({ label, count: v.count, total: v.total }))
    .sort((a, b) => b.total - a.total);
}

function SummaryTile({
  label,
  value,
  sub,
  accent,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  tone?: "up" | "down";
}) {
  return (
    <div
      className={
        "billing-stat" +
        (accent ? " is-accent" : "") +
        (tone ? ` is-${tone}` : "")
      }
    >
      <div className="billing-stat-value">{value}</div>
      <div className="billing-stat-label">{label}</div>
      {sub ? <div className="billing-stat-sub">{sub}</div> : null}
    </div>
  );
}

function ManualAddForm({
  companies,
  company,
  setCompany,
  project,
  setProject,
  amount,
  setAmount,
  note,
  setNote,
  date,
  setDate,
  busy,
  err,
  onSubmit,
  onCancel,
}: {
  companies: string[];
  company: string;
  setCompany: (v: string) => void;
  project: string;
  setProject: (v: string) => void;
  amount: string;
  setAmount: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  date: string;
  setDate: (v: string) => void;
  busy: boolean;
  err: string;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="billing-add" role="form" aria-label="הוספת חיוב ידני">
      <div className="billing-add-title">➕ חיוב ידני חדש</div>
      <div className="billing-add-grid">
        <label>
          חברה *
          <input
            type="text"
            list="billing-add-companies"
            value={company}
            placeholder="שם החברה"
            onChange={(e) => setCompany(e.target.value)}
            autoFocus
          />
          <datalist id="billing-add-companies">
            {companies.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label>
          פרויקט
          <input
            type="text"
            value={project}
            placeholder="(לא חובה)"
            onChange={(e) => setProject(e.target.value)}
          />
        </label>
        <label>
          סכום *
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={amount}
            placeholder="₪"
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit();
            }}
          />
        </label>
        <label>
          תאריך
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="billing-add-note">
          תיאור / הערה
          <input
            type="text"
            value={note}
            maxLength={2000}
            placeholder="על מה החיוב (יופיע בעמודת ההערה)"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit();
            }}
          />
        </label>
      </div>
      {err && (
        <div className="time-tracker-error" role="alert">
          {err}
        </div>
      )}
      <div className="billing-add-actions">
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={busy}
          onClick={onSubmit}
        >
          {busy ? "שומר…" : "הוסף חיוב"}
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={busy}
          onClick={onCancel}
        >
          ביטול
        </button>
      </div>
    </div>
  );
}

function BreakdownList({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; count: number; total: number }[];
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.total), 0) || 1;
  return (
    <div className="billing-breakdown">
      <div className="billing-breakdown-title">{title}</div>
      {rows.length === 0 ? (
        <div className="billing-breakdown-empty">—</div>
      ) : (
        <ul className="billing-breakdown-list">
          {rows.map((r) => (
            <li key={r.label} className="billing-breakdown-row" title={r.label}>
              <span className="billing-breakdown-bar-wrap">
                <span
                  className="billing-breakdown-bar"
                  style={{ width: `${(r.total / max) * 100}%` }}
                  aria-hidden
                />
                <span className="billing-breakdown-name">{r.label}</span>
              </span>
              <span className="billing-breakdown-count">{r.count}</span>
              <span className="billing-breakdown-amount">{fmtILS(r.total)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
