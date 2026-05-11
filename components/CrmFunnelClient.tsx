"use client";

import { useMemo, useState } from "react";
import type { CrmFunnel } from "@/lib/crmData";
import { channelIcon } from "@/lib/channelIcon";
import CrmFunnelTrendline from "./CrmFunnelTrendline";

/**
 * Master-filter client wrapper for the CRM funnel section. Owns the
 * source-chip selection state and re-aggregates every view (KPI tiles,
 * status funnel, objections × source matrix, objection pie, trendline)
 * from the raw `sourceMatrices` payload on every chip toggle.
 *
 * One filter → five reactive views, all reading consistently against
 * the same selected-source set. The shared source→color palette is
 * computed once across allSources so a given channel always reads the
 * same color across the whole section.
 *
 * Default state: every source selected. Empty selection is allowed and
 * cleanly degrades each view to its empty state.
 */

type StackedSource = { source: string; count: number; isOther?: boolean };

const PALETTE = [
  "#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9",
  "#8b5cf6", "#14b8a6", "#ef4444", "#a3a3a3", "#84cc16",
];

const TOP_STATUSES = 8;
const TOP_OBJECTIONS = 5;
const TOP_SOURCES_PER_ROW = 4;
const TOP_OBJECTIONS_IN_PIE = 6;

export default function CrmFunnelClient({ funnel }: { funnel: CrmFunnel }) {
  const sm = funnel.sourceMatrices;
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(sm.allSources),
  );

  const toggle = (source: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(sm.allSources));
  const clearAll = () => setSelected(new Set());

  // Stable source→color palette, computed once across ALL sources
  // (independent of chip state). Each source always reads the same
  // color across every view + the chip's own dot.
  const palette = useMemo(() => {
    const m = new Map<string, string>();
    sm.allSources.forEach((s, i) => m.set(s, PALETTE[i % PALETTE.length]));
    return m;
  }, [sm.allSources]);

  // Sum each row's source columns, restricted to selected. Used to
  // pick top-N and to compute the row's "filtered total" for layouts.
  // Returns the row's flat count plus its top-N source breakdown
  // with an "אחר" rest bucket so the stacked bar closes to 100%.
  const projectRow = (
    map: Record<string, number>,
    topN: number,
  ): { count: number; sources: StackedSource[] } => {
    let count = 0;
    const sorted: { source: string; count: number }[] = [];
    for (const [source, c] of Object.entries(map)) {
      if (!selected.has(source)) continue;
      count += c;
      sorted.push({ source, count: c });
    }
    sorted.sort((a, b) => b.count - a.count);
    const head = sorted.slice(0, topN);
    const tail = sorted.slice(topN).reduce((n, x) => n + x.count, 0);
    const sources: StackedSource[] = head;
    if (tail > 0) sources.push({ source: "אחר", count: tail, isOther: true });
    return { count, sources };
  };

  // ── KPI numbers under the chip filter ─────────────────────────────
  // Sum the per-source maps over the selected subset. With "all"
  // selected these match the project totals minus rows with no source
  // attribution (the lib's sourceMatrices only counts rows with a
  // `מקור הגעה` value).
  const kpis = useMemo(() => {
    const sum = (m: Record<string, number>) =>
      Object.entries(m).reduce(
        (n, [s, c]) => n + (selected.has(s) ? c : 0),
        0,
      );
    const leads = sum(sm.leadsBySource);
    const contacted = sum(sm.contactedBySource);
    const scheduled = sum(sm.scheduledMeetingsBySource);
    const meetings = sum(sm.meetingsBySource);
    return {
      leads,
      contacted,
      scheduledMeetings: scheduled,
      meetings,
      meetingRatePct: leads > 0 ? (meetings / leads) * 100 : null,
    };
  }, [selected, sm]);

  // ── Status funnel rows (filtered + top-N + funnel-ordered) ────────
  const statusRows = useMemo(() => {
    const candidates: { label: string; count: number; sources: StackedSource[] }[] = [];
    for (const status of sm.statusFunnelOrder) {
      const srcMap = sm.statusBySource[status] || {};
      const { count, sources } = projectRow(srcMap, TOP_SOURCES_PER_ROW);
      if (count === 0) continue;
      candidates.push({ label: status, count, sources });
    }
    // Pick top-N by filtered count, then re-sort by canonical funnel
    // order so the narrative reads top → bottom as a sales funnel.
    const order = new Map(sm.statusFunnelOrder.map((s, i) => [s, i]));
    const top = [...candidates]
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_STATUSES)
      .sort((a, b) => (order.get(a.label) ?? 999) - (order.get(b.label) ?? 999));
    // Cumulative counts from the end → narrowing funnel from top to bottom.
    const cumulative: number[] = new Array(top.length).fill(0);
    let acc = 0;
    for (let i = top.length - 1; i >= 0; i--) {
      acc += top[i].count;
      cumulative[i] = acc;
    }
    const maxCum = cumulative[0] || 1;
    return top.map((row, i) => ({
      ...row,
      cumulative: cumulative[i],
      widthPct: (cumulative[i] / maxCum) * 100,
    }));
  }, [selected, sm]);

  // ── Objections × source rows (filtered + top-N) ───────────────────
  const objectionRows = useMemo(() => {
    const candidates: { objection: string; total: number; sources: StackedSource[] }[] = [];
    for (const [objection, srcMap] of Object.entries(sm.objectionBySource)) {
      const { count, sources } = projectRow(srcMap, TOP_SOURCES_PER_ROW);
      if (count === 0 || sources.length === 0) continue;
      candidates.push({ objection, total: count, sources });
    }
    candidates.sort((a, b) => b.total - a.total);
    const top = candidates.slice(0, TOP_OBJECTIONS);
    const maxTotal = top[0]?.total || 1;
    return top.map((row) => ({
      ...row,
      widthPct: (row.total / maxTotal) * 100,
    }));
  }, [selected, sm]);

  // ── Objection pie (aggregate across selected sources × objection) ─
  const pieData = useMemo(() => {
    const byObj = new Map<string, number>();
    let grandTotal = 0;
    for (const [objection, srcMap] of Object.entries(sm.objectionBySource)) {
      for (const [source, c] of Object.entries(srcMap)) {
        if (!selected.has(source)) continue;
        byObj.set(objection, (byObj.get(objection) || 0) + c);
        grandTotal += c;
      }
    }
    const sorted = [...byObj.entries()].sort((a, b) => b[1] - a[1]);
    const head = sorted.slice(0, TOP_OBJECTIONS_IN_PIE);
    const tail = sorted.slice(TOP_OBJECTIONS_IN_PIE).reduce((n, [, c]) => n + c, 0);
    const slices: { label: string; count: number; isOther?: boolean; color: string }[] =
      head.map(([label, count], i) => ({ label, count, color: PALETTE[i % PALETTE.length] }));
    if (tail > 0) slices.push({ label: "אחר", count: tail, isOther: true, color: "#d1d5db" });
    return { slices, total: grandTotal };
  }, [selected, sm]);

  // ── Trendline daily series — filter dailyTimeSeries by chip ───────
  const trendDaily = useMemo(() => {
    return funnel.dailyTimeSeries.map((day) => ({
      date: day.date,
      bySource: day.bySource.filter((s) => selected.has(s.source)),
    }));
  }, [selected, funnel.dailyTimeSeries]);

  const noneSelected = selected.size === 0;

  // Pie SVG arcs — same conic-walk as the old CrmSourceAnalysis pie.
  const sliceArcs = useMemo(() => {
    if (pieData.total === 0) return [];
    const arcs: { d: string; fill: string; tooltip: string; label: string }[] = [];
    let cumFrac = 0;
    for (const s of pieData.slices) {
      const startFrac = cumFrac;
      cumFrac += s.count / pieData.total;
      const endFrac = cumFrac;
      if (endFrac - startFrac < 0.005) continue;
      const a0 = startFrac * 2 * Math.PI - Math.PI / 2;
      const a1 = endFrac * 2 * Math.PI - Math.PI / 2;
      const x0 = 50 + 50 * Math.cos(a0);
      const y0 = 50 + 50 * Math.sin(a0);
      const x1 = 50 + 50 * Math.cos(a1);
      const y1 = 50 + 50 * Math.sin(a1);
      const largeArc = endFrac - startFrac > 0.5 ? 1 : 0;
      const d = endFrac - startFrac >= 0.9999
        ? `M 50 0 A 50 50 0 1 1 49.999 0 Z`
        : `M 50 50 L ${x0.toFixed(3)} ${y0.toFixed(3)} A 50 50 0 ${largeArc} 1 ${x1.toFixed(3)} ${y1.toFixed(3)} Z`;
      const pct2 = ((s.count / pieData.total) * 100).toFixed(1);
      arcs.push({
        d, fill: s.color,
        tooltip: `${s.label} · ${s.count} (${pct2}%)`,
        label: s.label,
      });
    }
    return arcs;
  }, [pieData]);

  return (
    <section className="project-section project-section-crm" dir="rtl">
      <div className="section-head">
        <h2>
          📋 משפך CRM
          <span
            className="crm-platform-badge"
            title={`חשבון ב־${funnel.platform.toUpperCase()}: ${funnel.crmAccount}`}
          >
            {funnel.platform.toUpperCase()}
          </span>
        </h2>
        <div className="section-head-actions">
          {funnel.monthFilter ? (
            <span
              className="crm-filter-chip"
              title="חודש הסינון — מסונכרן עם בורר החודשים של המטריקות למעלה"
            >
              חודש: {funnel.monthFilter}
            </span>
          ) : null}
          <span className="crm-date-range" title="טווח התאריכים של הנתונים בקבוצה המסוננת">
            {funnel.dateRange.from} → {funnel.dateRange.to}
          </span>
        </div>
      </div>

      {/* Master source-chip filter — sits at the top of the section
          and drives every view below. Channel emoji on each chip ties
          it to the source's color across the funnel + objections + pie
          + trendline. */}
      <div className="crm-block crm-source-chips-block">
        <div className="crm-block-title">פילוח לפי מקור הגעה</div>
        <div className="crm-source-chips" role="group" aria-label="בחירת מקורות">
          <button
            type="button"
            className="crm-source-link"
            onClick={selectAll}
            disabled={selected.size === sm.allSources.length}
            title="בחר את כל המקורות"
          >
            הכל
          </button>
          <button
            type="button"
            className="crm-source-link"
            onClick={clearAll}
            disabled={selected.size === 0}
            title="נקה את הבחירה"
          >
            ניקוי
          </button>
          <span className="crm-source-chips-sep" aria-hidden="true">·</span>
          {sm.allSources.map((source) => {
            const isActive = selected.has(source);
            const icon = channelIcon(source);
            const total = sm.leadsBySource[source] || 0;
            return (
              <button
                key={source}
                type="button"
                aria-pressed={isActive}
                className={"crm-source-chip" + (isActive ? " is-active" : "")}
                onClick={() => toggle(source)}
                title={`${source} — ${total} לידים`}
              >
                <span
                  className="crm-source-chip-color"
                  style={{ background: palette.get(source) }}
                  aria-hidden="true"
                />
                {icon ? (
                  <span className="crm-source-chip-icon" aria-hidden="true">{icon}</span>
                ) : null}
                <span className="crm-source-chip-name">{source}</span>
                <span className="crm-source-chip-count">{total}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* KPI tiles — now reactive to the chip filter. The headline
          numbers reflect the selected-source subset; with "all"
          selected they match the project totals (modulo rows with no
          source attribution, which sit outside the chip taxonomy). */}
      <div className="crm-kpi-row">
        <KpiTile label="לידים" value={fmtInt(kpis.leads)} />
        <KpiTile label="נוצר קשר" value={fmtInt(kpis.contacted)} sub={pct(kpis.contacted, kpis.leads)} />
        <KpiTile label="תואמה פגישה" value={fmtInt(kpis.scheduledMeetings)} sub={pct(kpis.scheduledMeetings, kpis.leads)} />
        <KpiTile label="פגישות" value={fmtInt(kpis.meetings)} sub={pct(kpis.meetings, kpis.leads)} />
        <KpiTile label="יחס פגישה" value={kpis.meetingRatePct == null ? "—" : `${kpis.meetingRatePct.toFixed(1)}%`} />
      </div>

      {/* Status funnel + objections × source — 50/50 grid, both stacked
          bars share the source palette set above. */}
      {(statusRows.length > 0 || objectionRows.length > 0) && (
        <div className="crm-objection-grid">
          {statusRows.length > 0 && (
            <div className="crm-block">
              <div className="crm-block-title">משפך סטטוסים</div>
              <ul className="crm-matrix">
                {statusRows.map((row) => {
                  const cumPct = (row.cumulative / Math.max(1, kpis.leads) * 100).toFixed(1);
                  const tooltip =
                    `${row.label} — ${row.cumulative} (${cumPct}% מהלידים הגיעו לשלב הזה או מעבר)\n` +
                    `מתוכם ${row.count} (${pct(row.count, kpis.leads)}) נמצאים כעת בשלב הזה בדיוק`;
                  return (
                    <li key={row.label} className="crm-matrix-row" title={tooltip}>
                      <span className="crm-matrix-label" title={row.label}>{row.label}</span>
                      <span className="crm-matrix-bar" style={{ width: `${row.widthPct}%` }}>
                        {row.sources.map((s) => {
                          const w = (s.count / row.count) * 100;
                          if (w < 0.5) return null;
                          return (
                            <span
                              key={s.source}
                              className={"crm-matrix-seg" + (s.isOther ? " crm-matrix-seg-rest" : "")}
                              style={s.isOther
                                ? { width: `${w}%` }
                                : { width: `${w}%`, background: palette.get(s.source) }}
                              title={`${channelIcon(s.source)} ${s.source} — ${s.count} (${pct(s.count, row.count)})`.trim()}
                            />
                          );
                        })}
                      </span>
                      <span className="crm-matrix-total">{row.cumulative}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {objectionRows.length > 0 && (
            <div className="crm-block">
              <div className="crm-block-title">התנגדויות לפי מקור הגעה</div>
              <ul className="crm-matrix">
                {objectionRows.map((row) => (
                  <li key={row.objection} className="crm-matrix-row">
                    <span className="crm-matrix-label" title={row.objection}>{row.objection}</span>
                    <span className="crm-matrix-bar" style={{ width: `${row.widthPct}%` }}>
                      {row.sources.map((s) => {
                        const w = (s.count / row.total) * 100;
                        if (w < 0.5) return null;
                        return (
                          <span
                            key={s.source}
                            className={"crm-matrix-seg" + (s.isOther ? " crm-matrix-seg-rest" : "")}
                            style={s.isOther
                              ? { width: `${w}%` }
                              : { width: `${w}%`, background: palette.get(s.source) }}
                            title={`${channelIcon(s.source)} ${s.source} — ${s.count} (${pct(s.count, row.total)})`.trim()}
                          />
                        );
                      })}
                    </span>
                    <span className="crm-matrix-total">{row.total}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Objection pie + trendline — 35/65 grid, also driven by chips. */}
      {(pieData.slices.length > 0 || trendDaily.length > 0) && (
        <div className="crm-source-analysis-grid">
          <div className="crm-block crm-pie-block">
            <div className="crm-block-title">התפלגות התנגדויות</div>
            <div className="crm-pie-row">
              <div
                className={"crm-pie" + (noneSelected || pieData.total === 0 ? " crm-pie-empty" : "")}
                aria-label={
                  noneSelected
                    ? "לא נבחר מקור"
                    : `התפלגות התנגדויות עבור ${selected.size} מקורות נבחרים`
                }
              >
                {noneSelected || pieData.total === 0 ? (
                  <span className="crm-pie-empty-label">
                    {noneSelected ? "בחר מקור" : "אין התנגדויות"}
                  </span>
                ) : (
                  <svg viewBox="0 0 100 100" className="crm-pie-svg" role="img" aria-hidden="true">
                    {sliceArcs.map((slice) => (
                      <path key={slice.label} d={slice.d} fill={slice.fill}>
                        <title>{slice.tooltip}</title>
                      </path>
                    ))}
                  </svg>
                )}
              </div>
              <ul className="crm-pie-legend">
                {pieData.slices.length === 0 ? (
                  <li className="crm-pie-legend-empty">אין התנגדויות בקבוצה הנבחרת.</li>
                ) : (
                  pieData.slices.map((s) => (
                    <li key={s.label}>
                      <span
                        className={"crm-legend-dot" + (s.isOther ? " crm-legend-dot-rest" : "")}
                        style={s.isOther ? undefined : { background: s.color }}
                      />
                      <span className="crm-legend-label" title={s.label}>{s.label}</span>
                      <span className="crm-legend-count">
                        {s.count} ({((s.count / pieData.total) * 100).toFixed(1)}%)
                      </span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>

          <CrmFunnelTrendline
            dailyTimeSeries={trendDaily}
            selectedSources={selected}
          />
        </div>
      )}

      {/* Sellers — BMBY-only. Inline summary form. */}
      {funnel.topSellers.length > 0 && (
        <div className="crm-block crm-block-inline">
          <span className="crm-block-title">אנשי מכירות</span>
          <span className="crm-inline-list">
            {funnel.topSellers.map((s, i) => (
              <span key={s.label} className="crm-inline-item">
                {i > 0 && " · "}
                {s.label} ({s.count})
              </span>
            ))}
          </span>
        </div>
      )}
    </section>
  );
}

function KpiTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="crm-kpi-tile">
      <div className="crm-kpi-value">{value}</div>
      <div className="crm-kpi-label">{label}</div>
      {sub ? <div className="crm-kpi-sub">{sub}</div> : null}
    </div>
  );
}

function fmtInt(n: number): string {
  return n.toLocaleString("he-IL");
}
function pct(part: number, whole: number): string {
  if (!whole) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}
