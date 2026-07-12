"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CrmSourceFilterContext } from "./CrmSourceFilterContext";
import type { CrmFunnel } from "@/lib/crmData";
import { channelIcon } from "@/lib/channelIcon";
import { costMetricColor } from "@/lib/budgetShiftSuggestions";
import CrmFunnelTrendline from "./CrmFunnelTrendline";
import CountUp from "./anim/CountUp";
import StaggerReveal from "./anim/StaggerReveal";
import { useFlipReorder } from "./anim/useFlipReorder";
import { animate } from "animejs";
import { prefersReducedMotion } from "@/lib/anim";

/** "YYYY-MM-DD" → "DD/MM" for the compact data-freshness note. */
function ddmm(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}` : iso;
}

/**
 * Hover-anchored popover that renders into document.body via portal,
 * so it escapes every ancestor stacking context (CSS-only z-index
 * couldn't reliably beat the next section's stacked bars — Maayan
 * reported repeatedly that the bars painted over the popover's
 * lower half). Position is computed from the trigger's bounding
 * rect on mouseenter/focus, and re-cleared on mouseleave/blur with
 * a small delay so the user can cross the 6px gap from trigger to
 * popover without the card snapping shut.
 */
function useHoverPopover<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearHide() {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }
  function show() {
    clearHide();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      top: rect.bottom + 6,
      left: rect.left + rect.width / 2,
    });
    setOpen(true);
  }
  function scheduleHide() {
    clearHide();
    hideTimer.current = setTimeout(() => setOpen(false), 80);
  }
  useEffect(() => () => clearHide(), []);

  const triggerProps = {
    ref: ref as React.RefObject<T>,
    onMouseEnter: show,
    onMouseLeave: scheduleHide,
    onFocus: show,
    onBlur: scheduleHide,
  };
  const popoverProps = {
    onMouseEnter: clearHide,
    onMouseLeave: scheduleHide,
  };
  return { open, pos, triggerProps, popoverProps };
}

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

// Media-channel colors — large + well-separated so channels don't recycle
// the same hue. (Was a 10-color palette → the 11th channel collided with
// the 1st, and objections reused these same colors. A project here can
// have ~13+ sources.)
const CHANNEL_PALETTE = [
  "#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9",
  "#8b5cf6", "#14b8a6", "#ef4444", "#84cc16", "#f97316",
  "#06b6d4", "#d946ef", "#22c55e", "#eab308", "#3b82f6",
  "#fb7185", "#a855f7", "#0d9488", "#65a30d", "#e11d48",
];
// Objection colors — a SEPARATE set sharing no hex with CHANNEL_PALETTE,
// so an objection slice/dot never reads the same color as a media channel
// (deeper jewel tones read as their own family vs the brighter channels).
const OBJECTION_PALETTE = [
  "#9333ea", "#0891b2", "#ca8a04", "#be123c", "#15803d",
  "#b45309", "#1d4ed8", "#a21caf",
];

const TOP_STATUSES = 8;
const TOP_OBJECTIONS = 5;
const TOP_SOURCES_PER_ROW = 4;
const TOP_OBJECTIONS_IN_PIE = 6;

export default function CrmFunnelClient({
  funnel,
  view = "full",
}: {
  funnel: CrmFunnel;
  /** Which slice of the card to show. "full" (default) = everything;
   *  "funnel" = KPIs / cost / status / trendline / sellers (the CRM rail
   *  section); "analysis" = objection distribution + journey collapsibles
   *  (the התנגדויות rail section); "campaigns" = ONLY the Facebook/Meta UTM
   *  breakdown (rendered in the קמפיינים section). Splitting lets one funnel
   *  feed multiple rail sections; hiding is CSS-only (crm-view-*) so the
   *  shared source-chip filter keeps driving them. */
  view?: "full" | "funnel" | "analysis" | "campaigns";
}) {
  const sm = funnel.sourceMatrices;
  // Source-chip selection. When a CrmSourceFilterProvider is above us (the
  // native rail — CRM + התנגדויות sections), we share ONE selection through
  // it so filtering either section filters both. Otherwise (classic full
  // card, /morning) it's local to this instance. The context value is a
  // useState tuple, so the functional setSelected handlers below work either
  // way.
  const shared = useContext(CrmSourceFilterContext);
  const localState = useState<Set<string>>(() => new Set(sm.allSources));
  const [selected, setSelected] = shared ?? localState;
  // Reset the chip selection whenever the funnel's source set changes —
  // a month-rewind or a project→project navigation reuses THIS component
  // instance (same `[project]` route), so `selected` would otherwise keep
  // the PREVIOUS view's sources. Since every KPI re-aggregates the new
  // `leadsBySource` filtered by `selected`, a stale/disjoint set makes
  // all KPIs read 0 while the chips (rendered straight from the new
  // allSources) still show counts. React "adjust state during render"
  // pattern → no extra render pass, no flash of wrong numbers. When sharing,
  // prevSig starts "" so the very first render seeds the (empty-initialised)
  // shared set to allSources.
  const srcSig = sm.allSources.join("|");
  const [prevSrcSig, setPrevSrcSig] = useState(() => (shared ? "" : srcSig));
  if (srcSig !== prevSrcSig) {
    setPrevSrcSig(srcSig);
    setSelected(new Set(sm.allSources));
  }
  // Which pie slice is currently hovered — drives the channel-breakdown
  // tooltip rendered below the pie. The SVG <path> elements can't host
  // HTML tooltips directly, and the parent `.crm-pie` clips its
  // children via `overflow: hidden`, so we track hover state in React
  // and render a separate tooltip as a sibling of the pie.
  const [hoveredSlice, setHoveredSlice] = useState<string | null>(null);

  // Search-driven multi-select popover — an alternate UI for managing
  // the same `selected` set the chip row controls. Useful for grabbing
  // multi-channel composite sources (e.g. "facebook, yad2") in one
  // action: type "face" → list filters to face-containing sources →
  // "סמן את כל ההתאמות" → all those source names enter `selected`.
  // No separate substring-terms state — the popover and the chip row
  // share the same selection so the filter is always one source of
  // truth.
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

  // For the popover's source list: filter sm.allSources by what's
  // typed in the search input (substring match, case-insensitive).
  // Always shows the full list when the input is empty.
  const searchListSources = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    if (!q) return sm.allSources;
    return sm.allSources.filter((s) => s.toLowerCase().includes(q));
  }, [sm.allSources, searchInput]);

  /** Toggle every currently-visible (search-filtered) source's chip
   *  selection state. If ALL visible sources are already selected,
   *  this acts as "unselect all visible"; otherwise it adds the
   *  unselected ones. Lets the user grab a typed-filter result set
   *  in one click without clicking each row individually — the
   *  "multi-channel composite" use case. */
  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      const visible = searchListSources;
      const allSelected = visible.every((s) => next.has(s));
      if (allSelected) {
        for (const s of visible) next.delete(s);
      } else {
        for (const s of visible) next.add(s);
      }
      return next;
    });
  };

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
    sm.allSources.forEach((s, i) => m.set(s, CHANNEL_PALETTE[i % CHANNEL_PALETTE.length]));
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
  //
  // Also returns the per-KPI source breakdown (sorted desc) so the
  // hover popovers on each tile can render a mini-pie + legend
  // showing which channels contributed.
  const kpis = useMemo(() => {
    const breakdown = (m: Record<string, number>) => {
      const rows: { source: string; count: number }[] = [];
      for (const [s, c] of Object.entries(m)) {
        if (!selected.has(s) || c === 0) continue;
        rows.push({ source: s, count: c });
      }
      rows.sort((a, b) => b.count - a.count);
      return rows;
    };
    const leadsBreakdown = breakdown(sm.leadsBySource);
    const contactedBreakdown = breakdown(sm.contactedBySource);
    const scheduledBreakdown = breakdown(sm.scheduledMeetingsBySource);
    const meetingsBreakdown = breakdown(sm.meetingsBySource);
    const contractsBreakdown = breakdown(sm.contractsBySource || {});
    const sumOf = (rows: { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);
    const leads = sumOf(leadsBreakdown);
    const contacted = sumOf(contactedBreakdown);
    const scheduled = sumOf(scheduledBreakdown);
    // Cancelled subset of scheduled (BMBY only) → lets the תואמה tile show
    // תואמו (non-cancelled) + בוטלו. Chip-filtered like the rest.
    const canceled = sumOf(breakdown(sm.canceledMeetingsBySource || {}));
    const meetings = sumOf(meetingsBreakdown);
    const contracts = sumOf(contractsBreakdown);
    return {
      leads,
      contacted,
      scheduledMeetings: scheduled,
      canceledMeetings: canceled,
      meetings,
      contracts,
      meetingRatePct: leads > 0 ? (meetings / leads) * 100 : null,
      breakdowns: {
        leads: leadsBreakdown,
        contacted: contactedBreakdown,
        scheduledMeetings: scheduledBreakdown,
        meetings: meetingsBreakdown,
        contracts: contractsBreakdown,
      },
    };
  }, [selected, sm]);

  // ── Per-objection source breakdown for pie-legend hover popovers ──
  // Mirrors the KPI breakdowns shape — for each objection currently
  // visible in the pie, what's the chip-filtered source mix?
  const objectionSourceBreakdowns = useMemo(() => {
    const out = new Map<string, { source: string; count: number }[]>();
    for (const [objection, srcMap] of Object.entries(sm.objectionBySource)) {
      const rows: { source: string; count: number }[] = [];
      for (const [source, c] of Object.entries(srcMap)) {
        if (!selected.has(source) || c === 0) continue;
        rows.push({ source, count: c });
      }
      rows.sort((a, b) => b.count - a.count);
      if (rows.length > 0) out.set(objection, rows);
    }
    return out;
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
      head.map(([label, count], i) => ({ label, count, color: OBJECTION_PALETTE[i % OBJECTION_PALETTE.length] }));
    if (tail > 0) slices.push({ label: "אחר", count: tail, isOther: true, color: "#d1d5db" });
    return { slices, total: grandTotal };
  }, [selected, sm]);

  // ── Trendline daily series — filter dailyTimeSeries by chip + substring ─
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

  // ── Reactive-data motion ──────────────────────────────────────────
  // Every chip toggle re-aggregates the whole section. These make it
  // VISIBLY respond instead of snapping: the status-funnel + objection
  // legend rows FLIP to their new order, and the objection pie pops as
  // its slices redraw. Bar widths glide via CSS (globals.css). Keyed on
  // `selected` (a fresh Set on each toggle) so they fire on every change.
  const statusListRef = useFlipReorder<HTMLUListElement>(selected);
  const legendListRef = useFlipReorder<HTMLUListElement>(selected);
  const pieRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!pieRef.current || prefersReducedMotion()) return;
    animate(pieRef.current, {
      scale: [0.97, 1],
      opacity: [0.65, 1],
      duration: 420,
      ease: "outCubic",
    });
  }, [selected]);

  // The קמפיינים view carries ONLY the FB/Meta UTM breakdown — if this funnel
  // has none (non-warehouse project), render nothing rather than an empty card.
  if (view === "campaigns" && !funnel.fbBreakdown) return null;

  return (
    <section
      className={"project-section project-section-crm crm-view-" + view}
      dir="rtl"
    >
      <div className="section-head">
        <h2>
          {view === "analysis" ? "💬 התנגדויות ומסע " : "📋 משפך CRM"}
          <span
            className="crm-platform-badge"
            title={`חשבון ב־${funnel.platform.toUpperCase()}: ${funnel.crmAccount}`}
          >
            {funnel.platform.toUpperCase()}
          </span>
          {funnel.dataSource === "warehouse" ? (
            <span
              className="crm-source-badge"
              title={`הנתונים נמשכים ישירות ממסד הנתונים של ${funnel.platform === "sehel" ? "Sehel" : "BMBY"} (אירועים), לא מהארכיון בגיליון. שלם ועדכני יותר: לידים ברמת אירוע, שיוך מקור מלא ופגישות מאומתות.`}
            >
              ⚡ {funnel.platform === "sehel" ? "Sehel" : "BMBY"} ישיר
            </span>
          ) : null}
        </h2>
        <div className="section-head-actions">
          {funnel.monthFilter ? (
            <span
              className="crm-filter-chip"
              title="חודש הסינון — מסונכרן עם בורר החודשים של המטריקות למעלה"
            >
              חודש: {funnel.monthFilter}
            </span>
          ) : funnel.windowLabel ? (
            <span
              className="crm-filter-chip"
              title="תקופת הפעילות של הפרויקט (תאריכי התחלה–סיום) — מסונכרן עם תאריכי הדוח למעלה"
            >
              📅 {funnel.windowLabel}
            </span>
          ) : null}
          {funnel.dataLagThrough ? (
            <span
              className="crm-date-stale"
              title="הנתונים בקבוצה המסוננת מגיעים עד תאריך זה בלבד — בהמשך הטווח שנבחר אין עדיין נתונים (מקור שלא התעדכן, או פשוט אין לידים בימים האחרונים)"
            >
              ⚠️ נתונים עד {ddmm(funnel.dataLagThrough)}
            </span>
          ) : null}
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
          {/* Searchable multi-select — an alternate UI for the chip
              row's `selected` set. Useful for catching composite
              sources like "facebook, yad2" without scrolling the
              chip strip: type "face" → list filters → "סמן הכל" →
              every face-containing source is now in `selected`. The
              chip row and this popover share state, so the data
              filter has one source of truth. */}
          <div className="crm-source-search-wrap" ref={searchPopoverRef}>
            <button
              type="button"
              className={
                "crm-source-search-btn" +
                (searchPopoverOpen ? " is-open" : "")
              }
              onClick={() => setSearchPopoverOpen((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={searchPopoverOpen}
              title="חיפוש לפי טקסט במקור — תופס גם מקורות מרובי-ערוצים"
            >
              <span aria-hidden="true">🔍</span>
              <span className="crm-source-search-btn-label">חיפוש</span>
            </button>
            {searchPopoverOpen && (
              <div className="crm-source-search-popover" role="dialog">
                <input
                  type="text"
                  className="crm-source-search-input"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="חפש מקור…"
                  // Enter on a non-empty input acts as "סמן את כל
                  // ההתאמות" — keyboard equivalent of the button
                  // below. Lets the user type + Enter to grab every
                  // composite source in one motion.
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && searchInput.trim() && searchListSources.length > 0) {
                      e.preventDefault();
                      toggleAllVisible();
                    }
                  }}
                  autoFocus
                />
                {searchListSources.length > 0 && (() => {
                  const allVisibleSelected = searchListSources.every((s) =>
                    selected.has(s),
                  );
                  return (
                    <button
                      type="button"
                      className="crm-source-search-toggle-all"
                      onClick={toggleAllVisible}
                      title={
                        allVisibleSelected
                          ? "בטל את הסימון של כל ההתאמות"
                          : "סמן את כל ההתאמות הנראות"
                      }
                    >
                      {allVisibleSelected
                        ? `✓ בטל סימון של ${searchListSources.length} ההתאמות`
                        : `סמן את כל ${searchListSources.length} ההתאמות`}
                    </button>
                  );
                })()}
                <ul className="crm-source-search-list" role="listbox" aria-multiselectable="true">
                  {searchListSources.length === 0 ? (
                    <li className="crm-source-search-empty">אין התאמות.</li>
                  ) : (
                    searchListSources.map((source) => {
                      const icon = channelIcon(source);
                      const total = sm.leadsBySource[source] || 0;
                      const isChecked = selected.has(source);
                      return (
                        <li key={source}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={isChecked}
                            className={
                              "crm-source-search-row" +
                              (isChecked ? " is-active" : "")
                            }
                            // Row click toggles the same `selected`
                            // set the chip row controls. Does NOT
                            // clear the search input — keeps the
                            // filtered list in place so the user can
                            // multi-select within the same query.
                            onClick={() => toggle(source)}
                          >
                            {/* Checkbox visual — multi-select state
                                of the chip filter. role="option" +
                                aria-selected gives screen readers
                                proper multi-select listbox semantics. */}
                            <span
                              className={
                                "crm-source-search-check" +
                                (isChecked ? " is-checked" : "")
                              }
                              aria-hidden="true"
                            >
                              {isChecked ? "✓" : ""}
                            </span>
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
            // Inline media cost (anda model) — only for sources that map
            // 1:1 to a single paid channel; composites/non-paid are bare.
            const cost = funnel.costBySource?.[source];
            const title =
              cost && cost.cpl > 0
                ? `${source} — ${total} לידים · עלות לליד ${fmtILS(cost.cpl)}${
                    cost.cpm > 0 ? ` · עלות לפגישה ${fmtILS(cost.cpm)}` : ""
                  }`
                : `${source} — ${total} לידים`;
            return (
              <button
                key={source}
                type="button"
                aria-pressed={isActive}
                className={"crm-source-chip" + (isActive ? " is-active" : "")}
                onClick={() => toggle(source)}
                title={title}
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
                {cost && cost.cpl > 0 && (
                  <span
                    className="crm-source-chip-cpl"
                    style={{ color: costMetricColor("cpl", cost.cpl) ?? undefined }}
                  >
                    {fmtILS(cost.cpl)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* KPI tiles — now reactive to the chip filter. The headline
          numbers reflect the selected-source subset; with "all"
          selected they match the project totals (modulo rows with no
          source attribution, which sit outside the chip taxonomy). */}
      <StaggerReveal className="crm-kpi-row" childSelector=":scope > .crm-kpi-tile">
        <KpiTile label="לידים"
          value={<CountUp value={kpis.leads} format={fmtInt} />}
          breakdown={kpis.breakdowns.leads}
          palette={palette} />
        <KpiTile label="נוצר קשר"
          value={<CountUp value={kpis.contacted} format={fmtInt} />}
          sub={pct(kpis.contacted, kpis.leads)}
          breakdown={kpis.breakdowns.contacted}
          palette={palette} />
        <KpiTile label="תואמה פגישה"
          value={<CountUp value={kpis.scheduledMeetings} format={fmtInt} />}
          sub={pct(kpis.scheduledMeetings, kpis.leads)}
          note={
            funnel.platform === "bmby" && kpis.scheduledMeetings > 0
              ? `תואמו ${fmtInt(kpis.scheduledMeetings - kpis.canceledMeetings)} · בוטלו ${fmtInt(kpis.canceledMeetings)}`
              : undefined
          }
          breakdown={kpis.breakdowns.scheduledMeetings}
          palette={palette} />
        <KpiTile label="פגישות"
          value={<CountUp value={kpis.meetings} format={fmtInt} />}
          sub={pct(kpis.meetings, kpis.leads)}
          breakdown={kpis.breakdowns.meetings}
          palette={palette} />
        {funnel.contracts > 0 && (
          <KpiTile label={funnel.platform === "salesforce" ? "טופסי הרשמה" : "חוזים"}
            value={<CountUp value={kpis.contracts} format={fmtInt} />}
            sub={pct(kpis.contracts, kpis.leads)}
            breakdown={kpis.breakdowns.contracts}
            palette={palette} />
        )}
        <KpiTile label="יחס פגישה"
          value={kpis.meetingRatePct == null ? "—" : `${kpis.meetingRatePct.toFixed(1)}%`} />
      </StaggerReveal>

      {/* Authoritative held meetings from the BMBY warehouse (Supabase).
          Whole-window figure (NOT chip-filtered) — the Sheet's פגישות tile
          above conflates scheduled+held and over-counts; this is the
          BMBY-confirmed number (appointment_outcome='held'). Additive:
          collapses to nothing when the warehouse enrichment is absent.
          Gated on authoritative > 0 (not just the object's presence):
          BMBY logs appointment outcomes retrospectively, so an active
          project early in the month — or a dormant one with no in-window
          sync — legitimately has 0 confirmed-held. Showing "0 פגישות
          התקיימו בפועל · מאומת BMBY" next to a Sheet funnel that reports
          meetings reads as a bug, so we suppress and fall back to the
          Sheet figure until a real confirmed count exists. */}
      {funnel.supabaseEnrichment?.held &&
      funnel.supabaseEnrichment.held.authoritative > 0 ? (
        <div
          className="crm-held-authority"
          dir="rtl"
          title="מספר הפגישות שהתקיימו בפועל לפי מערכת BMBY, לכל חלון התאריכים (ללא סינון לפי מקור). הנתון בכרטיס 'פגישות' מעלה הוא הערכה מהגיליון שמערבבת תיאומים והתקיימו."
        >
          <span className="crm-held-authority-icon" aria-hidden>✓</span>
          <span className="crm-held-authority-main">
            {fmtInt(funnel.supabaseEnrichment.held.authoritative)} פגישות התקיימו בפועל
            <span className="crm-held-authority-tag">מאומת BMBY</span>
          </span>
          <span className="crm-held-authority-sub">
            כולל משוער: {fmtInt(funnel.supabaseEnrichment.held.estimated)}
            {funnel.supabaseEnrichment.held.canceled > 0
              ? ` · בוטלו: ${fmtInt(funnel.supabaseEnrichment.held.canceled)}`
              : ""}
          </span>
          {funnel.supabaseEnrichment.held.asOf ? (
            <span
              className="crm-held-authority-fresh"
              title={`עודכן ${funnel.supabaseEnrichment.held.asOf}`}
            >
              עודכן {funnel.supabaseEnrichment.held.asOf.slice(0, 10)}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Cost per media channel (anda "Monthly Channel Leads" model):
          channel media spend over the funnel's window attributed to the
          CRM lead sources → cost-per-lead / cost-per-meeting, colored on
          the same green→red scale as the budget desk. Only renders when
          spend was supplied (flight-window mode). */}
      {funnel.channelCosts && funnel.channelCosts.length > 0 && (
        <div className="crm-block crm-cost-block">
          <div className="crm-block-title">עלות לפי ערוץ מדיה</div>
          <div className="crm-cost-scroll">
            <table className="crm-cost-table">
              <thead>
                <tr>
                  <th>ערוץ</th>
                  <th>הוצאה</th>
                  <th>לידים</th>
                  <th>עלות לליד</th>
                  <th>תיאומי פגישה</th>
                  <th>עלות לתיאום</th>
                  <th>פגישות</th>
                  <th>עלות לפגישה</th>
                </tr>
              </thead>
              <tbody>
                {funnel.channelCosts.map((c) => {
                  const ic = channelIcon(c.channel);
                  return (
                    <tr key={c.channel}>
                      <td className="crm-cost-ch">
                        {ic ? <span aria-hidden="true">{ic}</span> : null} {c.label}
                      </td>
                      <td>{fmtILS(c.spend)}</td>
                      <td>{fmtInt(c.leads)}</td>
                      <td
                        style={{
                          color: costMetricColor("cpl", c.cpl) ?? undefined,
                          fontWeight: 600,
                        }}
                      >
                        {c.leads > 0 ? fmtILS(c.cpl) : "—"}
                      </td>
                      <td>{fmtInt(c.scheduled)}</td>
                      <td
                        style={{
                          color: costMetricColor("cps", c.cps) ?? undefined,
                          fontWeight: 600,
                        }}
                      >
                        {c.scheduled > 0 ? fmtILS(c.cps) : "—"}
                      </td>
                      <td>{fmtInt(c.meetings)}</td>
                      <td
                        style={{
                          color: costMetricColor("cpm", c.cpm) ?? undefined,
                          fontWeight: 600,
                        }}
                      >
                        {c.meetings > 0 ? fmtILS(c.cpm) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Status funnel + trendline — 50/50 grid. Trendline moved up
          here 2026-05-12 (was below the pie before). The objections-
          by-source breakdown that used to live next to the funnel was
          folded into the pie's legend below, so each legend row now
          carries the source-mix bar inline. */}
      {(statusRows.length > 0 || trendDaily.length > 0) && (
        <div className="crm-objection-grid">
          {statusRows.length > 0 && (
            <div className="crm-block">
              <div className="crm-block-title">משפך סטטוסים</div>
              <ul className="crm-matrix" ref={statusListRef}>
                {statusRows.map((row) => {
                  const cumPct = (row.cumulative / Math.max(1, kpis.leads) * 100).toFixed(1);
                  const tooltip =
                    `${row.label} — ${row.cumulative} (${cumPct}% מהלידים הגיעו לשלב הזה או מעבר)\n` +
                    `מתוכם ${row.count} (${pct(row.count, kpis.leads)}) נמצאים כעת בשלב הזה בדיוק`;
                  return (
                    <li key={row.label} data-flip={row.label} className="crm-matrix-row" title={tooltip}>
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

          {trendDaily.length > 0 && (
            <CrmFunnelTrendline
              dailyTimeSeries={trendDaily}
              selectedSources={selected}
              sourceColors={palette}
            />
          )}
        </div>
      )}

      {/* Combined objection-pie + per-objection source-mix bars in the
          legend. The bars were a separate block ("התנגדויות לפי מקור
          הגעה") until 2026-05-12 — folding them into the legend lets
          one card carry the "how big is each objection AND which
          channels drive it" story without doubling the vertical space. */}
      {pieData.slices.length > 0 && (
        <div className="crm-source-analysis-grid crm-source-analysis-grid-single">
          <div className="crm-block crm-pie-block">
            <div className="crm-block-title">התפלגות התנגדויות</div>
            <div className="crm-pie-row">
              <div
                ref={pieRef}
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
              <ul className="crm-pie-legend" ref={legendListRef}>
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
                    // Embedded stacked-source bar — the per-objection
                    // source mix used to live in its own block
                    // ("התנגדויות לפי מקור הגעה"). Folded into the
                    // legend row 2026-05-12: bar width is proportional
                    // to the slice's count relative to the largest
                    // slice (max), so bigger objections render visibly
                    // longer bars — matches the old block's relative
                    // sizing. "אחר" rolls multiple objections, so it
                    // shows no bar (the source mix wouldn't be
                    // meaningful for the rollup).
                    const objTotal = breakdown
                      ? breakdown.reduce((n, b) => n + b.count, 0)
                      : 0;
                    const maxSliceCount = pieData.slices.reduce(
                      (m, x) => Math.max(m, x.count),
                      0,
                    ) || 1;
                    const barWidthPct = (s.count / maxSliceCount) * 100;
                    return (
                      <PieLegendRow
                        key={s.label}
                        flipId={s.label}
                        label={s.label}
                        count={s.count}
                        pctOfTotal={(s.count / pieData.total) * 100}
                        color={s.color}
                        isOther={!!s.isOther}
                        breakdown={breakdown}
                        objTotal={objTotal}
                        barWidthPct={barWidthPct}
                        palette={palette}
                      />
                    );
                  })
                )}
                {/* Sum row — total objections across the displayed slices.
                    Sits at the bottom of the legend with a top border so
                    it reads as the column footer. Percentages always
                    total 100% so we hardcode it (avoids the harmless
                    "99.9%" / "100.1%" rounding drift that would happen
                    if we summed the per-slice rounded percentages). */}
                {pieData.slices.length > 0 && pieData.total > 0 && (
                  <li className="crm-pie-legend-row crm-pie-legend-row-sum">
                    <span
                      className="crm-legend-dot crm-legend-dot-sum"
                      aria-hidden
                    />
                    <span className="crm-legend-label">סה״כ</span>
                    <span className="crm-legend-count">
                      {pieData.total} (100%)
                    </span>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Facebook/Meta UTM drill (warehouse-sourced funnels only). Placement
          + audience are lead-count splits; the creative table adds scheduled/
          held and spend → cost-per-lead / scheduled / held, joined from the
          dashboard's facebook-ads-metrics Sheet by exact campaign + ad name. */}
      {funnel.fbBreakdown ? (
        <details className="crm-fb-breakdown" dir="rtl">
          <summary className="crm-fb-head">
            <span className="crm-fb-icon" aria-hidden>📘</span>
            פילוח פייסבוק — {fmtInt(funnel.fbBreakdown.totalLeads)} לידים
            <span className="crm-fb-headsub">לפי תגיות UTM (Meta — פייסבוק/אינסטגרם)</span>
          </summary>
          <p className="crm-fb-basis">
            לידים = נכנסו בטווח · תואמו/פגישות = אירועי פגישה שתאריכם בטווח, לפי
            המודעה שהביאה את הלקוח במגע הראשון (גם אם הליד נכנס לפני הטווח) —
            אותה הגדרה כמו אריחי המשפך. פגישות = מאושרות-בוצעו בלבד ב-BMBY, לכן
            בחודש הנוכחי הן מתעדכנות בדיעבד.
          </p>
          <div className="crm-fb-cols">
            {([
              ["מיקום (Placement)", funnel.fbBreakdown.byPlacement],
              ["קהל (Audience)", funnel.fbBreakdown.byAudience],
            ] as const).map(([title, list]) => {
              const max = list[0]?.leads || 1;
              return (
                <div key={title} className="crm-fb-col">
                  <div className="crm-fb-col-title crm-fb-col-title-row">
                    <span>{title}</span>
                    <span className="crm-fb-col-legend" aria-hidden>
                      לידים · תואמו · פגישות
                    </span>
                  </div>
                  {list.map((r) => (
                    <div
                      key={r.label}
                      className="crm-fb-row"
                      title={`${r.label}: ${r.leads} לידים · ${r.scheduled} תואמו · ${r.held} פגישות`}
                    >
                      <div
                        className="crm-fb-bar"
                        style={{ width: `${Math.max(4, (r.leads / max) * 100)}%` }}
                      />
                      <span className="crm-fb-rowlabel">{r.label}</span>
                      <span className="crm-fb-rowmetrics">
                        <span className="crm-fb-rowcount">{fmtInt(r.leads)}</span>
                        <span className="crm-fb-rowsub" title="תואמו">
                          {fmtInt(r.scheduled)}
                        </span>
                        <span className="crm-fb-rowsub" title="פגישות">
                          {fmtInt(r.held)}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {funnel.fbBreakdown.byCreative.length > 0 ? (
            <div className="crm-fb-creatives">
              <div className="crm-fb-col-title">
                קריאייטיב — לידים · פגישות · עלות (מתוך נתוני פייסבוק בגיליון)
              </div>
              <table className="crm-fb-table">
                <thead>
                  <tr>
                    <th>מודעה</th>
                    <th className="m-leads">לידים</th>
                    <th className="m-sched">תואמו</th>
                    <th className="m-held">פגישות</th>
                    <th className="m-leads" title="עלות לליד">CPL</th>
                    <th className="m-sched" title="עלות לתיאום פגישה">CPS</th>
                    <th className="m-held" title="עלות לפגישה שהתקיימה">CPM</th>
                  </tr>
                </thead>
                <tbody>
                  {funnel.fbBreakdown.byCreative.map((c) => (
                    <tr key={c.label}>
                      <td className="crm-fb-adname" title={c.label}>{c.label}</td>
                      <td className="m-leads">{fmtInt(c.leads)}</td>
                      <td className="m-sched">{fmtInt(c.scheduled)}</td>
                      <td className="m-held">{fmtInt(c.held)}</td>
                      <td className="m-leads">{c.cpl ? `₪${fmtInt(c.cpl)}` : "—"}</td>
                      <td className="m-sched">{c.cps ? `₪${fmtInt(c.cps)}` : "—"}</td>
                      <td className="m-held">{c.cpm ? `₪${fmtInt(c.cpm)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </details>
      ) : null}

      {/* Google keyword drill (Sehel warehouse only) — utm_term on
          google-source leads. Sibling of the FB block so Meta/Google stay
          visually distinct; shown only when the warehouse populated it. */}
      {funnel.fbBreakdown?.byKeyword && funnel.fbBreakdown.byKeyword.length > 0 ? (
        <details className="crm-fb-breakdown crm-kw-breakdown" dir="rtl">
          <summary className="crm-fb-head">
            <span className="crm-fb-icon" aria-hidden>🔍</span>
            מילות מפתח — Google
            <span className="crm-fb-headsub">לפי utm_term (חיפוש בתשלום)</span>
          </summary>
          <div className="crm-fb-cols">
            {(() => {
              const list = funnel.fbBreakdown.byKeyword;
              const max = list[0]?.leads || 1;
              return (
                <div className="crm-fb-col">
                  <div className="crm-fb-col-title crm-fb-col-title-row">
                    <span>מילת מפתח (Keyword)</span>
                    <span className="crm-fb-col-legend" aria-hidden>
                      לידים · תואמו · פגישות
                    </span>
                  </div>
                  {list.map((r) => (
                    <div
                      key={r.label}
                      className="crm-fb-row"
                      title={`${r.label}: ${r.leads} לידים · ${r.scheduled} תואמו · ${r.held} פגישות`}
                    >
                      <div
                        className="crm-fb-bar"
                        style={{ width: `${Math.max(4, (r.leads / max) * 100)}%` }}
                      />
                      <span className="crm-fb-rowlabel">{r.label}</span>
                      <span className="crm-fb-rowmetrics">
                        <span className="crm-fb-rowcount">{fmtInt(r.leads)}</span>
                        <span className="crm-fb-rowsub" title="תואמו">
                          {fmtInt(r.scheduled)}
                        </span>
                        <span className="crm-fb-rowsub" title="פגישות">
                          {fmtInt(r.held)}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </details>
      ) : null}

      {/* ── Warehouse "extras" (BMBY) — collapsed by default, parked below
          the FB breakdown so the funnel's core stays up top (owner). ── */}

      {/* Speed-to-lead — response time from lead arrival to first desk
          touch, per channel. Whole-window, NOT chip-filtered. */}
      {funnel.speedToLead && (
        <details className="crm-block crm-collapsible crm-speed-block">
          <summary className="crm-block-title">
            מהירות מענה — מהליד עד הפנייה הראשונה
            <span
              className="crm-speed-overall"
              title="חציון זמן התגובה ושיעור המענה המהיר, לכל חלון התאריכים (לא מסונן לפי הצ׳יפים)"
            >
              {" "}· חציון {fmtDur(funnel.speedToLead.overall.medianSec)} ·{" "}
              {pct(funnel.speedToLead.overall.under300, funnel.speedToLead.overall.n)} תוך 5 דק׳ ·{" "}
              {pct(funnel.speedToLead.overall.under60, funnel.speedToLead.overall.n)} תוך דקה
            </span>
          </summary>
          <div className="crm-cost-scroll">
            <table className="crm-cost-table crm-speed-table">
              <thead>
                <tr>
                  <th>ערוץ</th>
                  <th>לידים</th>
                  <th>חציון מענה</th>
                  <th>תוך דקה</th>
                  <th>תוך 5 דק׳</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(funnel.speedToLead.bySource)
                  .sort((a, b) => b[1].n - a[1].n)
                  .map(([src, s]) => (
                    <tr key={src}>
                      <td className="crm-cost-ch">
                        <span
                          className="crm-trend-legend-dot"
                          style={{ background: palette.get(src) }}
                        />{" "}
                        {src}
                      </td>
                      <td>{fmtInt(s.n)}</td>
                      <td style={{ color: speedTone(s.medianSec), fontWeight: 600 }}>
                        {fmtDur(s.medianSec)}
                      </td>
                      <td>{pct(s.under60, s.n)}</td>
                      <td>{pct(s.under300, s.n)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Lead-journey velocity — days from a cohort lead to its first held
          meeting (on/after), per channel. Whole-window, collapsed. */}
      {funnel.journeyVelocity && (
        <details className="crm-block crm-collapsible crm-speed-block">
          <summary className="crm-block-title">
            מסע הליד — מהליד עד פגישה שהתקיימה
            <span
              className="crm-speed-overall"
              title="חציון/ממוצע הימים מהגעת הליד עד הפגישה הראשונה שהתקיימה (לכל החלון, לא מסונן)"
            >
              {" "}· חציון {funnel.journeyVelocity.overall.medianDays} י׳ · ממוצע{" "}
              {funnel.journeyVelocity.overall.avgDays} י׳ · {fmtInt(funnel.journeyVelocity.overall.n)} פגישות
            </span>
          </summary>
          <div className="crm-cost-scroll">
            <table className="crm-cost-table crm-speed-table">
              <thead>
                <tr>
                  <th>ערוץ</th>
                  <th>פגישות</th>
                  <th>חציון ימים</th>
                  <th>ממוצע ימים</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(funnel.journeyVelocity.bySource)
                  .sort((a, b) => b[1].n - a[1].n)
                  .map(([src, s]) => (
                    <tr key={src}>
                      <td className="crm-cost-ch">
                        <span
                          className="crm-trend-legend-dot"
                          style={{ background: palette.get(src) }}
                        />{" "}
                        {src}
                      </td>
                      <td>{fmtInt(s.n)}</td>
                      <td style={{ fontWeight: 600 }}>{s.medianDays} י׳</td>
                      <td>{s.avgDays} י׳</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Returning vs new leads — is_return_lead. Whole-window, collapsed. */}
      {funnel.returningSplit && (
        <details className="crm-block crm-collapsible crm-return-block">
          <summary className="crm-block-title">
            לידים חוזרים מול חדשים
            <span className="crm-speed-overall">
              {" "}· {pct(funnel.returningSplit.returning, funnel.returningSplit.total)} חוזרים (
              {fmtInt(funnel.returningSplit.returning)} מתוך {fmtInt(funnel.returningSplit.total)})
            </span>
          </summary>
          <div className="crm-cost-scroll">
            <table className="crm-cost-table crm-return-table">
              <thead>
                <tr>
                  <th>ערוץ</th>
                  <th>לידים</th>
                  <th>חדשים</th>
                  <th>חוזרים</th>
                  <th>% חוזרים</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(funnel.returningSplit.bySource)
                  .map(([src, s]) => ({ src, ...s, total: s.returning + s.newLeads }))
                  .sort((a, b) => b.total - a.total)
                  .map((r) => (
                    <tr key={r.src}>
                      <td className="crm-cost-ch">
                        <span
                          className="crm-trend-legend-dot"
                          style={{ background: palette.get(r.src) }}
                        />{" "}
                        {r.src}
                      </td>
                      <td>{fmtInt(r.total)}</td>
                      <td>{fmtInt(r.newLeads)}</td>
                      <ReturningPriorCell
                        value={r.returning}
                        priors={Object.entries(
                          funnel.returningSplit!.priorBySource?.[r.src] || {},
                        )
                          .map(([source, count]) => ({ source, count }))
                          .sort((a, b) => b.count - a.count)}
                        palette={palette}
                      />
                      <td style={{ fontWeight: 600 }}>{pct(r.returning, r.total)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Lead-arrival heatmap — weekday × hour (Asia/Jerusalem). Collapsed. */}
      {funnel.arrivalHeatmap && (
        <details className="crm-block crm-collapsible crm-heat-block">
          <summary className="crm-block-title">
            מתי מגיעים לידים — מפת חום
            <span className="crm-speed-overall">
              {" "}· {fmtInt(funnel.arrivalHeatmap.total)} לידים · יום × שעה
            </span>
          </summary>
          <div className="crm-cost-scroll">
            <table className="crm-heat-table">
              <thead>
                <tr>
                  <th />
                  {Array.from({ length: 24 }, (_, h) => (
                    <th key={h}>{h % 3 === 0 ? h : ""}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"].map((label, wd) => (
                  <tr key={wd}>
                    <th className="crm-heat-wd">{label}</th>
                    {funnel.arrivalHeatmap!.matrix[wd].map((c, h) => {
                      const intensity =
                        funnel.arrivalHeatmap!.peak > 0
                          ? c / funnel.arrivalHeatmap!.peak
                          : 0;
                      return (
                        <td
                          key={h}
                          className="crm-heat-cell"
                          style={
                            c > 0
                              ? { background: `rgba(99,102,241,${(0.12 + intensity * 0.88).toFixed(3)})` }
                              : undefined
                          }
                          title={`${label} ${String(h).padStart(2, "0")}:00 — ${c} לידים`}
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
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
  note,
  breakdown,
  palette,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  /** Optional extra line under `sub` — used for the תואמה breakdown
   *  (תואמו + בוטלו). Plain text, muted. */
  note?: string;
  /** Per-source breakdown for this metric under the current chip
   *  selection. When present (and non-empty), the tile gets a hover
   *  popover with a mini-pie of which channels contributed. */
  breakdown?: { source: string; count: number }[];
  palette?: Map<string, string>;
}) {
  const hasPopover = !!breakdown && breakdown.length > 0 && !!palette;
  const { open, pos, triggerProps, popoverProps } = useHoverPopover<HTMLDivElement>();
  return (
    <div
      {...(hasPopover ? triggerProps : {})}
      className={"crm-kpi-tile" + (hasPopover ? " crm-kpi-tile-has-popover" : "")}
    >
      <div className="crm-kpi-value">{value}</div>
      <div className="crm-kpi-label">{label}</div>
      {sub ? <div className="crm-kpi-sub">{sub}</div> : null}
      {note ? <div className="crm-kpi-note">{note}</div> : null}
      {hasPopover && open && pos
        ? createPortal(
            <div
              {...popoverProps}
              className="crm-channel-tooltip is-visible crm-channel-tooltip-portal"
              role="tooltip"
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                transform: "translateX(-50%)",
                zIndex: 9999,
                pointerEvents: "auto",
                opacity: 1,
                visibility: "visible",
              }}
            >
              <ChannelMiniPieContent data={breakdown!} palette={palette!} metric={label} />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * Single row of the objections-pie legend, with its own portal-anchored
 * popover (per-objection × source breakdown). Extracted from the inline
 * .map so each row owns its own ref + hover state — needed for the
 * portal positioning, which has to compute coordinates from THIS row's
 * bounding rect, not the parent list's.
 */
function PieLegendRow({
  flipId,
  label,
  count,
  pctOfTotal,
  color,
  isOther,
  breakdown,
  objTotal,
  barWidthPct,
  palette,
}: {
  flipId: string;
  label: string;
  count: number;
  pctOfTotal: number;
  color: string;
  isOther: boolean;
  breakdown: { source: string; count: number }[] | null;
  objTotal: number;
  barWidthPct: number;
  palette: Map<string, string>;
}) {
  const hasPopover = !!breakdown && breakdown.length > 0;
  const { open, pos, triggerProps, popoverProps } = useHoverPopover<HTMLLIElement>();
  return (
    <li
      {...(hasPopover ? triggerProps : {})}
      data-flip={flipId}
      className={hasPopover ? "crm-pie-legend-row crm-pie-legend-row-has-popover" : "crm-pie-legend-row"}
    >
      <span
        className={"crm-legend-dot" + (isOther ? " crm-legend-dot-rest" : "")}
        style={isOther ? undefined : { background: color }}
      />
      <span className="crm-legend-label" title={label}>{label}</span>
      {breakdown && breakdown.length > 0 && objTotal > 0 ? (
        <span
          className="crm-legend-bar"
          style={{ width: `${barWidthPct}%` }}
          aria-hidden
        >
          {breakdown.map((b) => {
            const w = (b.count / objTotal) * 100;
            if (w < 0.5) return null;
            return (
              <span
                key={b.source}
                className="crm-legend-bar-seg"
                style={{ width: `${w}%`, background: palette.get(b.source) }}
                title={`${channelIcon(b.source)} ${b.source} — ${b.count} (${pct(b.count, objTotal)})`.trim()}
              />
            );
          })}
        </span>
      ) : null}
      <span className="crm-legend-count">
        {count} ({pctOfTotal.toFixed(1)}%)
      </span>
      {hasPopover && open && pos && breakdown
        ? createPortal(
            <div
              {...popoverProps}
              className="crm-channel-tooltip is-visible crm-channel-tooltip-portal"
              role="tooltip"
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                transform: "translateX(-50%)",
                zIndex: 9999,
                pointerEvents: "auto",
                opacity: 1,
                visibility: "visible",
              }}
            >
              <ChannelMiniPieContent data={breakdown} palette={palette} metric={label} />
            </div>,
            document.body,
          )
        : null}
    </li>
  );
}

/**
 * The returning table's חוזרים cell — hovering it reveals which media
 * channel those returning leads previously arrived through (their
 * immediately-prior lead). Portal-anchored mini-pie, same mechanism as
 * KpiTile. The known-prior count is a subset of `value` (pre-2024
 * inquiries can't be located), surfaced in the popover title.
 */
function ReturningPriorCell({
  value,
  priors,
  palette,
}: {
  value: number;
  priors: { source: string; count: number }[];
  palette: Map<string, string>;
}) {
  const has = priors.length > 0;
  const known = priors.reduce((n, p) => n + p.count, 0);
  const { open, pos, triggerProps, popoverProps } =
    useHoverPopover<HTMLTableCellElement>();
  return (
    <td
      {...(has ? triggerProps : {})}
      className={has ? "crm-prior-cell" : undefined}
    >
      {fmtInt(value)}
      {has && open && pos
        ? createPortal(
            <div
              {...popoverProps}
              className="crm-channel-tooltip is-visible crm-channel-tooltip-portal"
              role="tooltip"
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                transform: "translateX(-50%)",
                zIndex: 9999,
                pointerEvents: "auto",
                opacity: 1,
                visibility: "visible",
              }}
            >
              <ChannelMiniPieContent
                data={priors}
                palette={palette}
                metric={`ערוץ קודם (${fmtInt(known)} מתוך ${fmtInt(value)})`}
              />
            </div>,
            document.body,
          )
        : null}
    </td>
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
  return (
    <div
      className={"crm-channel-tooltip" + (visible ? " is-visible" : "")}
      role="tooltip"
    >
      <ChannelMiniPieContent data={data} palette={palette} metric={metric} />
    </div>
  );
}

/**
 * Inner content of the channel mini-pie popover (title + pie + legend) —
 * extracted from ChannelMiniPie so the portal-anchored KpiTile / legend-
 * row popovers can render the same body without duplicating the
 * conic-gradient + legend markup.
 */
function ChannelMiniPieContent({
  data,
  palette,
  metric,
}: {
  data: { source: string; count: number }[];
  palette: Map<string, string>;
  metric: string;
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
    <>
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
    </>
  );
}

function fmtInt(n: number): string {
  return n.toLocaleString("he-IL");
}
function fmtILS(n: number): string {
  return "₪" + Math.round(n || 0).toLocaleString("he-IL");
}
function pct(part: number, whole: number): string {
  if (!whole) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}
/** Seconds → compact Hebrew duration (שנ׳ / דק׳ / שע׳). */
function fmtDur(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${Math.round(sec)} שנ׳`;
  if (sec < 3600) return `${Math.round(sec / 60)} דק׳`;
  return `${(sec / 3600).toFixed(1)} שע׳`;
}
/** Median-response color: ≤5min green, ≤1h amber, else red. */
function speedTone(sec: number): string {
  if (sec <= 300) return "#16a34a";
  if (sec <= 3600) return "#d97706";
  return "#dc2626";
}
