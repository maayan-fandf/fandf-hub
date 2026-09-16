"use client";

import { useState } from "react";
import SignedClientsPanel from "@/components/report/SignedClientsPanel";
import { BasisDash, type BasisDashReason } from "@/components/report/BasisBadge";
import { useMeetingBasis } from "@/components/report/MeetingBasisContext";
import { BASIS_LABELS } from "@/lib/meetingBasis";
import {
  sumAdPlatform,
  fmtInt,
  fmtPct2,
  totalsForBasis,
  type ProjectReportData,
} from "@/lib/reportShared";

/**
 * Conversion funnel — native rebuild of drawFunnel (Index.html:9594),
 * "משפך המרה — מלא (חשיפות → מכירות)": a horizontal bar per funnel stage
 * (חשיפות→קליקים→לידים→תיאומים→ביצועים→מכירות), each bar scaled to the
 * max stage (log-compressed when impressions>10K, matching the legacy
 * logScale gate) and annotated with the stage→stage conversion rate.
 * Impressions/clicks conditional on >0; sales conditional on >0.
 *
 * MEETING BASIS (page-level switch, lib/meetingBasis). Only the תיאומים and
 * ביצועים bars have one; חשיפות / קליקים / לידים / מכירות are the same on
 * both settings.
 *
 *   לפי כניסת ליד   — data.totals, as before the switch existed.
 *   לפי מועד הפגישה — data.datedTotals, the same pair the funnel-flow cards
 *                     above show (Σ ערוצים dated rows + unattributed), so
 *                     the two overview blocks can never disagree.
 *
 * Under dated the two stage rates that would divide one basis by the other
 * print an explained "—" (BasisDash cross-basis) instead of a percentage:
 * לידים→תיאומים (dated meetings over leads-by-entry — it can pass 100% in
 * a month whose meetings belong to last month's leads) and ביצועים→מכירות
 * (מכירות is the ALL CLIENTS lead-entry column). תיאומים→ביצועים stays,
 * dated over dated. A project with no dated source shows "—" in place of
 * both bars and of every rate that touches them.
 */

const STAGES = [
  { key: "impressions", label: "חשיפות", color: "#11998e" },
  { key: "clicks", label: "קליקים", color: "#38ef7d" },
  { key: "leads", label: "לידים", color: "#667eea" },
  { key: "scheduled", label: "תיאומים", color: "#f093fb" },
  { key: "meetings", label: "ביצועים", color: "#f5576c" },
  { key: "sales", label: "מכירות", color: "#1a1a2e" },
] as const;

type StageKey = (typeof STAGES)[number]["key"];

/** The stages whose value depends on the basis. */
const MEETING_STAGES: ReadonlySet<StageKey> = new Set<StageKey>([
  "scheduled",
  "meetings",
]);

/** A stage→stage rate: a number, nothing (first stage, or a zero
 *  denominator — as before the switch), or an explained "—". */
type StageConv =
  | { kind: "num"; value: number }
  | { kind: "none" }
  | { kind: "dash"; reason: BasisDashReason };

function convColor(r: number): string {
  return r >= 0.5 ? "#2bb673" : r >= 0.1 ? "#f0ad4e" : "#d9534f";
}

export default function ReportConversionFunnel({
  data,
}: {
  data: ProjectReportData;
}) {
  const [showSigned, setShowSigned] = useState(false);
  const { basis } = useMeetingBasis();
  const t = data.totals;
  if (!t) return null;
  const dated = basis === "dated";
  const sm = sumAdPlatform(data.adPlatform);
  // null ⇒ this basis has no meeting numbers for the project → "—".
  const mt = totalsForBasis(data, basis);
  const values: Record<StageKey, number | null> = {
    impressions: sm.impressions,
    clicks: sm.clicks,
    leads: t.leads,
    scheduled: mt ? mt.scheduled : null,
    meetings: mt ? mt.meetings : null,
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
  const maxScaled = Math.max(
    ...rows.map((r) => (r.value === null ? 0 : scaleOf(r.value))),
    1,
  );
  const hasSm = sm.impressions > 0 || sm.clicks > 0;

  const convOf = (
    prev: (typeof rows)[number] | null,
    cur: (typeof rows)[number],
  ): StageConv => {
    if (!prev) return { kind: "none" };
    if (dated) {
      const prevMeet = MEETING_STAGES.has(prev.key);
      const curMeet = MEETING_STAGES.has(cur.key);
      if ((prevMeet && prev.value === null) || (curMeet && cur.value === null))
        return { kind: "dash", reason: "no-source" };
      if (prevMeet !== curMeet) return { kind: "dash", reason: "cross-basis" };
    }
    return prev.value !== null && prev.value > 0 && cur.value !== null
      ? { kind: "num", value: cur.value / prev.value }
      : { kind: "none" };
  };

  return (
    <section className="rpt-conv-funnel">
      <div className="rpt-cf-title">
        📊 משפך המרה{hasSm ? " — מלא (חשיפות ← מכירות)" : ""}
      </div>
      <div className="rpt-cf-bars">
        {rows.map((r, i) => {
          const prev = i > 0 ? rows[i - 1] : null;
          const conv = convOf(prev, r);
          if (r.value === null) {
            // No number on this basis: no bar at all (a 2% sliver would
            // read as "almost none"), just the explained "—".
            return (
              <div key={r.key} className="rpt-cf-row">
                <div className="rpt-cf-label">{r.label}</div>
                <div className="rpt-cf-track">
                  <span className="rpt-cf-conv">
                    <BasisDash reason="no-source" basis={basis} />
                  </span>
                </div>
              </div>
            );
          }
          const value = r.value;
          // Under dated the meeting bars say so in their tooltip, so the
          // figure is not mistaken for the lead-entry one out of context.
          const basisTag =
            dated && MEETING_STAGES.has(r.key) ? ` (${BASIS_LABELS.dated})` : "";
          const w = Math.max(2, (scaleOf(value) / maxScaled) * 100);
            // Only מכירות drills. It is the one stage whose members the CRM
            // can name — the rest are platform aggregates with no client
            // behind them. Open to clients too since 2026-08-31, alongside
            // חוזים and for the same reason: it reads the same
            // /api/crm/signed, which now authorises a client for the
            // projects they are listed on. Leaving this internal-only made
            // the bar the one number on a client's report that looked
            // clickable and wasn't.
            const drills = r.key === "sales" && value > 0;
            return (
            <div key={r.key} className="rpt-cf-row">
              <div className="rpt-cf-label">{r.label}</div>
              <div className="rpt-cf-track">
                <div
                  className={"rpt-cf-fill" + (drills ? " is-drill" : "")}
                  style={{ width: `${w}%`, background: r.color }}
                  role={drills ? "button" : undefined}
                  tabIndex={drills ? 0 : undefined}
                  onClick={drills ? () => setShowSigned(true) : undefined}
                  onKeyDown={
                    drills
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setShowSigned(true);
                          }
                        }
                      : undefined
                  }
                  title={
                    drills
                      ? `${r.label}: ${fmtInt(value)} — לחצו לפתיחת תיקי הלקוחות שחתמו`
                      : `${r.label}${basisTag}: ${fmtInt(value)}${conv.kind === "num" ? ` · המרה מ־${prev!.label}: ${fmtPct2(conv.value)}` : ""}`
                  }
                >
                  <span className="rpt-cf-val">{fmtInt(value)}</span>
                  {drills && (
                    <span className="rpt-cf-drill" aria-hidden>
                      🔍
                    </span>
                  )}
                </div>
                {conv.kind === "num" && (
                  <span
                    className="rpt-cf-conv"
                    style={{ color: convColor(conv.value) }}
                    title={`יחס המרה מ־${prev!.label}`}
                  >
                    {fmtPct2(conv.value)}
                  </span>
                )}
                {conv.kind === "dash" && (
                  <span className="rpt-cf-conv">
                    <BasisDash reason={conv.reason} basis={basis} />
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {useLog && <div className="rpt-cf-note">סקאלה לוגריתמית (חשיפות מעל 10K)</div>}
      {showSigned && (
        <SignedClientsPanel
          project={data.project}
          company={data.company}
          from={data.window.startIso}
          to={data.window.endIso}
          barValue={t.sales}
          onClose={() => setShowSigned(false)}
        />
      )}
    </section>
  );
}
