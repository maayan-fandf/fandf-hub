import { getCrmFunnelForProject, type CrmFunnel } from "@/lib/crmData";
import { channelIcon } from "@/lib/channelIcon";
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

      {/* Status funnel + objections × source — paired views, each 50%
          of the row. Both render as horizontal stacked bars showing the
          source mix per row; a unified legend underneath maps every
          source to a single color across BOTH blocks so the user can
          read either side without re-orienting. The redundant
          "התנגדויות מובילות" list (count + plain bar) was retired in
          this consolidation — the cross-tab matrix carries the same
          information plus the source breakdown.
          The source→color mapping is built ONCE across the union of
          sources seen in both blocks, ordered by total count desc, so
          high-volume channels always get the front-of-palette colors. */}
      {(funnel.byStatus.length > 0 || funnel.objectionsBySource.length > 0) && (() => {
        const PALETTE = [
          "#6366f1","#10b981","#f59e0b","#ec4899","#0ea5e9",
          "#8b5cf6","#14b8a6","#ef4444","#a3a3a3","#84cc16",
        ];
        // Union of sources from both blocks → total count → palette
        // assignment by frequency. "אחר" (isOther) skips palette and
        // renders via the hatched CSS pattern.
        const totals = new Map<string, { count: number; isOther: boolean }>();
        const accumulate = (
          rows: { sources: { source: string; count: number; isOther?: boolean }[] }[],
        ) => {
          for (const row of rows) {
            for (const s of row.sources) {
              const cur = totals.get(s.source);
              const isOther = !!s.isOther;
              if (cur) {
                cur.count += s.count;
                cur.isOther = cur.isOther && isOther;
              } else {
                totals.set(s.source, { count: s.count, isOther });
              }
            }
          }
        };
        accumulate(funnel.byStatus);
        accumulate(funnel.objectionsBySource);
        const ordered = [...totals.entries()]
          .sort((a, b) => {
            // "אחר" always last so it doesn't burn a palette color.
            if (a[1].isOther && !b[1].isOther) return 1;
            if (!a[1].isOther && b[1].isOther) return -1;
            return b[1].count - a[1].count;
          });
        const palette = new Map<string, { color: string; isOther: boolean }>();
        let pi = 0;
        for (const [source, { isOther }] of ordered) {
          palette.set(source, {
            color: isOther ? "" : PALETTE[pi++ % PALETTE.length],
            isOther,
          });
        }

        // The funnel chart uses cumulative widths (everyone-passed-here →
        // narrowing-tail), so the baseline is the first row's cumulative.
        const cumulative: number[] = new Array(funnel.byStatus.length).fill(0);
        let acc = 0;
        for (let i = funnel.byStatus.length - 1; i >= 0; i--) {
          acc += funnel.byStatus[i].count;
          cumulative[i] = acc;
        }
        const maxCum = cumulative[0] || funnel.leads || 1;

        // Objections-by-source uses absolute totals; first row is max.
        const maxObjTotal = funnel.objectionsBySource[0]?.total || 1;

        return (
          <>
            <div className="crm-objection-grid">
              {funnel.byStatus.length > 0 && (
                <div className="crm-block">
                  <div className="crm-block-title">משפך סטטוסים</div>
                  <ul className="crm-matrix">
                    {funnel.byStatus.map((row, i) => {
                      const cum = cumulative[i];
                      const wPct = (cum / maxCum) * 100;
                      const cumPct = (cum / funnel.leads * 100).toFixed(1);
                      const rowTooltip =
                        `${row.label} — ${cum} (${cumPct}% מהלידים הגיעו לשלב הזה או מעבר)\n` +
                        `מתוכם ${row.count} (${pct(row.count, funnel.leads)}) נמצאים כעת בשלב הזה בדיוק`;
                      return (
                        <li key={row.label} className="crm-matrix-row" title={rowTooltip}>
                          <span className="crm-matrix-label" title={row.label}>
                            {row.label}
                          </span>
                          <span
                            className="crm-matrix-bar"
                            style={{ width: `${wPct}%` }}
                          >
                            {row.sources.map((s) => {
                              const w = (s.count / row.count) * 100;
                              if (w < 0.5) return null;
                              const meta = palette.get(s.source);
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
                                  title={`${channelIcon(s.source)} ${s.source} — ${s.count} (${pct(s.count, row.count)})`.trim()}
                                />
                              );
                            })}
                          </span>
                          <span className="crm-matrix-total">{cum}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {funnel.objectionsBySource.length > 0 && (
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
                          style={{ width: `${(row.total / maxObjTotal) * 100}%` }}
                        >
                          {row.sources.map((s) => {
                            const w = (s.count / row.total) * 100;
                            if (w < 0.5) return null;
                            const meta = palette.get(s.source);
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

            {/* Unified legend — single row of source chips shared by
                both blocks above. Each chip carries the channel emoji
                from the dashboard's channelIcon map. */}
            <ul className="crm-matrix-legend crm-matrix-legend-shared">
              {[...palette.entries()].map(([source, meta]) => {
                const icon = meta.isOther ? "" : channelIcon(source);
                return (
                  <li key={source}>
                    <span
                      className={
                        "crm-legend-dot" + (meta.isOther ? " crm-legend-dot-rest" : "")
                      }
                      style={meta.isOther ? undefined : { background: meta.color }}
                    />
                    <span className="crm-legend-label" title={source}>
                      {icon ? `${icon} ` : ""}{source}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
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
