import { getCrmFunnelForProject, type CrmFunnel } from "@/lib/crmData";
import CrmSourcePieSection from "./CrmSourcePieSection";

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
              title="מסונן לחודש שנבחר במטריקות (משויך לבחירה למעלה)"
            >
              מסונן: {funnel.monthFilter}
            </span>
          ) : null}
          <span className="crm-date-range" title="טווח התאריכים של הנתונים בקבוצה המסוננת">
            {funnel.dateRange.from} → {funnel.dateRange.to}
          </span>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="crm-kpi-row">
        <KpiTile label="לידים" value={fmtInt(funnel.leads)} />
        <KpiTile
          label="נוצר קשר"
          value={fmtInt(funnel.contacted)}
          sub={pct(funnel.contacted, funnel.leads)}
        />
        <KpiTile
          label="פגישות"
          value={fmtInt(funnel.meetings)}
          sub={pct(funnel.meetings, funnel.leads)}
        />
        <KpiTile
          label="יחס פגישה"
          value={funnel.meetingRatePct == null ? "—" : `${funnel.meetingRatePct.toFixed(1)}%`}
        />
      </div>

      {/* Status breakdown — top buckets only. The CRM has dozens of
          status values; showing more than ~8 turns into noise. */}
      {funnel.byStatus.length > 0 && (
        <div className="crm-block">
          <div className="crm-block-title">סטטוסים</div>
          <StackedBar items={funnel.byStatus} total={funnel.leads} />
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

      {/* Per-source pie (transposed view of the same matrix). Pickable
          via chip row so only one pie shows at a time — projects with
          5-8 sources would otherwise fill the screen with redundant
          donuts. Client component because the chip-picker has local
          UI state. */}
      {funnel.sourceBreakdown.length > 0 && (
        <CrmSourcePieSection breakdown={funnel.sourceBreakdown} />
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
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="crm-kpi-tile">
      <div className="crm-kpi-value">{value}</div>
      <div className="crm-kpi-label">{label}</div>
      {sub ? <div className="crm-kpi-sub">{sub}</div> : null}
    </div>
  );
}

function StackedBar({
  items,
  total,
}: {
  items: { label: string; count: number }[];
  total: number;
}) {
  // Render as a single horizontal bar split into status-colored segments,
  // followed by a legend underneath. Visible-segment color is rotated
  // through a small accent palette so adjacent segments don't blur.
  const PALETTE = ["#6366f1", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9", "#8b5cf6", "#ef4444", "#14b8a6"];
  const sumShown = items.reduce((n, x) => n + x.count, 0);
  const rest = Math.max(0, total - sumShown);
  return (
    <div className="crm-stacked">
      <div className="crm-stacked-bar">
        {items.map((it, i) => {
          const w = (it.count / total) * 100;
          if (w < 0.5) return null;
          return (
            <span
              key={it.label}
              className="crm-stacked-seg"
              style={{ width: `${w}%`, background: PALETTE[i % PALETTE.length] }}
              title={`${it.label} — ${it.count} (${pct(it.count, total)})`}
            />
          );
        })}
        {rest > 0 && (
          <span
            className="crm-stacked-seg crm-stacked-seg-rest"
            style={{ width: `${(rest / total) * 100}%` }}
            title={`אחר — ${rest} (${pct(rest, total)})`}
          />
        )}
      </div>
      <ul className="crm-stacked-legend">
        {items.map((it, i) => (
          <li key={it.label}>
            <span
              className="crm-legend-dot"
              style={{ background: PALETTE[i % PALETTE.length] }}
            />
            <span className="crm-legend-label" title={it.label}>{it.label}</span>
            <span className="crm-legend-count">
              {it.count} ({pct(it.count, total)})
            </span>
          </li>
        ))}
        {rest > 0 && (
          <li>
            <span className="crm-legend-dot crm-legend-dot-rest" />
            <span className="crm-legend-label">אחר</span>
            <span className="crm-legend-count">
              {rest} ({pct(rest, total)})
            </span>
          </li>
        )}
      </ul>
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
