"use client";

import {
  sumAdPlatform,
  fmtInt,
  fmtPct2,
  type ProjectReportData,
} from "@/lib/reportShared";

/**
 * Conversion funnel — native rebuild of drawFunnel (Index.html:9594),
 * "משפך המרה — מלא (חשיפות → מכירות)": a horizontal bar per funnel stage
 * (חשיפות→קליקים→לידים→תיאומים→ביצועים→מכירות), each bar scaled to the
 * max stage (log-compressed when impressions>10K, matching the legacy
 * logScale gate) and annotated with the stage→stage conversion rate.
 * Impressions/clicks conditional on >0; sales conditional on >0.
 */

const STAGES = [
  { key: "impressions", label: "חשיפות", color: "#11998e" },
  { key: "clicks", label: "קליקים", color: "#38ef7d" },
  { key: "leads", label: "לידים", color: "#667eea" },
  { key: "scheduled", label: "תיאומים", color: "#f093fb" },
  { key: "meetings", label: "ביצועים", color: "#f5576c" },
  { key: "sales", label: "מכירות", color: "#1a1a2e" },
] as const;

function convColor(r: number): string {
  return r >= 0.5 ? "#2bb673" : r >= 0.1 ? "#f0ad4e" : "#d9534f";
}

export default function ReportConversionFunnel({
  data,
}: {
  data: ProjectReportData;
}) {
  const t = data.totals;
  if (!t) return null;
  const sm = sumAdPlatform(data.adPlatform);
  const values: Record<string, number> = {
    impressions: sm.impressions,
    clicks: sm.clicks,
    leads: t.leads,
    scheduled: t.scheduled,
    meetings: t.meetings,
    sales: t.sales,
  };
  const rows = STAGES.filter((s) => {
    if (s.key === "impressions") return sm.impressions > 0;
    if (s.key === "clicks") return sm.clicks > 0;
    if (s.key === "sales") return t.sales > 0;
    return true; // leads/scheduled/meetings always shown
  }).map((s) => ({ ...s, value: values[s.key] }));
  if (!rows.length) return null;

  // Log-compress bar widths when impressions dominate (legacy logScale
  // gate) so the small stages stay visible next to a 6-figure top.
  const useLog = sm.impressions > 10000;
  const scaleOf = (v: number) => (useLog ? Math.log10(Math.max(v, 1) + 1) : v);
  const maxScaled = Math.max(...rows.map((r) => scaleOf(r.value)), 1);
  const hasSm = sm.impressions > 0 || sm.clicks > 0;

  return (
    <section className="rpt-conv-funnel">
      <div className="rpt-cf-title">
        📊 משפך המרה{hasSm ? " — מלא (חשיפות → מכירות)" : ""}
      </div>
      <div className="rpt-cf-bars">
        {rows.map((r, i) => {
          const prev = i > 0 ? rows[i - 1] : null;
          const conv = prev && prev.value > 0 ? r.value / prev.value : null;
          const w = Math.max(2, (scaleOf(r.value) / maxScaled) * 100);
          return (
            <div key={r.key} className="rpt-cf-row">
              <div className="rpt-cf-label">{r.label}</div>
              <div className="rpt-cf-track">
                <div
                  className="rpt-cf-fill"
                  style={{ width: `${w}%`, background: r.color }}
                  title={`${r.label}: ${fmtInt(r.value)}${conv !== null ? ` · המרה מ־${prev!.label}: ${fmtPct2(conv)}` : ""}`}
                >
                  <span className="rpt-cf-val">{fmtInt(r.value)}</span>
                </div>
                {conv !== null && (
                  <span
                    className="rpt-cf-conv"
                    style={{ color: convColor(conv) }}
                    title={`יחס המרה מ־${prev!.label}`}
                  >
                    {fmtPct2(conv)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {useLog && <div className="rpt-cf-note">סקאלה לוגריתמית (חשיפות מעל 10K)</div>}
    </section>
  );
}
