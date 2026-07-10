"use client";

import {
  convTone,
  costPerTone,
  deltaInfo,
  fmtInt,
  fmtILS,
  type ProjectReportData,
  type DeltaInfo,
} from "@/lib/reportShared";

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
        </div>
      </div>
    </section>
  );
}
