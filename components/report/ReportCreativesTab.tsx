"use client";

import { useState } from "react";
import ReportMediaSection, {
  PlatformKpiBand,
} from "@/components/report/ReportMediaSection";
import {
  fbStatusInfo,
  fmtInt,
  fmtILS,
  fmtPct2,
  fmtDateHe,
  type ProjectReportData,
  type ReportAdDaily,
  type ReportFbAd,
} from "@/lib/reportShared";

/**
 * קריאייטיבים tab — native rebuild of the legacy 🎨 creatives section
 * (renderCreativeSection, Index.html:7630): FB KPI strip, ad-card grid
 * (image→thumb→placeholder fallback chain, status pills, 🏆 winner,
 * fatigue badges, ad copy, CRM meetings row, hover trendline), ad-set
 * list, Google RSA assets by campaign, and the top-keywords table.
 */

/** image → thumb → placeholder chain. fbcdn URLs are signed and expire,
 *  and cdninstagram frequently 403s on hotlink — the onError fallback is
 *  load-bearing (legacy v562/v563). */
function FbAdImage({ ad }: { ad: ReportFbAd }) {
  const primary = ad.image || ad.thumb;
  const fallback = ad.thumb && ad.thumb !== primary ? ad.thumb : "";
  const [src, setSrc] = useState(primary);
  const [dead, setDead] = useState(!primary);
  if (dead) return <div className="rpt-cr-noimg">📷 אין תצוגה</div>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={ad.ad}
      loading="lazy"
      onError={() => {
        if (fallback && src !== fallback) setSrc(fallback);
        else setDead(true);
      }}
    />
  );
}

/** Hover trendline (legacy _buildAdTrendlinePopover_): dense calendar
 *  days over the report window clamped to the last date with data; two
 *  sparklines — cost #14b8a6, leads #8b5cf6. */
function AdTrend({
  title,
  daily,
  window,
}: {
  title: string;
  daily: ReportAdDaily[];
  window: { startIso: string; endIso: string };
}) {
  if (!daily.length) return null;
  const dataLast = daily[daily.length - 1].date;
  const from = window.startIso || daily[0].date;
  const to = window.endIso && window.endIso < dataLast ? window.endIso : dataLast;
  if (!from || !to || from > to) return null;
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const days: ReportAdDaily[] = [];
  let d = from;
  let guard = 0;
  while (d <= to && guard++ < 400) {
    days.push(byDate.get(d) ?? { date: d, cost: 0, leads: 0 });
    const [y, m, dd] = d.split("-").map(Number);
    const nx = new Date(Date.UTC(y, m - 1, dd + 1));
    d = nx.toISOString().slice(0, 10);
  }
  if (days.length < 2) return null;
  const W = 240;
  const H = 42;
  const PAD = 2;
  const line = (get: (p: ReportAdDaily) => number) => {
    const max = Math.max(...days.map(get), 1);
    return days
      .map((p, i) => {
        const x = PAD + (i / (days.length - 1)) * (W - PAD * 2);
        const y = H - PAD - (get(p) / max) * (H - PAD * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };
  const totalCost = days.reduce((s, p) => s + p.cost, 0);
  const totalLeads = days.reduce((s, p) => s + p.leads, 0);
  return (
    <div className="rpt-cr-trend" aria-hidden>
      <div className="rpt-cr-trend-head">
        {title} · {fmtDateHe(from).slice(0, 5)} → {fmtDateHe(to).slice(0, 5)}
      </div>
      <div className="rpt-cr-trend-row">
        <span style={{ color: "#14b8a6" }}>{fmtILS(totalCost)}</span>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
          <polyline points={line((p) => p.cost)} fill="none" stroke="#14b8a6" strokeWidth={1.6} />
        </svg>
      </div>
      <div className="rpt-cr-trend-row">
        <span style={{ color: "#8b5cf6" }}>{fmtInt(totalLeads)} לידים</span>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
          <polyline points={line((p) => p.leads)} fill="none" stroke="#8b5cf6" strokeWidth={1.6} />
        </svg>
      </div>
    </div>
  );
}

function CrmRow({
  crmLeads,
  scheduled,
  held,
  costPerSched,
  costPerHeld,
}: {
  crmLeads: number;
  scheduled: number;
  held: number;
  costPerSched: number;
  costPerHeld: number;
}) {
  if (!crmLeads && !scheduled && !held) return null;
  return (
    <div
      className="rpt-cr-stats rpt-cr-stats-crm"
      title="לידים, תואמו ובוצעו מה-CRM שמקורם בקריאייטיב זה — כולל עלות לתיאום ולביצוע"
    >
      <div className="rpt-cr-stat">
        <span className="rpt-cr-stat-l">לידים</span>
        <span className="rpt-cr-stat-v" style={{ color: "#6366f1" }}>
          {fmtInt(crmLeads)}
        </span>
      </div>
      <div className="rpt-cr-stat">
        <span className="rpt-cr-stat-l">תואמו</span>
        <span className="rpt-cr-stat-v" style={{ color: "#ec4899" }}>
          {fmtInt(scheduled)}
          {costPerSched > 0 ? ` · ${fmtILS(costPerSched)}` : ""}
        </span>
      </div>
      <div className="rpt-cr-stat">
        <span className="rpt-cr-stat-l">בוצעו</span>
        <span className="rpt-cr-stat-v" style={{ color: "#f5576c" }}>
          {fmtInt(held)}
          {costPerHeld > 0 ? ` · ${fmtILS(costPerHeld)}` : ""}
        </span>
      </div>
    </div>
  );
}

export default function ReportCreativesTab({
  data,
}: {
  data: ProjectReportData;
}) {
  const c = data.creatives;
  if (!c) {
    return (
      <div className="rpt-creatives">
        <ReportMediaSection data={data} />
        <div className="rpt-empty">
          אין נתוני קריאייטיבים לפרויקט בתקופה הזו (חשבון הפרסום אינו ברשימת
          ה-Supermetrics, או שאין פעילות בטווח).
        </div>
      </div>
    );
  }
  const { fb, google } = c;
  const ap = data.adPlatform;
  const prevAp = data.prevAdPlatform;
  const googleActiveAds = google.ads.filter(
    (a) => a.status === "Enabled",
  ).length;

  return (
    <div className="rpt-creatives">
      <ReportMediaSection data={data} />
      {/* Facebook funnel summary — the rich per-platform band (impressions →
          clicks → CTR/CPC → לידים → CPL + rates, with prev-window deltas),
          replacing the old flat FB strip. */}
      <PlatformKpiBand
        plat="facebook"
        totals={ap.facebook}
        prev={prevAp?.facebook ?? null}
        activeAds={fb.adCount}
      />

      {fb.topAds.length > 0 && (
        <>
          <h3 className="rpt-cr-title">🎨 מודעות פייסבוק</h3>
          <div className="rpt-cr-grid">
            {fb.topAds.map((a) => {
              const status = fbStatusInfo(a.status);
              const isActive = String(a.status).toUpperCase().trim() === "ACTIVE";
              const landing = a.destUrl || a.url || "";
              return (
                <div
                  key={`${a.campaign}|${a.ad}`}
                  className={
                    "rpt-cr-card" +
                    (a.isWinner ? " is-winner" : "") +
                    (a.fatigued ? " is-fatigued" : "") +
                    (isActive ? "" : " is-paused")
                  }
                >
                  {a.isWinner && (
                    <div className="rpt-cr-badge rpt-cr-badge-win">🏆 הכי משתלם</div>
                  )}
                  {a.fatigued && a.fatigueReason === "declining" && (
                    <div
                      className="rpt-cr-badge rpt-cr-badge-fatigue"
                      title={`CTR ירד מ-${fmtPct2(a.ctrEarly)} ל-${fmtPct2(a.ctrRecent)} — המודעה פעילה ${a.ageDays} ימים`}
                    >
                      ⚠️ CTR יורד
                    </div>
                  )}
                  {a.fatigued && a.fatigueReason === "long" && (
                    <div
                      className="rpt-cr-badge rpt-cr-badge-fatigue"
                      title={`המודעה פעילה ${a.ageDays} ימים`}
                    >
                      ⏳ שקלו לרענן
                    </div>
                  )}
                  <div className="rpt-cr-thumb">
                    {landing ? (
                      <a href={landing} target="_blank" rel="noopener noreferrer">
                        <FbAdImage ad={a} />
                      </a>
                    ) : (
                      <FbAdImage ad={a} />
                    )}
                    {status.label && (
                      <span
                        className={`rpt-cr-status is-${status.cls}`}
                        title={a.status}
                      >
                        {status.label}
                      </span>
                    )}
                  </div>
                  <div className="rpt-cr-body">
                    <div className="rpt-cr-name" title={a.ad}>
                      {a.ad}
                    </div>
                    <div className="rpt-cr-campaign" title={a.campaign}>
                      {a.campaign}
                    </div>
                    {a.title && (
                      <div className="rpt-cr-adtitle" title={a.title}>
                        {a.title}
                      </div>
                    )}
                    {!a.fatigued && a.ageDays >= 14 && (
                      <div
                        className="rpt-cr-age"
                        title={`מודעה פעילה ${a.ageDays} ימים`}
                      >
                        📅 {a.ageDays} ימים
                      </div>
                    )}
                    {a.body && (
                      <details className="rpt-cr-copy">
                        <summary>📝 טקסט המודעה</summary>
                        <div className="rpt-cr-copy-text">{a.body}</div>
                      </details>
                    )}
                    <div className="rpt-cr-stats">
                      <div className="rpt-cr-stat">
                        <span className="rpt-cr-stat-l">עלות</span>
                        <span className="rpt-cr-stat-v">{fmtILS(a.cost)}</span>
                      </div>
                      <div className="rpt-cr-stat">
                        <span className="rpt-cr-stat-l">לידים</span>
                        <span className="rpt-cr-stat-v">{fmtInt(a.leads)}</span>
                      </div>
                      <div className="rpt-cr-stat">
                        <span className="rpt-cr-stat-l">CPL</span>
                        <span className="rpt-cr-stat-v">
                          {a.cpl > 0 ? fmtILS(a.cpl) : "—"}
                        </span>
                      </div>
                    </div>
                    {(a.impressions > 0 || a.clicks > 0) && (
                      <div className="rpt-cr-stats rpt-cr-stats-sec">
                        <div className="rpt-cr-stat">
                          <span className="rpt-cr-stat-l">חשיפות</span>
                          <span className="rpt-cr-stat-v">{fmtInt(a.impressions)}</span>
                        </div>
                        <div className="rpt-cr-stat">
                          <span className="rpt-cr-stat-l">קליקים</span>
                          <span className="rpt-cr-stat-v">{fmtInt(a.clicks)}</span>
                        </div>
                        <div className="rpt-cr-stat">
                          <span className="rpt-cr-stat-l">CTR</span>
                          <span className="rpt-cr-stat-v">
                            {a.ctr > 0 ? fmtPct2(a.ctr) : "—"}
                          </span>
                        </div>
                      </div>
                    )}
                    <CrmRow
                      crmLeads={a.crmLeads}
                      scheduled={a.scheduled}
                      held={a.held}
                      costPerSched={a.costPerSched}
                      costPerHeld={a.costPerHeld}
                    />
                  </div>
                  <div className="rpt-cr-links">
                    {landing && (
                      <a href={landing} target="_blank" rel="noopener noreferrer">
                        🔗 דף נחיתה
                      </a>
                    )}
                    {a.url && (
                      <a href={a.url} target="_blank" rel="noopener noreferrer">
                        👁️ תצוגת מודעה
                      </a>
                    )}
                  </div>
                  <AdTrend title={a.ad} daily={a.daily} window={data.window} />
                </div>
              );
            })}
          </div>
        </>
      )}

      {fb.topAdSets.length > 0 && (
        <>
          <h3 className="rpt-cr-title">🎯 קהלים (Ad Sets) — לפי עלות לליד</h3>
          <div className="rpt-cr-adsets">
            {fb.topAdSets.map((s, i) => (
              <div
                key={s.name}
                className={
                  "rpt-cr-adset" + (i === 0 && s.cpl > 0 ? " is-winner" : "")
                }
              >
                <div className="rpt-cr-adset-name">
                  {i === 0 && s.cpl > 0 ? "🏆 " : ""}
                  {s.name}
                </div>
                <div className="rpt-cr-adset-stats">
                  <span>
                    עלות: <b>{fmtILS(s.cost)}</b>
                  </span>
                  <span>
                    לידים: <b>{fmtInt(s.leads)}</b>
                  </span>
                  <span>
                    CPL: <b>{s.cpl > 0 ? fmtILS(s.cpl) : "—"}</b>
                  </span>
                </div>
                {(s.crmLeads > 0 || s.scheduled > 0 || s.held > 0) && (
                  <div
                    className="rpt-cr-adset-stats rpt-cr-adset-crm"
                    title="לידים, תואמו ובוצעו מה-CRM מקהל זה"
                  >
                    <span style={{ color: "#6366f1" }}>
                      לידים: <b>{fmtInt(s.crmLeads)}</b>
                    </span>
                    <span style={{ color: "#ec4899" }}>
                      תואמו: <b>{fmtInt(s.scheduled)}</b>
                      {s.costPerSched > 0 ? ` (${fmtILS(s.costPerSched)})` : ""}
                    </span>
                    <span style={{ color: "#f5576c" }}>
                      בוצעו: <b>{fmtInt(s.held)}</b>
                      {s.costPerHeld > 0 ? ` (${fmtILS(s.costPerHeld)})` : ""}
                    </span>
                  </div>
                )}
                <AdTrend title={s.name} daily={s.daily} window={data.window} />
              </div>
            ))}
          </div>
        </>
      )}

      {/* Google funnel summary — same band, scoped to Google (המרות /
          קליק→המרה / חשיפה→המרה), heading the Google Ads detail. */}
      <PlatformKpiBand
        plat="google"
        totals={ap.google}
        prev={prevAp?.google ?? null}
        activeAds={googleActiveAds}
      />

      {google.ads.length > 0 && <GoogleAdsBlock ads={google.ads} />}

      {google.topKeywords.length > 0 && (
        <>
          <h3 className="rpt-cr-title">🔍 מילות חיפוש מובילות — Google</h3>
          <div className="rpt-ch-table-wrap">
            <table className="rpt-ch-table">
              <thead>
                <tr>
                  <th>מילת חיפוש</th>
                  <th>חשיפות</th>
                  <th>קליקים</th>
                  <th>המרות</th>
                  <th>תיאומים</th>
                  <th>ביצועים</th>
                </tr>
              </thead>
              <tbody>
                {google.topKeywords.map((k) => (
                  <tr key={k.keyword}>
                    <td className="rpt-cr-kw">{k.keyword}</td>
                    <td>{fmtInt(k.impressions)}</td>
                    <td>{fmtInt(k.clicks)}</td>
                    <td>{fmtInt(k.conversions)}</td>
                    <td style={{ color: "#ec4899" }}>{fmtInt(k.scheduled)}</td>
                    <td style={{ color: "#f5576c" }}>{fmtInt(k.held)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function GoogleAdsBlock({
  ads,
}: {
  ads: NonNullable<ProjectReportData["creatives"]>["google"]["ads"];
}) {
  // Group by campaign, order groups by total impressions desc (legacy).
  const byCamp = new Map<string, typeof ads>();
  for (const a of ads) {
    const k = a.campaign || "—";
    const arr = byCamp.get(k) ?? [];
    arr.push(a);
    byCamp.set(k, arr);
  }
  const groups = [...byCamp.entries()].sort((x, y) => {
    const xi = x[1].reduce((s, a) => s + a.impressions, 0);
    const yi = y[1].reduce((s, a) => s + a.impressions, 0);
    return yi - xi;
  });
  return (
    <>
      <h3 className="rpt-cr-title">📝 מודעות Google Ads — לפי קמפיין</h3>
      <div className="rpt-cr-gcamps">
        {groups.map(([camp, list]) => {
          const totalImp = list.reduce((s, a) => s + a.impressions, 0);
          return (
            <div key={camp} className="rpt-cr-gcamp">
              <div className="rpt-cr-gcamp-head">
                <span className="rpt-cr-gcamp-name" title={camp}>
                  {camp}
                </span>
                <span className="rpt-cr-gcamp-meta">
                  {list.length} מודעות · {fmtInt(totalImp)} חשיפות
                </span>
              </div>
              {list.map((a, i) => (
                <div key={i} className="rpt-cr-gad">
                  <div className="rpt-cr-gad-row">
                    <span
                      className={
                        "rpt-cr-gad-status" +
                        (a.status === "Enabled" ? " is-on" : " is-off")
                      }
                    >
                      {a.status || "—"}
                    </span>
                    <span>{fmtInt(a.impressions)} חשיפות</span>
                    {a.finalUrl && (
                      <a href={a.finalUrl} target="_blank" rel="noopener noreferrer">
                        🔗 דף נחיתה
                      </a>
                    )}
                  </div>
                  {a.headlines.length > 0 && (
                    <div className="rpt-cr-gad-assets">
                      <span className="rpt-cr-gad-label">כותרות</span>
                      <div className="rpt-cr-pills">
                        {a.headlines.map((t, j) => (
                          <span key={j} className="rpt-cr-pill">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {a.descriptions.length > 0 && (
                    <div className="rpt-cr-gad-assets">
                      <span className="rpt-cr-gad-label">תיאורים</span>
                      <div className="rpt-cr-pills">
                        {a.descriptions.map((t, j) => (
                          <span key={j} className="rpt-cr-pill is-desc">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
