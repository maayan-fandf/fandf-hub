"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  // Which pie slice is currently hovered — drives the channel-breakdown
  // tooltip rendered below the pie. The SVG <path> elements can't host
  // HTML tooltips directly, and the parent `.crm-pie` clips its
  // children via `overflow: hidden`, so we track hover state in React
  // and render a separate tooltip as a sibling of the pie.
  const [hoveredSlice, setHoveredSlice] = useState<string | null>(null);

  // Substring-match source filter — supplements the exact-match chip
  // filter for capturing multi-channel rows. Example: when the CRM
  // records a lead's `מקור הגעה` as "facebook, yad2", that's its own
  // distinct source bucket and clicking the "facebook" chip won't
  // include it. Adding "facebook" as a substring term here matches
  // any source whose text contains "facebook" — clean single-action
  // way to grab all multi-channel-attributed leads. Combines with
  // chips via AND: a source must pass both to contribute.
  const [substringTerms, setSubstringTerms] = useState<Set<string>>(() => new Set());
  const [searchPopoverOpen, setSearchPopoverOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const searchPopoverRef = useRef<HTMLDivElement | null>(null);
  // Close the search popover on outside click — same UX as the
  // dashboard's chart-side multi-selects.
  useEffect(() => {
    if (!searchPopoverOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t || !searchPopoverRef.current) return;
      if (!searchPopoverRef.current.contains(t)) setSearchPopoverOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [searchPopoverOpen]);

  const addSubstringTerm = (term: string) => {
    const t = term.trim();
    if (!t) return;
    setSubstringTerms((prev) => {
      const next = new Set(prev);
      next.add(t);
      return next;
    });
    setSearchInput("");
  };
  const removeSubstringTerm = (term: string) => {
    setSubstringTerms((prev) => {
      const next = new Set(prev);
      next.delete(term);
      return next;
    });
  };
  const clearSubstringTerms = () => setSubstringTerms(new Set());

  // Combined source predicate — every aggregation uses this so the
  // chip filter AND the substring filter narrow the data consistently.
  // When no substring terms are set, falls through to chip-only
  // behavior (the original semantics).
  const sourcePasses = useMemo(() => {
    const termsLc = [...substringTerms].map((t) => t.toLowerCase());
    return (source: string): boolean => {
      if (!selected.has(source)) return false;
      if (termsLc.length === 0) return true;
      const lc = source.toLowerCase();
      return termsLc.some((t) => lc.includes(t));
    };
  }, [selected, substringTerms]);

  // For the popover's source list: filter sm.allSources by what's
  // typed in the search input (substring match, case-insensitive).
  // Always shows the full list when the input is empty.
  const searchListSources = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    if (!q) return sm.allSources;
    return sm.allSources.filter((s) => s.toLowerCase().includes(q));
  }, [sm.allSources, searchInput]);

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
      if (!sourcePasses(source)) continue;
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
  //
  // Also returns the per-KPI source breakdown (sorted desc) so the
  // hover popovers on each tile can render a mini-pie + legend
  // showing which channels contributed.
  const kpis = useMemo(() => {
    const breakdown = (m: Record<string, number>) => {
      const rows: { source: string; count: number }[] = [];
      for (const [s, c] of Object.entries(m)) {
        if (!sourcePasses(s) || c === 0) continue;
        rows.push({ source: s, count: c });
      }
      rows.sort((a, b) => b.count - a.count);
      return rows;
    };
    const leadsBreakdown = breakdown(sm.leadsBySource);
    const contactedBreakdown = breakdown(sm.contactedBySource);
    const scheduledBreakdown = breakdown(sm.scheduledMeetingsBySource);
    const meetingsBreakdown = breakdown(sm.meetingsBySource);
    const sumOf = (rows: { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);
    const leads = sumOf(leadsBreakdown);
    const contacted = sumOf(contactedBreakdown);
    const scheduled = sumOf(scheduledBreakdown);
    const meetings = sumOf(meetingsBreakdown);
    return {
      leads,
      contacted,
      scheduledMeetings: scheduled,
      meetings,
      meetingRatePct: leads > 0 ? (meetings / leads) * 100 : null,
      breakdowns: {
        leads: leadsBreakdown,
        contacted: contactedBreakdown,
        scheduledMeetings: scheduledBreakdown,
        meetings: meetingsBreakdown,
      },
    };
  }, [sourcePasses, sm]);

  // ── Per-objection source breakdown for pie-legend hover popovers ──
  // Mirrors the KPI breakdowns shape — for each objection currently
  // visible in the pie, what's the chip-filtered source mix?
  const objectionSourceBreakdowns = useMemo(() => {
    const out = new Map<string, { source: string; count: number }[]>();
    for (const [objection, srcMap] of Object.entries(sm.objectionBySource)) {
      const rows: { source: string; count: number }[] = [];
      for (const [source, c] of Object.entries(srcMap)) {
        if (!sourcePasses(source) || c === 0) continue;
        rows.push({ source, count: c });
      }
      rows.sort((a, b) => b.count - a.count);
      if (rows.length > 0) out.set(objection, rows);
    }
    return out;
  }, [sourcePasses, sm]);

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
  }, [sourcePasses, sm]);

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
  }, [sourcePasses, sm]);

  // ── Objection pie (aggregate across selected sources × objection) ─
  const pieData = useMemo(() => {
    const byObj = new Map<string, number>();
    let grandTotal = 0;
    for (const [objection, srcMap] of Object.entries(sm.objectionBySource)) {
      for (const [source, c] of Object.entries(srcMap)) {
        if (!sourcePasses(source)) continue;
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
  }, [sourcePasses, sm]);

  // ── Trendline daily series — filter dailyTimeSeries by chip + substring ─
  const trendDaily = useMemo(() => {
    return funnel.dailyTimeSeries.map((day) => ({
      date: day.date,
      bySource: day.bySource.filter((s) => sourcePasses(s.source)),
    }));
  }, [sourcePasses, funnel.dailyTimeSeries]);

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
          {/* Substring filter — a separate filter level from the
              chip selection, for catching multi-channel rows where
              the source field is a composite like "facebook, yad2".
              Click → popover with a search input + a list of all
              sources (filterable) + the active-terms pills inside.
              Visually placed between ניקוי and the · separator;
              effectively pinned at the start of the chip row in
              RTL order. */}
          <div className="crm-source-search-wrap" ref={searchPopoverRef}>
            <button
              type="button"
              className={
                "crm-source-search-btn" +
                (substringTerms.size > 0 ? " has-terms" : "") +
                (searchPopoverOpen ? " is-open" : "")
              }
              onClick={() => setSearchPopoverOpen((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={searchPopoverOpen}
              title="חיפוש לפי טקסט במקור — תופס מקורות מרובי-ערוצים"
            >
              <span aria-hidden="true">🔍</span>
              <span className="crm-source-search-btn-label">חיפוש</span>
              {substringTerms.size > 0 ? (
                <span className="crm-source-search-btn-count">{substringTerms.size}</span>
              ) : null}
            </button>
            {searchPopoverOpen && (
              <div className="crm-source-search-popover" role="dialog">
                <input
                  type="text"
                  className="crm-source-search-input"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="חפש או הקלד טקסט לסינון…"
                  // Pressing Enter on a non-empty input adds it as a
                  // substring term — fast path when the typed text
                  // doesn't match any existing source exactly (e.g.
                  // "facebook" when only "facebook, yad2" composites
                  // exist in the data).
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && searchInput.trim()) {
                      e.preventDefault();
                      addSubstringTerm(searchInput);
                    }
                  }}
                  autoFocus
                />
                {substringTerms.size > 0 && (
                  <div className="crm-source-search-terms">
                    {[...substringTerms].map((t) => (
                      <button
                        key={t}
                        type="button"
                        className="crm-source-search-term"
                        onClick={() => removeSubstringTerm(t)}
                        title="הסר מסנן"
                      >
                        <span>{t}</span>
                        <span aria-hidden="true">×</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      className="crm-source-search-clear"
                      onClick={clearSubstringTerms}
                      title="נקה את כל המסננים"
                    >
                      נקה
                    </button>
                  </div>
                )}
                {searchInput.trim() && (
                  <button
                    type="button"
                    className="crm-source-search-add"
                    onClick={() => addSubstringTerm(searchInput)}
                  >
                    + הוסף &quot;{searchInput.trim()}&quot; כמסנן טקסט
                  </button>
                )}
                <ul className="crm-source-search-list">
                  {searchListSources.length === 0 ? (
                    <li className="crm-source-search-empty">אין התאמות.</li>
                  ) : (
                    searchListSources.map((source) => {
                      const icon = channelIcon(source);
                      const total = sm.leadsBySource[source] || 0;
                      const isTerm = substringTerms.has(source);
                      return (
                        <li key={source}>
                          <button
                            type="button"
                            className={
                              "crm-source-search-row" +
                              (isTerm ? " is-active" : "")
                            }
                            onClick={() =>
                              isTerm
                                ? removeSubstringTerm(source)
                                : addSubstringTerm(source)
                            }
                          >
                            <span
                              className="crm-source-chip-color"
                              style={{ background: palette.get(source) }}
                              aria-hidden="true"
                            />
                            {icon ? <span aria-hidden="true">{icon}</span> : null}
                            <span className="crm-source-search-row-name">{source}</span>
                            <span className="crm-source-search-row-count">{total}</span>
                          </button>
                        </li>
                      );
                    })
                  )}
                </ul>
              </div>
            )}
          </div>
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
        <KpiTile label="לידים"
          value={fmtInt(kpis.leads)}
          breakdown={kpis.breakdowns.leads}
          palette={palette} />
        <KpiTile label="נוצר קשר"
          value={fmtInt(kpis.contacted)}
          sub={pct(kpis.contacted, kpis.leads)}
          breakdown={kpis.breakdowns.contacted}
          palette={palette} />
        <KpiTile label="תואמה פגישה"
          value={fmtInt(kpis.scheduledMeetings)}
          sub={pct(kpis.scheduledMeetings, kpis.leads)}
          breakdown={kpis.breakdowns.scheduledMeetings}
          palette={palette} />
        <KpiTile label="פגישות"
          value={fmtInt(kpis.meetings)}
          sub={pct(kpis.meetings, kpis.leads)}
          breakdown={kpis.breakdowns.meetings}
          palette={palette} />
        <KpiTile label="יחס פגישה"
          value={kpis.meetingRatePct == null ? "—" : `${kpis.meetingRatePct.toFixed(1)}%`} />
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
                      <path
                        key={slice.label}
                        d={slice.d}
                        fill={slice.fill}
                        onMouseEnter={() => setHoveredSlice(slice.label)}
                        onMouseLeave={() => setHoveredSlice(null)}
                        onFocus={() => setHoveredSlice(slice.label)}
                        onBlur={() => setHoveredSlice(null)}
                      >
                        <title>{slice.tooltip}</title>
                      </path>
                    ))}
                  </svg>
                )}
              </div>
              {/* Pie-slice hover tooltip — appears below the pie when a
                  slice is hovered. Mirrors the legend-row tooltip in
                  content + styling, but rendered as a controlled child
                  here because <path> elements can't host HTML
                  tooltips natively. "אחר" slices roll up multiple
                  objections so a per-channel breakdown isn't
                  meaningful — skip the tooltip for that slice. */}
              {(() => {
                if (!hoveredSlice) return null;
                const slice = pieData.slices.find((s) => s.label === hoveredSlice);
                if (!slice || slice.isOther) return null;
                const breakdown = objectionSourceBreakdowns.get(hoveredSlice);
                if (!breakdown || breakdown.length === 0) return null;
                return (
                  <ChannelMiniPie
                    data={breakdown}
                    palette={palette}
                    metric={hoveredSlice}
                    visible
                  />
                );
              })()}
              <ul className="crm-pie-legend">
                {pieData.slices.length === 0 ? (
                  <li className="crm-pie-legend-empty">אין התנגדויות בקבוצה הנבחרת.</li>
                ) : (
                  pieData.slices.map((s) => {
                    // For non-"אחר" slices, look up the per-objection
                    // source breakdown so the hover popover can show
                    // which channels contributed to this objection.
                    // "אחר" rolls multiple objections together so a
                    // per-source breakdown isn't meaningful; skip the
                    // popover there.
                    const breakdown = s.isOther
                      ? null
                      : objectionSourceBreakdowns.get(s.label) || null;
                    const hasPopover = !!breakdown && breakdown.length > 0;
                    return (
                      <li
                        key={s.label}
                        className={hasPopover ? "crm-pie-legend-row crm-pie-legend-row-has-popover" : "crm-pie-legend-row"}
                      >
                        <span
                          className={"crm-legend-dot" + (s.isOther ? " crm-legend-dot-rest" : "")}
                          style={s.isOther ? undefined : { background: s.color }}
                        />
                        <span className="crm-legend-label" title={s.label}>{s.label}</span>
                        <span className="crm-legend-count">
                          {s.count} ({((s.count / pieData.total) * 100).toFixed(1)}%)
                        </span>
                        {hasPopover ? (
                          <ChannelMiniPie
                            data={breakdown!}
                            palette={palette}
                            metric={s.label}
                          />
                        ) : null}
                      </li>
                    );
                  })
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

function KpiTile({
  label,
  value,
  sub,
  breakdown,
  palette,
}: {
  label: string;
  value: string;
  sub?: string;
  /** Per-source breakdown for this metric under the current chip
   *  selection. When present (and non-empty), the tile gets a hover
   *  popover with a mini-pie of which channels contributed. */
  breakdown?: { source: string; count: number }[];
  palette?: Map<string, string>;
}) {
  const hasPopover = !!breakdown && breakdown.length > 0 && !!palette;
  return (
    <div className={"crm-kpi-tile" + (hasPopover ? " crm-kpi-tile-has-popover" : "")}>
      <div className="crm-kpi-value">{value}</div>
      <div className="crm-kpi-label">{label}</div>
      {sub ? <div className="crm-kpi-sub">{sub}</div> : null}
      {hasPopover ? (
        <ChannelMiniPie data={breakdown!} palette={palette!} metric={label} />
      ) : null}
    </div>
  );
}

/**
 * Hover popover — a conic-gradient mini-pie plus a tabular legend
 * showing how a metric or objection breaks down across the section's
 * channels under the current chip selection. Pure CSS reveal (parent
 * carries `*-has-popover`; this component renders unconditionally and
 * the CSS hides it until hover/focus-within). Shared palette + channel
 * emojis match the rest of the section.
 *
 * `data` is expected to be sorted desc; we don't re-sort here so the
 * legend order matches whatever the caller chose (top-channel first
 * for KPIs; for objections, that's also top-channel first).
 */
function ChannelMiniPie({
  data,
  palette,
  metric,
  visible = false,
}: {
  data: { source: string; count: number }[];
  palette: Map<string, string>;
  metric: string;
  /** When true, the tooltip is always visible (used for the SVG-pie-
   *  slice hover case where the parent can't carry a `*-has-popover`
   *  CSS class). When false / omitted, visibility is driven by the
   *  parent's `:hover` via CSS — the default for KPI tiles + legend
   *  rows. */
  visible?: boolean;
}) {
  const total = data.reduce((n, s) => n + s.count, 0);
  if (total === 0) return null;
  // Build conic-gradient stops in the legend's natural order so the
  // pie's colors visually align with the rows below.
  let cum = 0;
  const stops: string[] = [];
  for (const s of data) {
    if (s.count === 0) continue;
    const start = (cum / total) * 360;
    cum += s.count;
    const end = (cum / total) * 360;
    if (end - start < 1.8) continue; // < 0.5% — skip invisible slice
    const fill = palette.get(s.source) || "#cbd5e1";
    stops.push(`${fill} ${start.toFixed(3)}deg ${end.toFixed(3)}deg`);
  }
  const pieStyle = stops.length
    ? { background: `conic-gradient(${stops.join(", ")})` }
    : { background: "#f3f4f6" };
  return (
    <div
      className={"crm-channel-tooltip" + (visible ? " is-visible" : "")}
      role="tooltip"
    >
      <div className="crm-channel-tooltip-title">{metric} — לפי מקור הגעה</div>
      <div className="crm-channel-tooltip-body">
        <div className="crm-channel-tooltip-pie" style={pieStyle} />
        <ul className="crm-channel-tooltip-legend">
          {data.map((s) => {
            if (s.count === 0) return null;
            const icon = channelIcon(s.source);
            const pctText = ((s.count / total) * 100).toFixed(1);
            return (
              <li key={s.source}>
                <span
                  className="crm-channel-tooltip-dot"
                  style={{ background: palette.get(s.source) || "#cbd5e1" }}
                />
                {icon ? <span className="crm-channel-tooltip-icon" aria-hidden>{icon}</span> : null}
                <span className="crm-channel-tooltip-name" title={s.source}>{s.source}</span>
                <span className="crm-channel-tooltip-count">
                  {s.count} ({pctText}%)
                </span>
              </li>
            );
          })}
        </ul>
      </div>
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
