import { getCrmFunnelForProject, type CrmFunnel } from "@/lib/crmData";

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
}: {
  company: string;
  project: string;
}) {
  const funnel = await getCrmFunnelForProject({ company, project }).catch(
    () => null,
  );
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
          <span className="crm-date-range" title="טווח התאריכים של הנתונים מהמקור">
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
