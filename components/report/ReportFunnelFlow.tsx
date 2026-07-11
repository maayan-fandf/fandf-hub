"use client";

import { channelIcon } from "@/lib/channelIcon";
import {
  convTone,
  costPerTone,
  deltaInfo,
  fmtInt,
  fmtILS,
  type ProjectReportData,
  type ReportChannel,
  type DeltaInfo,
} from "@/lib/reportShared";

/** Legacy _KPI_PIE_PALETTE_ (Index.html:6617) — the per-channel slice
 *  colors for the funnel-card breakdown popover. */
const KPI_PIE_PALETTE = [
  "#6366f1", "#f59e0b", "#10b981", "#ec4899", "#0ea5e9",
  "#a855f7", "#ef4444", "#14b8a6", "#eab308", "#8b5cf6",
  "#22c55e", "#f97316", "#06b6d4", "#d946ef", "#84cc16",
];

/**
 * Per-channel breakdown pie + legend, shown on hover over a funnel card —
 * port of the legacy `_buildKpiPiePopover_` (Index.html:6622). Slices are
 * each channel's share of the card's metric; the legend adds the
 * conversion-from-parent-stage rate (scheduled/leads, meetings/scheduled).
 */
function FunnelPie({
  channels,
  metricKey,
  parentKey,
  parentLabel,
  total,
}: {
  channels: ReportChannel[];
  metricKey: "leads" | "scheduled" | "meetings";
  parentKey: "leads" | "scheduled" | null;
  parentLabel: string;
  total: number;
}) {
  if (!channels.length || total <= 0) return null;
  const rows = channels
    .map((c) => ({
      channel: c.channel,
      count: Number(c[metricKey]) || 0,
      parent: parentKey ? Number(c[parentKey]) || 0 : 0,
    }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  if (!rows.length) return null;

  let cum = 0;
  const arcs: { d: string; fill: string; tip: string }[] = [];
  const legend: {
    fill: string;
    label: string;
    count: number;
    pct: string;
    conv: string | null;
  }[] = [];
  rows.forEach((r, i) => {
    const startFrac = cum;
    cum += r.count / total;
    const endFrac = Math.min(cum, 1);
    const frac = endFrac - startFrac;
    const fill = KPI_PIE_PALETTE[i % KPI_PIE_PALETTE.length];
    const pct = ((r.count / total) * 100).toFixed(1);
    const conv =
      parentKey && r.parent > 0
        ? `${((r.count / r.parent) * 100).toFixed(1)}%`
        : null;
    const label = `${channelIcon(r.channel) || "●"} ${r.channel}`.trim();
    if (frac >= 0.005) {
      const a0 = startFrac * 2 * Math.PI - Math.PI / 2;
      const a1 = endFrac * 2 * Math.PI - Math.PI / 2;
      const x0 = (50 + 50 * Math.cos(a0)).toFixed(2);
      const y0 = (50 + 50 * Math.sin(a0)).toFixed(2);
      const x1 = (50 + 50 * Math.cos(a1)).toFixed(2);
      const y1 = (50 + 50 * Math.sin(a1)).toFixed(2);
      const largeArc = frac > 0.5 ? 1 : 0;
      const tip =
        `${label} · ${r.count} (${pct}%)` +
        (conv ? ` · המרה מ${parentLabel}: ${conv}` : "");
      arcs.push({
        d: `M 50 50 L ${x0} ${y0} A 50 50 0 ${largeArc} 1 ${x1} ${y1} Z`,
        fill,
        tip,
      });
    }
    legend.push({ fill, label, count: r.count, pct, conv });
  });
  if (!arcs.length) return null;

  return (
    <div className="rpt-ff-pop" aria-hidden>
      <div className="rpt-ff-pop-head">
        לפי ערוץ{parentKey ? ` · עם המרה מ${parentLabel}` : ""}
      </div>
      <div className="rpt-ff-pop-body">
        <svg viewBox="0 0 100 100" className="rpt-ff-pop-svg">
          {arcs.map((a, i) => (
            <path key={i} d={a.d} fill={a.fill}>
              <title>{a.tip}</title>
            </path>
          ))}
        </svg>
        <ul className="rpt-ff-pop-legend">
          {legend.map((l, i) => (
            <li key={i}>
              <span className="rpt-ff-pop-dot" style={{ background: l.fill }} />
              <span className="rpt-ff-pop-ch" title={l.label}>
                {l.label}
              </span>
              <span className="rpt-ff-pop-count">
                {fmtInt(l.count)} ({l.pct}%)
              </span>
              {l.conv ? (
                <span
                  className="rpt-ff-pop-conv"
                  title={`המרה מ${parentLabel}`}
                >
                  ↑ {l.conv}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * CRM funnel flow — native rebuild of renderFunnelFlow (Index.html:6553),
 * the "ביצועים נוכחיים" section: לידים CRM → תיאומי פגישה → ביצועי פגישה
 * with a לידים רלוונטיים sub-node, conversion-rate connectors, cost-per
 * metas, and period-over-period delta badges. Connectors (exact legacy
 * pairs): relevant/leads (↓), scheduled/leads (card1→2), meetings/
 * scheduled (card2→3). Deltas vs prevFunnel, goodDir=up.
 */

function pct2(r: number | null): string {
  return r !== null ? `${(Math.round(r * 100 * 100) / 100).toString()}%` : "—";
}

function Delta({ d }: { d: DeltaInfo | null }) {
  if (!d) return null;
  if (d.cls === "new") return <span className="rpt-ff-delta is-new">חדש</span>;
  if (d.cls === "none" && d.text === "—")
    return <span className="rpt-ff-delta is-none">—</span>;
  const cls = d.cls === "good" ? "is-good" : d.cls === "bad" ? "is-bad" : "is-none";
  return (
    <span className={`rpt-ff-delta ${cls}`} title={`בתקופה הקודמת: ${fmtInt(d.prev)}`}>
      {d.arrow} {d.text}
    </span>
  );
}

function Arrow({ rate }: { rate: number | null }) {
  return (
    <div className="rpt-ff-arrow">
      <div className={`rpt-ff-rate is-${convTone(rate)}`}>{pct2(rate)}</div>
      <div className="rpt-ff-arrow-line">
        <span className="rpt-ff-arrow-head">←</span>
      </div>
    </div>
  );
}

export default function ReportFunnelFlow({ data }: { data: ProjectReportData }) {
  const t = data.totals;
  if (!t) return null;
  const leads = t.leads || 0;
  const rel = t.relevant || 0;
  const sched = t.scheduled || 0;
  const meet = t.meetings || 0;
  const cpl = leads > 0 ? t.spend / leads : 0;
  const cps = sched > 0 ? t.spend / sched : 0;
  const cpm = meet > 0 ? t.spend / meet : 0;
  const rRel = leads > 0 ? rel / leads : null;
  const rSched = leads > 0 ? sched / leads : null;
  const rMeet = sched > 0 ? meet / sched : null;
  const prev = data.prevFunnel;

  const monthLabel =
    data.mode === "month" ? data.window.startIso.slice(0, 7) : "";
  const title =
    data.mode === "month" ? `ביצועים בחודש ${monthLabel}` : "ביצועים נוכחיים";
  const ratioNote =
    prev && prev.ratioApplied < 1
      ? "הערכים של התקופה הקודמת הותאמו פרופורציונלית לפי יחס הימים, כדי להשוות תפוח לתפוח"
      : "";

  return (
    <section className="rpt-ff-section">
      <div className="rpt-ff-title">
        📊 {title}
        {ratioNote && (
          <span className="rpt-ff-note" title={ratioNote}>
            ↔ השוואה מותאמת ליחס ימים
          </span>
        )}
      </div>
      <div className="rpt-funnel-flow">
        {/* Card 1 — לידים CRM (+ relevant sub-node) */}
        <div className="rpt-ff-card is-lead">
          <div className="rpt-ff-label">לידים CRM</div>
          <div className="rpt-ff-value">{fmtInt(leads)}</div>
          <div className="rpt-ff-meta">
            עלות לליד: <b>{fmtILS(cpl)}</b>
          </div>
          <Delta d={prev ? deltaInfo(leads, prev.leads, "up") : null} />
          <div className="rpt-ff-sub">
            <div className="rpt-ff-sub-arrow">
              <span>↓</span>
              <span className={`rpt-ff-rate is-${convTone(rRel)}`}>{pct2(rRel)}</span>
            </div>
            <div className="rpt-ff-sub-card">
              <div className="rpt-ff-sub-label">לידים רלוונטיים</div>
              <div className="rpt-ff-sub-value">{fmtInt(rel)}</div>
            </div>
          </div>
          <FunnelPie
            channels={data.channels}
            metricKey="leads"
            parentKey={null}
            parentLabel="CRM"
            total={leads}
          />
        </div>

        <Arrow rate={rSched} />

        {/* Card 2 — תיאומי פגישה */}
        <div className={`rpt-ff-card is-sched rpt-ff-${costPerTone("costPerScheduled", cps)}`}>
          <div className="rpt-ff-label">תיאומי פגישה</div>
          <div className="rpt-ff-value">{fmtInt(sched)}</div>
          <div className="rpt-ff-meta">
            עלות לתיאום: <b>{fmtILS(cps)}</b>
          </div>
          <Delta d={prev ? deltaInfo(sched, prev.scheduled, "up") : null} />
          <FunnelPie
            channels={data.channels}
            metricKey="scheduled"
            parentKey="leads"
            parentLabel="לידים"
            total={sched}
          />
        </div>

        <Arrow rate={rMeet} />

        {/* Card 3 — ביצועי פגישה */}
        <div className={`rpt-ff-card is-meet rpt-ff-${costPerTone("costPerMeeting", cpm)}`}>
          <div className="rpt-ff-label">ביצועי פגישה</div>
          <div className="rpt-ff-value">{fmtInt(meet)}</div>
          <div className="rpt-ff-meta">
            עלות לביצוע: <b>{fmtILS(cpm)}</b>
          </div>
          <Delta d={prev ? deltaInfo(meet, prev.meetings, "up") : null} />
          <FunnelPie
            channels={data.channels}
            metricKey="meetings"
            parentKey="scheduled"
            parentLabel="תיאומי פגישה"
            total={meet}
          />
        </div>
      </div>
    </section>
  );
}
