import { getCrmFunnelForProject, type CrmFunnel } from "@/lib/crmData";
import CrmSourceAnalysis from "./CrmSourceAnalysis";

/**
 * Server component — renders the project's CRM funnel as a card on the
 * project overview page. Sits between the platform-leads section and
 * the dashboard iframe.
 *
 * Returns `null` when the project has no Keys.CRM mapping or the source
 * tab has zero matches — caller wraps in <Suspense fallback={null}> so
 * projects without CRM data silently collapse rather than showing an
 * empty box.
 *
 * Layout:
 *   1. Section head — "📋 משפך CRM" + platform badge + date-range note
 *   2. 4-tile KPI row — leads / contacted / meetings / meeting-rate
 *   3. Top statuses (horizontal bar of top buckets, % of leads)
 *   4. Top objections (vertical list, count + bar)
 *   5. (BMBY only) Top sellers — collapsed by default to a 1-line summary
 */
export default async function CrmFunnelCard({
  company,
  project,
  monthFilter,
}: {
  company: string;
  project: string;
  /** Threaded from the page's `?monthOverride=YYYY-MM` so this card
   *  matches whatever month the dashboard iframe is rendering. Empty
   *  means "no filter — show all rows we have." */
  monthFilter?: string;
}) {
  const funnel = await getCrmFunnelForProject({
    company,
    project,
    monthFilter,
  }).catch(() => null);
  if (!funnel || funnel.leads === 0) return null;

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

      {/* KPI tiles. Each (except "יחס פגישה", which is a derived %) gets
          a hover popover showing the source breakdown for that metric
          as a small pie + legend — same conic-gradient renderer as the
          per-source pie picker below. Pure CSS hover; no JS state.
          Funnel order reads right-to-left in RTL: leads → contacted →
          scheduled (תואמה פגישה) → held (פגישות) → derived rate. */}
      <div className="crm-kpi-row">
        <KpiTile
          label="לידים"
          value={fmtInt(funnel.leads)}
          sourceBreakdown={funnel.kpiSourceBreakdowns.leads}
          metricTotal={funnel.leads}
        />
        <KpiTile
          label="נוצר קשר"
          value={fmtInt(funnel.contacted)}
          sub={pct(funnel.contacted, funnel.leads)}
          sourceBreakdown={funnel.kpiSourceBreakdowns.contacted}
          metricTotal={funnel.contacted}
        />
        <KpiTile
          label="תואמה פגישה"
          value={fmtInt(funnel.scheduledMeetings)}
          sub={pct(funnel.scheduledMeetings, funnel.leads)}
          sourceBreakdown={funnel.kpiSourceBreakdowns.scheduledMeetings}
          metricTotal={funnel.scheduledMeetings}
        />
        <KpiTile
          label="פגישות"
          value={fmtInt(funnel.meetings)}
          sub={pct(funnel.meetings, funnel.leads)}
          sourceBreakdown={funnel.kpiSourceBreakdowns.meetings}
          metricTotal={funnel.meetings}
        />
        <KpiTile
          label="יחס פגישה"
          value={funnel.meetingRatePct == null ? "—" : `${funnel.meetingRatePct.toFixed(1)}%`}
        />
      </div>

      {/* Status breakdown — vertical funnel chart in stage order.
          Each row's width is the cumulative count ("leads currently at
          this stage or beyond"), so the chart naturally narrows from
          top (ליד / first contact) to bottom (חוזה / final close). The
          stage order is the canonical BMBY_STATUS_FUNNEL_ORDER /
          SEHEL_STATUS_FUNNEL_ORDER constant in lib/crmData.ts — edit
          there to retune the hierarchy. */}
      {funnel.byStatus.length > 0 && (
        <div className="crm-block">
          <div className="crm-block-title">משפך סטטוסים</div>
          <FunnelChart items={funnel.byStatus} total={funnel.leads} />
        </div>
      )}

      {/* Top objections — null-safe; many rows in source data have no
          objection text, so showing a small N here is normal. */}
      {funnel.topObjections.length > 0 && (
        <div className="crm-block">
          <div className="crm-block-title">התנגדויות מובילות</div>
          <ul className="crm-list">
            {funnel.topObjections.map((o) => (
              <li key={o.label} className="crm-list-row">
                <span className="crm-list-bar-track">
                  <span
                    className="crm-list-bar"
                    style={{
                      width: `${
                        funnel.topObjections.length > 0
                          ? Math.max(2, (o.count / funnel.topObjections[0].count) * 100)
                          : 0
                      }%`,
                    }}
                  />
                </span>
                <span className="crm-list-label" title={o.label}>{o.label}</span>
                <span className="crm-list-count">{o.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Objections × source cross-tab. For each top-5 objection, a
          horizontal stacked bar shows how those leads broke down across
          acquisition sources. Lets the user see e.g. "מחיר was 50% טלפון
          and 31% רדיו" — actionable for source-mix decisions. The
          source→color mapping is built once across the whole matrix so
          the same source uses the same color in every row + the legend. */}
      {funnel.objectionsBySource.length > 0 && (() => {
        const PALETTE = [
          "#6366f1","#10b981","#f59e0b","#ec4899","#0ea5e9",
          "#8b5cf6","#14b8a6","#ef4444","#a3a3a3","#84cc16",
        ];
        const seen = new Map<string, { color: string; isOther: boolean }>();
        for (const row of funnel.objectionsBySource) {
          for (const s of row.sources) {
            if (seen.has(s.source)) continue;
            const color = s.isOther
              ? "" // styled via CSS .crm-matrix-seg-rest hatched pattern
              : PALETTE[seen.size % PALETTE.length];
            seen.set(s.source, { color, isOther: !!s.isOther });
          }
        }
        const legend = [...seen.entries()].map(([source, v]) => ({
          source,
          color: v.color,
          isOther: v.isOther,
        }));
        // Bar lengths should reflect absolute objection counts, not all
        // be uniform. funnel.objectionsBySource is already sorted desc by
        // total in the lib, so the first row has the max and we use it
        // as the 100%-bar baseline; lesser objections render shorter.
        const maxRowTotal = funnel.objectionsBySource[0]?.total || 1;
        return (
          <div className="crm-block">
            <div className="crm-block-title">התנגדויות לפי מקור הגעה</div>
            <ul className="crm-matrix">
              {funnel.objectionsBySource.map((row) => (
                <li key={row.objection} className="crm-matrix-row">
                  <span className="crm-matrix-label" title={row.objection}>
                    {row.objection}
                  </span>
                  <span
                    className="crm-matrix-bar"
                    style={{ width: `${(row.total / maxRowTotal) * 100}%` }}
                  >
                    {row.sources.map((s) => {
                      const w = (s.count / row.total) * 100;
                      if (w < 0.5) return null;
                      const meta = seen.get(s.source);
                      return (
                        <span
                          key={s.source}
                          className={
                            "crm-matrix-seg" +
                            (s.isOther ? " crm-matrix-seg-rest" : "")
                          }
                          style={
                            s.isOther
                              ? { width: `${w}%` }
                              : { width: `${w}%`, background: meta?.color }
                          }
                          title={`${s.source} — ${s.count} (${pct(s.count, row.total)})`}
                        />
                      );
                    })}
                  </span>
                  <span className="crm-matrix-total">{row.total}</span>
                </li>
              ))}
            </ul>
            <ul className="crm-matrix-legend">
              {legend.map((s) => (
                <li key={s.source}>
                  <span
                    className={
                      "crm-legend-dot" + (s.isOther ? " crm-legend-dot-rest" : "")
                    }
                    style={s.isOther ? undefined : { background: s.color }}
                  />
                  <span className="crm-legend-label" title={s.source}>
                    {s.source}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })()}

      {/* Per-source pie + over-time trendline. The two surfaces share
          a single source-selection state (chips above) — picking a
          subset of channels narrows both the objection pie AND the
          three-series line chart below. Client component because the
          chip picker has local UI state. */}
      {funnel.sourceBreakdown.length > 0 && (
        <CrmSourceAnalysis
          breakdown={funnel.sourceBreakdown}
          dailyTimeSeries={funnel.dailyTimeSeries}
        />
      )}

      {/* Sellers — BMBY-only. One-line summary form: "Top 5: X(120), Y(80), …" */}
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
  sourceBreakdown,
  metricTotal,
}: {
  label: string;
  value: string;
  sub?: string;
  /** Top-5 + rest source breakdown for this KPI. Drives the hover
   *  popover. Omitted → no popover renders. */
  sourceBreakdown?: { source: string; count: number; isOther?: boolean }[];
  /** Headline number this tile represents — used as the denominator
   *  for the pie segments + legend percentages. When 0, the popover
   *  doesn't render (nothing meaningful to draw). */
  metricTotal?: number;
}) {
  const hasPopover =
    !!sourceBreakdown &&
    sourceBreakdown.length > 0 &&
    !!metricTotal &&
    metricTotal > 0;
  return (
    <div
      className={
        "crm-kpi-tile" + (hasPopover ? " crm-kpi-tile-has-popover" : "")
      }
    >
      <div className="crm-kpi-value">{value}</div>
      <div className="crm-kpi-label">{label}</div>
      {sub ? <div className="crm-kpi-sub">{sub}</div> : null}
      {hasPopover ? (
        <KpiSourcePopover
          breakdown={sourceBreakdown!}
          total={metricTotal!}
          metric={label}
        />
      ) : null}
    </div>
  );
}

/**
 * Hover popover for a KPI tile — small donut + legend of how that
 * metric breaks down across acquisition sources. Pure CSS reveal (no
 * client state) via the parent's :hover, so this stays a server
 * component. Uses the same conic-gradient pie pattern as
 * CrmSourcePieSection but in a more compact form.
 */
function KpiSourcePopover({
  breakdown,
  total,
  metric,
}: {
  breakdown: { source: string; count: number; isOther?: boolean }[];
  total: number;
  metric: string;
}) {
  const PALETTE = [
    "#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9",
    "#8b5cf6", "#14b8a6", "#ef4444",
  ];
  // Walk segments, emit conic-gradient stops.
  let cum = 0;
  const stops: string[] = [];
  breakdown.forEach((s, i) => {
    const start = (cum / total) * 360;
    cum += s.count;
    const end = (cum / total) * 360;
    if (end - start < 1.8) return; // < 0.5% — skip invisible slice
    const fill = s.isOther ? "#d1d5db" : PALETTE[i % PALETTE.length];
    stops.push(`${fill} ${start.toFixed(3)}deg ${end.toFixed(3)}deg`);
  });
  const pieStyle = stops.length
    ? { background: `conic-gradient(${stops.join(", ")})` }
    : { background: "#f3f4f6" };
  return (
    <div className="crm-kpi-popover" role="tooltip">
      <div className="crm-kpi-popover-title">{metric} — לפי מקור הגעה</div>
      <div className="crm-kpi-popover-body">
        <div className="crm-kpi-popover-pie" style={pieStyle} />
        <ul className="crm-kpi-popover-legend">
          {breakdown.map((s, i) => (
            <li key={s.source}>
              <span
                className={
                  "crm-legend-dot" + (s.isOther ? " crm-legend-dot-rest" : "")
                }
                style={
                  s.isOther
                    ? undefined
                    : { background: PALETTE[i % PALETTE.length] }
                }
              />
              <span className="crm-kpi-popover-label" title={s.source}>
                {s.source}
              </span>
              <span className="crm-kpi-popover-count">
                {s.count} ({((s.count / total) * 100).toFixed(1)}%)
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Vertical funnel chart — one centered horizontal bar per stage, in
 * the funnel-order the lib emits. Each bar's width is the CUMULATIVE
 * count (this stage + all later stages), so the chart naturally
 * narrows from top (everyone passed through) to bottom (few made it
 * to close).
 *
 * Why cumulative: the current snapshot of `byStatus` shows leads at
 * each stage RIGHT NOW. To convert that into a funnel-shape, we treat
 * any lead currently at a later stage as having "reached" every prior
 * stage — same model the dashboard's pixel/CRM-leads aggregation
 * already uses. Caveat: early-funnel stages like טלפון / אינטרנט are
 * partially alternative (a phone lead doesn't pass through "אינטרנט"),
 * so the top of the funnel is slightly approximate. Past the early
 * stages it's exact: a lead currently at "פגישה 1" definitely went
 * through בטיפול / נקבעה פגישה first.
 *
 * Each row carries a native <title> tooltip showing both the
 * cumulative ("X leads at this stage or beyond") and the absolute
 * snapshot count ("of which Y currently sit at this stage exactly"),
 * so the user can read either lens.
 */
function FunnelChart({
  items,
  total,
}: {
  items: { label: string; count: number }[];
  total: number;
}) {
  const PALETTE = [
    "#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9",
    "#8b5cf6", "#ef4444", "#14b8a6",
  ];
  // Cumulative from the END: cum[i] = sum of counts from i to end.
  // First row gets the largest cumulative (matches "everyone passed
  // through ליד"), narrowing as we descend.
  const cumulative: number[] = new Array(items.length).fill(0);
  let acc = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    acc += items[i].count;
    cumulative[i] = acc;
  }
  // Reference width — typically the first row's cumulative. If for
  // some reason that's 0 (empty cohort), fall back to total → 1 to
  // avoid divide-by-zero on the percentage math below.
  const maxCum = cumulative[0] || total || 1;

  return (
    <div className="crm-funnel">
      {items.map((it, i) => {
        const cum = cumulative[i];
        const wPct = (cum / maxCum) * 100;
        const cumPct = (cum / total * 100).toFixed(1);
        const tooltip =
          `${it.label} — ${cum} (${cumPct}% מהלידים הגיעו לשלב הזה או מעבר)\n` +
          `מתוכם ${it.count} (${pct(it.count, total)}) נמצאים כעת בשלב הזה בדיוק`;
        return (
          <div
            key={it.label}
            className="crm-funnel-row"
            title={tooltip}
          >
            <span
              className="crm-funnel-bar"
              style={{
                width: `${wPct}%`,
                background: PALETTE[i % PALETTE.length],
              }}
            >
              <span className="crm-funnel-bar-label">{it.label}</span>
              <span className="crm-funnel-bar-count">{cum}</span>
            </span>
          </div>
        );
      })}
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

// Suppress unused-export warning for type re-import (kept for future
// callers that want to render funnel data without re-fetching).
export type { CrmFunnel };
