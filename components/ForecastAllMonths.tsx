"use client";

import { useEffect, useRef, useState } from "react";

/**
 * /morning/forecast — "כל החודשים" pivot view.
 *
 * Rows = company → project; columns = calendar months in ascending
 * order, so in RTL they read as a right-to-left timeline (oldest
 * nearest the project name). Each cell shows the project's total
 * spend (בפועל) for that
 * month with the management fee (דמי ניהול) underneath. Clicking a
 * cell opens a popup with that month's per-channel breakdown — spend,
 * fee %, and fee in ₪.
 *
 * All breakdown data is embedded in props (server-aggregated from the
 * ALL CLIENTS "חודשי" rows), so a cell click is instant — no fetch.
 */

export type MatrixCellChannel = {
  channel: string;
  spend: number;
  feePercent: number;
  fee: number;
};
export type MatrixCell = {
  spend: number;
  fee: number;
  channels: MatrixCellChannel[];
};
export type MatrixProject = {
  projectName: string;
  slug: string;
  /** month (YYYY-MM) → cell. Months absent for a project simply have
   *  no key (rendered as an em-dash). */
  cells: Record<string, MatrixCell>;
};
export type MatrixCompany = {
  company: string;
  /** month → company subtotal (spend + fee). */
  totalsByMonth: Record<string, { spend: number; fee: number }>;
  projects: MatrixProject[];
};

type Props = {
  months: string[];
  companies: MatrixCompany[];
  /** month → portfolio total (spend + fee), for the foot row. */
  grand: Record<string, { spend: number; fee: number }>;
};

function fmtIls(n: number): string {
  return `₪${Math.round(n).toLocaleString("he-IL")}`;
}
function fmtPct(n: number): string {
  return `${Math.round(n * 10) / 10}%`;
}

type Selected = {
  projectName: string;
  month: string;
  cell: MatrixCell;
};

export default function ForecastAllMonths({ months, companies, grand }: Props) {
  const [sel, setSel] = useState<Selected | null>(null);
  // Collapsed-to-company by default: only company subtotal rows show;
  // expanding a company reveals its project rows. `expanded` holds the
  // open company names (empty = all collapsed).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const toggleCompany = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const allOpen = expanded.size === companies.length && companies.length > 0;
  const toggleAll = () =>
    setExpanded(allOpen ? new Set() : new Set(companies.map((c) => c.company)));

  // Esc closes the popup; focus the close button when it opens.
  useEffect(() => {
    if (!sel) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setSel(null);
      }
    }
    window.addEventListener("keydown", onKey);
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.removeEventListener("keydown", onKey);
  }, [sel]);

  return (
    <>
      <div className="forecast-matrix-toolbar">
        <button
          type="button"
          className="forecast-matrix-expand-all"
          onClick={toggleAll}
          aria-expanded={allOpen}
        >
          {allOpen ? "▸ כווץ הכל" : "▾ הרחב הכל"}
        </button>
      </div>
      <div className="forecast-table-wrap forecast-matrix-wrap">
        <table className="forecast-matrix" dir="rtl">
          <thead>
            <tr>
              <th className="forecast-matrix-corner">פרויקט</th>
              {months.map((m) => (
                <th key={m} className="forecast-matrix-month">
                  {m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {companies.map((co) => (
              <CompanyRows
                key={co.company}
                co={co}
                months={months}
                isOpen={expanded.has(co.company)}
                onToggle={toggleCompany}
                onPick={setSel}
              />
            ))}
          </tbody>
          <tfoot>
            <tr className="forecast-matrix-grand-row">
              <th className="forecast-matrix-corner">סך הכל</th>
              {months.map((m) => {
                const g = grand[m];
                return (
                  <td key={m} className="forecast-matrix-num">
                    {g ? (
                      <>
                        <span className="forecast-matrix-spend">{fmtIls(g.spend)}</span>
                        <span className="forecast-matrix-fee">
                          דמי ניהול {fmtIls(g.fee)}
                        </span>
                      </>
                    ) : (
                      <span className="forecast-matrix-empty">—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      {sel && (
        <div
          className="quick-note-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSel(null);
          }}
        >
          <div
            className="quick-note-dialog forecast-matrix-popup"
            role="dialog"
            aria-modal="true"
            aria-labelledby="forecast-matrix-popup-heading"
            dir="rtl"
          >
            <div className="quick-note-head">
              <h2 id="forecast-matrix-popup-heading">
                {sel.projectName}{" "}
                <span className="forecast-matrix-popup-month">· {sel.month}</span>
              </h2>
              <button
                ref={closeRef}
                type="button"
                className="quick-note-close"
                onClick={() => setSel(null)}
                aria-label="סגור"
                title="סגור (Esc)"
              >
                ✕
              </button>
            </div>

            {sel.cell.channels.length === 0 ? (
              <div className="forecast-matrix-popup-empty">
                אין נתוני ערוצים לחודש זה.
              </div>
            ) : (
              <table className="forecast-matrix-popup-table" dir="rtl">
                <thead>
                  <tr>
                    <th>ערוץ</th>
                    <th>בפועל</th>
                    <th>% ניהול</th>
                    <th>דמי ניהול</th>
                  </tr>
                </thead>
                <tbody>
                  {sel.cell.channels.map((c) => (
                    <tr key={c.channel}>
                      <td className="forecast-matrix-popup-channel" dir="auto">
                        {c.channel}
                      </td>
                      <td>{fmtIls(c.spend)}</td>
                      <td>{fmtPct(c.feePercent)}</td>
                      <td>{fmtIls(c.fee)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="forecast-matrix-popup-channel">סך הכל</td>
                    <td>{fmtIls(sel.cell.spend)}</td>
                    <td>—</td>
                    <td>{fmtIls(sel.cell.fee)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** One company block: a tinted, clickable header row that toggles its
 *  per-month subtotals open/closed. When open, a clickable cell row
 *  per project follows. Collapsed by default. */
function CompanyRows({
  co,
  months,
  isOpen,
  onToggle,
  onPick,
}: {
  co: MatrixCompany;
  months: string[];
  isOpen: boolean;
  onToggle: (name: string) => void;
  onPick: (s: Selected) => void;
}) {
  return (
    <>
      <tr className={`forecast-matrix-company-row${isOpen ? " is-open" : ""}`}>
        <th className="forecast-matrix-corner" dir="auto">
          <button
            type="button"
            className="forecast-matrix-company-toggle"
            onClick={() => onToggle(co.company)}
            aria-expanded={isOpen}
            title={isOpen ? "כווץ" : "הרחב פרויקטים"}
          >
            <span className="forecast-matrix-caret" aria-hidden>
              {isOpen ? "▾" : "▸"}
            </span>
            <span dir="auto">{co.company}</span>
            <span className="forecast-matrix-company-count">
              ({co.projects.length})
            </span>
          </button>
        </th>
        {months.map((m) => {
          const t = co.totalsByMonth[m];
          return (
            <td key={m} className="forecast-matrix-num">
              {t ? (
                <>
                  <span className="forecast-matrix-spend">{fmtIls(t.spend)}</span>
                  <span className="forecast-matrix-fee">דמי ניהול {fmtIls(t.fee)}</span>
                </>
              ) : (
                <span className="forecast-matrix-empty">—</span>
              )}
            </td>
          );
        })}
      </tr>
      {isOpen &&
        co.projects.map((p) => (
        <tr key={`${p.projectName}__${p.slug}`} className="forecast-matrix-project-row">
          <th className="forecast-matrix-corner forecast-matrix-project-name" dir="auto">
            {p.projectName}
          </th>
          {months.map((m) => {
            const cell = p.cells[m];
            if (!cell || cell.channels.length === 0) {
              return (
                <td key={m} className="forecast-matrix-num">
                  <span className="forecast-matrix-empty">—</span>
                </td>
              );
            }
            return (
              <td key={m} className="forecast-matrix-num">
                <button
                  type="button"
                  className="forecast-matrix-cell"
                  onClick={() => onPick({ projectName: p.projectName, month: m, cell })}
                  title={`פירוט ערוצים · ${p.projectName} · ${m}`}
                >
                  <span className="forecast-matrix-spend">{fmtIls(cell.spend)}</span>
                  <span className="forecast-matrix-fee">דמי ניהול {fmtIls(cell.fee)}</span>
                </button>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
