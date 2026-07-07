"use client";

import { useMemo, useState } from "react";
import { useFlipReorder } from "@/components/anim/useFlipReorder";
import type { PortfolioBenchmarks } from "@/lib/portfolioBenchmarks";
import {
  computeProjectRows,
  METRIC_LABELS,
  type Metric,
  type ProjectRow,
} from "@/lib/statsInsights";

/**
 * Consolidated project comparison table — one sortable table that
 * answers what the old Top/Bottom-10 rankings, consistency leaderboard
 * and outlier list answered in three separate sections:
 *
 *   ערך נוכחי       where does the project stand right now
 *   Δ מול עצמו      is that normal FOR THIS PROJECT (vs own median)
 *   אחוזון          where does it sit inside the book (0 = הזול ביותר)
 *   תנודתיות (CV)   is it a steady producer or a rollercoaster
 *   סטטוס           z-score flag vs the portfolio distribution
 *   מגמה            8-month sparkline of its monthly values
 *
 * Click a header to sort (second click flips direction), type to
 * filter, click a row to open the project drill-down. Rows FLIP-slide
 * to their new position on re-sort (useFlipReorder).
 */

type SortKey =
  | "project"
  | "current"
  | "deltaVsOwnPct"
  | "percentile"
  | "cv"
  | "months";

const fmtIls = (n: number) => "₪" + Math.round(n).toLocaleString("he-IL");

const STATUS_META: Record<
  ProjectRow["status"],
  { label: string; cls: string }
> = {
  "outlier-high": { label: "חריג", cls: "is-bad" },
  "borderline-high": { label: "גבולי", cls: "is-warn" },
  ok: { label: "תקין", cls: "is-ok" },
  efficient: { label: "מצטיין", cls: "is-good" },
};

function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return <span className="ptable-nospark">—</span>;
  const w = 84;
  const h = 22;
  const pad = 3;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = (w - pad * 2) / (points.length - 1);
  const xy = points.map((v, i) => [
    pad + i * step,
    h - pad - ((v - min) / span) * (h - pad * 2),
  ]);
  const d = xy
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden>
      <path
        d={d}
        fill="none"
        stroke="var(--muted)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.6"
      />
      <circle
        cx={lx}
        cy={ly}
        r="2.5"
        fill="var(--brand)"
        stroke="var(--surface)"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export default function StatsProjectTable({
  benchmarks,
  metric,
  onSelectProject,
}: {
  benchmarks: PortfolioBenchmarks;
  metric: Metric;
  onSelectProject: (project: string) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("current");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [query, setQuery] = useState("");

  const rows = useMemo(
    () => computeProjectRows(benchmarks, metric),
    [benchmarks, metric],
  );

  const visible = useMemo(() => {
    const q = query.trim();
    const filtered = q
      ? rows.filter((r) => r.project.includes(q))
      : rows.slice();
    const dir = sortDir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      if (sortKey === "project")
        return a.project.localeCompare(b.project, "he") * dir;
      const av = a[sortKey];
      const bv = b[sortKey];
      // null sorts to the bottom in either direction.
      if (av == null && bv == null)
        return a.project.localeCompare(b.project, "he");
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
    return filtered;
  }, [rows, query, sortKey, sortDir]);

  const flipRef = useFlipReorder<HTMLTableSectionElement>(
    `${metric}|${sortKey}|${sortDir}|${query}`,
  );

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Fresh column: numbers open at "big first", names alphabetical.
      setSortDir(key === "project" ? "asc" : "desc");
    }
  };

  const Th = ({
    label,
    k,
    title,
  }: {
    label: string;
    k: SortKey;
    title?: string;
  }) => (
    <th
      className={"ptable-th" + (sortKey === k ? " is-sorted" : "")}
      onClick={() => toggleSort(k)}
      title={title}
      role="columnheader"
      aria-sort={
        sortKey === k ? (sortDir === "asc" ? "ascending" : "descending") : "none"
      }
    >
      {label}
      <span className="ptable-sort-mark" aria-hidden>
        {sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : "⇅"}
      </span>
    </th>
  );

  const withCurrent = rows.filter((r) => r.current != null).length;

  return (
    <section className="stats-section">
      <div className="stats-section-head">
        <h2 style={{ margin: 0 }}>📋 השוואת פרויקטים — {METRIC_LABELS[metric]}</h2>
        <input
          type="search"
          className="ptable-search"
          placeholder="סינון לפי שם…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="סינון פרויקטים"
        />
      </div>
      <div className="stats-rank-note ptable-note">
        {withCurrent} פרויקטים עם נתונים בתקופה הנוכחית · לחיצה על כותרת
        ממיינת · לחיצה על שורה פותחת את הפרויקט
      </div>
      <div className="ptable-scroll">
        <table className="ptable">
          <thead>
            <tr>
              <Th label="פרויקט" k="project" />
              <Th
                label="ערך נוכחי"
                k="current"
                title="הערך בתקופת הקמפיין הנוכחית"
              />
              <Th
                label="Δ מול עצמו"
                k="deltaVsOwnPct"
                title="הערך הנוכחי מול החציון החודשי ההיסטורי של אותו פרויקט"
              />
              <Th
                label="אחוזון בתיק"
                k="percentile"
                title="0 = הזול בתיק, 100 = היקר בתיק"
              />
              <Th
                label="תנודתיות"
                k="cv"
                title="סטיית תקן חודשית ביחס לממוצע (CV) — כמה הפרויקט קופץ בין חודשים"
              />
              <Th label="חודשים" k="months" title="כמה חודשי נתונים יש" />
              <th className="ptable-th is-static">מגמה</th>
              <th className="ptable-th is-static">סטטוס</th>
            </tr>
          </thead>
          <tbody ref={flipRef}>
            {visible.map((r) => {
              const status = STATUS_META[r.status];
              const deltaCls =
                r.deltaVsOwnPct == null
                  ? "is-flat"
                  : r.deltaVsOwnPct > 10
                    ? "is-bad"
                    : r.deltaVsOwnPct < -10
                      ? "is-good"
                      : "is-flat";
              return (
                <tr
                  key={r.project}
                  data-flip={r.project}
                  onClick={() => onSelectProject(r.project)}
                  tabIndex={0}
                  role="button"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSelectProject(r.project);
                  }}
                  title={`פתח את ${r.project}`}
                >
                  <td className="ptable-project">{r.project}</td>
                  <td className="ptable-num">
                    {r.current == null ? "—" : fmtIls(r.current)}
                  </td>
                  <td className={`ptable-num ptable-delta ${deltaCls}`}>
                    {r.deltaVsOwnPct == null
                      ? "—"
                      : (r.deltaVsOwnPct > 0 ? "+" : "−") +
                        Math.abs(r.deltaVsOwnPct).toFixed(0) +
                        "%"}
                  </td>
                  <td className="ptable-num">
                    {r.percentile == null ? "—" : `P${r.percentile}`}
                  </td>
                  <td className="ptable-num">
                    {r.cv == null ? "—" : (r.cv * 100).toFixed(0) + "%"}
                  </td>
                  <td className="ptable-num">{r.months}</td>
                  <td className="ptable-spark">
                    <Spark points={r.spark} />
                  </td>
                  <td>
                    <span className={`ptable-status ${status.cls}`}>
                      {status.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div className="stats-empty">אין פרויקטים תואמים לסינון.</div>
        )}
      </div>
    </section>
  );
}
