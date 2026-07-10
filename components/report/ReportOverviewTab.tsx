"use client";

import type { ReactNode } from "react";
import {
  REPORT_PLATS,
  PLAT_LABELS,
  PLAT_PALETTES,
  PLAT_COLORS,
  sumAdPlatform,
  adLeadsOf,
  kpiAlert,
  deltaInfo,
  diagnoseTopFunnel,
  fmtInt,
  fmtILS,
  fmtPct2,
  fmtDateHe,
  type ProjectReportData,
  type ReportPlat,
  type PlatTotals,
} from "@/lib/reportShared";

/**
 * סקירה tab — the native rebuild of the legacy report's top-funnel
 * section (`renderTopFunnelSection`, Index.html:7983): KPI cards with
 * threshold framing + prev-window deltas, the CTR-vs-CVR funnel
 * diagnosis, and per-platform cards with campaign-share pies (the
 * platform shade palettes and slice rules of the legacy pie popovers).
 */

const MODE_LABELS = { live: "טווח הקמפיין", month: "חודש", range: "טווח מותאם" };

/** ₪ with agorot only when it matters (CPC-scale values). */
const fmtILS2 = (n: number): string =>
  n > 0 && n < 100 ? `₪${n.toFixed(2)}` : fmtILS(n);

function KpiCard({
  label,
  value,
  tone,
  delta,
  title,
}: {
  label: string;
  value: string;
  tone: string;
  delta: ReactNode;
  title?: string;
}) {
  return (
    <div className={`kpi-card rpt-kpi${tone ? ` rpt-kpi-${tone}` : ""}`} title={title}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {delta}
    </div>
  );
}

function Delta({
  current,
  previous,
  goodDir,
  format,
}: {
  current: number;
  previous: number | null;
  goodDir: "up" | "down" | "neutral";
  format: (n: number) => string;
}) {
  const d = deltaInfo(current, previous, goodDir);
  if (!d) return null;
  const cls =
    d.cls === "good" ? " is-good" : d.cls === "bad" ? " is-bad" : " is-flat";
  return (
    <div
      className={`kpi-delta${cls}`}
      title={`בתקופה הקודמת: ${format(d.prev)}`}
    >
      {d.arrow} {d.text}
    </div>
  );
}

/** SVG arc pie — starts at 12 o'clock, clockwise, biggest slice darkest
 *  shade, slices under 0.5% dropped (legacy `_buildAdPlatformPiePopover_`). */
function CampaignPie({
  slices,
  palette,
  size = 96,
}: {
  slices: { label: string; value: number }[];
  palette: string[];
  size?: number;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return null;
  const sorted = [...slices]
    .sort((a, b) => b.value - a.value)
    .filter((s) => s.value / total >= 0.005);
  const r = size / 2;
  if (sorted.length === 1) {
    return (
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden>
        <circle cx={r} cy={r} r={r} fill={palette[0]} />
      </svg>
    );
  }
  let angle = -90;
  const paths = sorted.map((s, i) => {
    const sweep = (s.value / total) * 360;
    const a0 = (angle * Math.PI) / 180;
    const a1 = ((angle + sweep) * Math.PI) / 180;
    angle += sweep;
    const x0 = r + r * Math.cos(a0);
    const y0 = r + r * Math.sin(a0);
    const x1 = r + r * Math.cos(a1);
    const y1 = r + r * Math.sin(a1);
    const large = sweep > 180 ? 1 : 0;
    return (
      <path
        key={i}
        d={`M ${r} ${r} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`}
        fill={palette[i % palette.length]}
      >
        <title>{`${s.label}: ${fmtILS(s.value)}`}</title>
      </path>
    );
  });
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden>
      {paths}
    </svg>
  );
}

function PlatCard({ plat, totals }: { plat: ReportPlat; totals: PlatTotals }) {
  const leads = plat === "google" ? totals.conversions : totals.leads;
  const ctr = totals.impressions > 0 ? totals.clicks / totals.impressions : 0;
  const cpc = totals.clicks > 0 ? totals.cost / totals.clicks : 0;
  const c2l = totals.clicks > 0 ? Math.min(leads / totals.clicks, 1) : 0;
  const cpl = leads > 0 ? totals.cost / leads : 0;
  const slices = totals.campaigns
    .map((c) => ({ label: c.name, value: c.cost }))
    .filter((s) => s.value > 0);
  const legend = [...slices].sort((a, b) => b.value - a.value).slice(0, 5);
  const more = slices.length - legend.length;
  const palette = PLAT_PALETTES[plat];
  return (
    <div className="rpt-plat-card">
      <div className="rpt-plat-head">
        <span className="rpt-plat-dot" style={{ background: PLAT_COLORS[plat] }} />
        <span className="rpt-plat-name">{PLAT_LABELS[plat]}</span>
        <span className="rpt-plat-cost">{fmtILS(totals.cost)}</span>
      </div>
      <div className="rpt-plat-body">
        <div className="rpt-plat-stats">
          <div className="rpt-stat">
            <span className="rpt-stat-l">חשיפות</span>
            <span className="rpt-stat-v">{fmtInt(totals.impressions)}</span>
          </div>
          <div className="rpt-stat">
            <span className="rpt-stat-l">קליקים</span>
            <span className="rpt-stat-v">{fmtInt(totals.clicks)}</span>
          </div>
          <div className="rpt-stat">
            <span className="rpt-stat-l">CTR</span>
            <span className="rpt-stat-v">{fmtPct2(ctr)}</span>
          </div>
          <div className="rpt-stat">
            <span className="rpt-stat-l">CPC</span>
            <span className="rpt-stat-v">{fmtILS2(cpc)}</span>
          </div>
          <div className="rpt-stat">
            <span className="rpt-stat-l">{plat === "google" ? "המרות" : "לידים"}</span>
            <span className="rpt-stat-v">{fmtInt(leads)}</span>
          </div>
          <div className="rpt-stat">
            <span className="rpt-stat-l">קליק→ליד</span>
            <span className="rpt-stat-v">{fmtPct2(c2l)}</span>
          </div>
          {cpl > 0 && (
            <div className="rpt-stat">
              <span className="rpt-stat-l">עלות לליד</span>
              <span className="rpt-stat-v">{fmtILS(cpl)}</span>
            </div>
          )}
        </div>
        {slices.length > 0 && (
          <div className="rpt-pie-wrap">
            <CampaignPie slices={slices} palette={palette} />
            <ul className="rpt-pie-legend">
              {legend.map((s, i) => (
                <li key={s.label}>
                  <span
                    className="rpt-pie-dot"
                    style={{ background: palette[i % palette.length] }}
                  />
                  <span className="rpt-pie-label" title={s.label}>
                    {s.label}
                  </span>
                </li>
              ))}
              {more > 0 && <li className="rpt-pie-more">+{more} נוספים</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ReportOverviewTab({ data }: { data: ProjectReportData }) {
  const ap = data.adPlatform;
  const sm = sumAdPlatform(ap);
  const prevSm = data.prevAdPlatform ? sumAdPlatform(data.prevAdPlatform) : null;
  const hasSm = sm.impressions > 0 || sm.clicks > 0;

  const adLeads = adLeadsOf(sm);
  const clickToLead = sm.clicks > 0 ? Math.min(adLeads / sm.clicks, 1) : 0;
  const impToLead = sm.impressions > 0 ? Math.min(adLeads / sm.impressions, 1) : 0;
  const ctx = {
    impressions: sm.impressions,
    clicks: sm.clicks,
    fbCost: ap.facebook.cost,
    googleCost: ap.google.cost,
  };

  const dx = diagnoseTopFunnel(sm, prevSm, ap, data.prevAdPlatform);
  const activePlats = REPORT_PLATS.filter(
    (p) => ap[p].cost > 0 || ap[p].impressions > 0,
  );

  if (!hasSm) {
    return (
      <div className="rpt-empty">
        אין נתוני פלטפורמות בטווח הזה ({fmtDateHe(data.window.startIso)} —{" "}
        {fmtDateHe(data.window.endIso)}).
      </div>
    );
  }

  return (
    <div className="rpt-overview">
      <div className="rpt-window-line">
        <span className="rpt-window-chip">{MODE_LABELS[data.mode]}</span>
        <span>
          📅 {fmtDateHe(data.window.startIso)} — {fmtDateHe(data.window.endIso)}
        </span>
        {data.prevWindow && (
          <span className="rpt-window-prev">
            ↔ השוואה לתקופה קודמת ({fmtDateHe(data.prevWindow.startIso)} —{" "}
            {fmtDateHe(data.prevWindow.endIso)})
          </span>
        )}
      </div>

      <div className="kpi-band rpt-kpi-band">
        <KpiCard
          label="חשיפות"
          value={fmtInt(sm.impressions)}
          tone=""
          delta={
            <Delta current={sm.impressions} previous={prevSm?.impressions ?? null} goodDir="up" format={fmtInt} />
          }
        />
        <KpiCard
          label="קליקים"
          value={fmtInt(sm.clicks)}
          tone=""
          delta={
            <Delta current={sm.clicks} previous={prevSm?.clicks ?? null} goodDir="up" format={fmtInt} />
          }
        />
        <KpiCard
          label="CTR"
          value={fmtPct2(sm.ctr)}
          tone={kpiAlert("ctr", sm.ctr, ctx)}
          delta={
            <Delta current={sm.ctr} previous={prevSm?.ctr ?? null} goodDir="up" format={fmtPct2} />
          }
        />
        <KpiCard
          label="CPC ממוצע"
          value={fmtILS2(sm.cpc)}
          tone=""
          delta={
            <Delta current={sm.cpc} previous={prevSm?.cpc ?? null} goodDir="down" format={fmtILS2} />
          }
        />
        <KpiCard
          label="המרות (Google)"
          value={fmtInt(sm.conversions)}
          tone={kpiAlert("conversions", sm.conversions, ctx)}
          delta={
            <Delta current={sm.conversions} previous={prevSm?.conversions ?? null} goodDir="up" format={fmtInt} />
          }
        />
        <KpiCard
          label="לידים (Facebook)"
          value={fmtInt(sm.fbLeads)}
          tone={kpiAlert("fbLeads", sm.fbLeads, ctx)}
          delta={
            <Delta current={sm.fbLeads} previous={prevSm?.fbLeads ?? null} goodDir="up" format={fmtInt} />
          }
        />
        {ap.taboola.leads > 0 && (
          <KpiCard
            label="לידים (Taboola)"
            value={fmtInt(ap.taboola.leads)}
            tone=""
            delta={
              <Delta
                current={ap.taboola.leads}
                previous={data.prevAdPlatform ? data.prevAdPlatform.taboola.leads : null}
                goodDir="up"
                format={fmtInt}
              />
            }
          />
        )}
        {ap.outbrain.leads > 0 && (
          <KpiCard
            label="לידים (Outbrain)"
            value={fmtInt(ap.outbrain.leads)}
            tone=""
            delta={
              <Delta
                current={ap.outbrain.leads}
                previous={data.prevAdPlatform ? data.prevAdPlatform.outbrain.leads : null}
                goodDir="up"
                format={fmtInt}
              />
            }
          />
        )}
        <KpiCard
          label="קליק → ליד"
          value={fmtPct2(clickToLead)}
          tone={kpiAlert("clickToLead", clickToLead, ctx)}
          delta={null}
          title="לידים משויכי-מודעות בלבד (FB + המרות Google + Taboola/Outbrain) חלקי קליקים"
        />
        <KpiCard
          label="חשיפה → ליד"
          value={fmtPct2(impToLead)}
          tone={kpiAlert("impToLead", impToLead, ctx)}
          delta={null}
        />
      </div>

      {dx && (
        <div className={`rpt-dx rpt-dx-${dx.kind}`}>
          <div className="rpt-dx-head">🔬 איבחון משפך — מודעות מול אתר</div>
          {dx.kind !== "nodata" && (
            <div className="rpt-dx-rates">
              <span>
                CTR (מודעה) <b>{fmtPct2(dx.ctrNow)}</b>{" "}
                <span className={`rpt-dx-${dx.ctrState}`}>
                  {dx.ctrState === "down" ? "▼" : dx.ctrState === "up" ? "▲" : "•"}{" "}
                  {(dx.ctrDelta >= 0 ? "+" : "") + (dx.ctrDelta * 100).toFixed(0)}%
                </span>
              </span>
              <span>
                CVR קליק→ליד (אתר) <b>{fmtPct2(dx.cvrNow)}</b>{" "}
                <span className={`rpt-dx-${dx.cvrState}`}>
                  {dx.cvrState === "down" ? "▼" : dx.cvrState === "up" ? "▲" : "•"}{" "}
                  {(dx.cvrDelta >= 0 ? "+" : "") + (dx.cvrDelta * 100).toFixed(0)}%
                </span>
              </span>
            </div>
          )}
          <div
            className="rpt-dx-verdict"
            // Self-authored strings from lib/reportShared (only <b> tags +
            // platform labels) — not user content.
            dangerouslySetInnerHTML={{ __html: `${dx.icon} ${dx.verdictHtml}` }}
          />
          {dx.integrity.length > 0 && (
            <div className="rpt-dx-warn">
              ⚠️ ייתכן חוסר בנתוני קליקים ב-{dx.integrity.join(", ")} — בדקו
              מעקב/Supermetrics (משפיע על האיבחון).
            </div>
          )}
        </div>
      )}

      <div className="rpt-plat-grid">
        {activePlats.map((p) => (
          <PlatCard key={p} plat={p} totals={ap[p]} />
        ))}
      </div>
    </div>
  );
}
