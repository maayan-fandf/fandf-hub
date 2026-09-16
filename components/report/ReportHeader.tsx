"use client";

import { useState } from "react";
import AssetThumb from "@/components/report/AssetThumb";
import { BasisBadge } from "@/components/report/BasisBadge";
import { useMeetingBasis } from "@/components/report/MeetingBasisContext";
import {
  BASIS_LABELS,
  BASIS_TITLES,
  type MeetingBasis,
} from "@/lib/meetingBasis";
import {
  deltaInfo,
  fmtILS,
  fmtInt,
  fmtDateHe,
  isMeetingAnomaly,
  type ProjectReportData,
} from "@/lib/reportShared";

/**
 * Native report header — the legacy project-header block above the tabs:
 * budget-utilization bar (colored by pacing) + time-progress bar +
 * pacing badge, the end-of-period forecast strip, period-over-period
 * anomaly chips, landing-page preview, and the on-demand AI summary
 * button. All numbers are precomputed server-side (data.pacing /
 * .forecast / .anomalies) so this is a pure render.
 *
 * MEETING BASIS (page-level switch, lib/meetingBasis). Three things here
 * touch תיאומים / ביצועים:
 *   • the 📅 תיאומים / 🏆 ביצועים forecast pills and
 *   • the 🏆 זינוק בביצועי פגישה anomaly chip
 *     are LEAD-ENTRY ONLY. Both project from, or compare against, ALL
 *     CLIENTS חודשי rows (computeForecast's median of the last completed
 *     months, computePrevFunnel's previous month), and no dated monthly
 *     history exists to build a dated twin from. Under "לפי מועד הפגישה"
 *     they are hidden, not relabelled: a lead-entry projection sitting next
 *     to dated cards 2.5× larger (The 57, Sept: 20 vs 49 תיאומים) would read
 *     as "the month is about to fall off a cliff". The budget and לידים
 *     pills and every other chip have no basis and stay.
 *   • the AI summary follows the switch: the basis goes in the POST body
 *     (the route keys its 6h cache on it), and each basis keeps its own
 *     generated text, so flipping back and forth never shows a summary
 *     written from the other basis's numbers and never re-requests one
 *     that is already on screen. The badge in the summary's head names the
 *     basis it was written on.
 */

const PACE_BAR_COLOR: Record<string, string> = {
  green: "#2bb673",
  yellow: "#f0ad4e",
  red: "#d9534f",
  neutral: "#888",
};

/** Minimal **bold** + newline markdown for the AI summary text. */
function renderSummary(text: string) {
  return text.split("\n").map((line, i) => {
    if (!line.trim()) return <br key={i} />;
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <p key={i} className="rpt-ai-line">
        {parts.map((p, j) =>
          p.startsWith("**") && p.endsWith("**") ? (
            <strong key={j}>{p.slice(2, -2)}</strong>
          ) : (
            <span key={j}>{p}</span>
          ),
        )}
      </p>
    );
  });
}

/**
 * Landing-page screenshot cards. Exported because they are rendered
 * next to the GA4 live-traffic section (NativeProjectRail) rather than
 * in this header — the screenshot and that page's traffic numbers read
 * as one unit. Kept OUTSIDE Ga4LiveSection deliberately: that section
 * hides itself whenever a project's GA property can't be resolved, and
 * the thumbnails must survive that.
 */
export function LandingPreview({ url, project }: { url: string; project: string }) {
  const urls = url
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
  if (!urls.length) return null;
  return (
    <div className={"rpt-landing-grid" + (urls.length > 1 ? " is-multi" : "")}>
      {urls.map((u) => (
        <LandingCard key={u} url={u} project={project} />
      ))}
    </div>
  );
}

function LandingCard({ url, project }: { url: string; project: string }) {
  // Shared with the נכסים דיגיטליים cards. This used to hold its own
  // thum.io-first chain, and thum.io's free tier now answers with a
  // 600×200 "Image not authorized" image — a valid image, so onError
  // never fired and every project header was rendering that notice
  // instead of the page. See AssetThumb for the measurements.
  return (
    <div className="rpt-landing">
      <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
        <AssetThumb url={url} alt={`דף נחיתה — ${project}`} className="rpt-landing-img" />
        <div className="rpt-landing-caption">🌐 {url} — לחץ לפתיחה</div>
      </a>
    </div>
  );
}

type AiEntry = {
  state: "idle" | "loading" | "done" | "error";
  text: string;
  err: string;
};

const AI_IDLE: AiEntry = { state: "idle", text: "", err: "" };

function AiSummary({ data }: { data: ProjectReportData }) {
  const { basis } = useMeetingBasis();
  // One entry per basis. The summary is prose written from one basis's
  // numbers ("12 תיאומים בגוגל…"), so after a flip the other basis's text
  // must not stay on screen — and flipping back should bring the first one
  // back rather than asking for (and paying for) it again.
  const [byBasis, setByBasis] = useState<Partial<Record<MeetingBasis, AiEntry>>>({});
  const { state, text, err } = byBasis[basis] ?? AI_IDLE;
  const patch = (b: MeetingBasis, next: Partial<AiEntry>) =>
    setByBasis((m) => ({ ...m, [b]: { ...(m[b] ?? AI_IDLE), ...next } }));

  const run = async () => {
    // Pinned at click time: a flip while the request is in flight must not
    // file this basis's answer under the other one.
    const b = basis;
    patch(b, { state: "loading", err: "" });
    try {
      const period =
        data.mode === "month"
          ? data.window.startIso.slice(0, 7)
          : data.mode === "range"
            ? `${data.window.startIso}..${data.window.endIso}`
            : "";
      const res = await fetch("/api/report/ai-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: data.project,
          period,
          company: data.company,
          basis: b,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      patch(b, { state: "done", text: json.text });
    } catch (e) {
      patch(b, { state: "error", err: e instanceof Error ? e.message : String(e) });
    }
  };

  if (state === "done") {
    return (
      <div className="rpt-ai">
        <div className="rpt-ai-head">
          <span>
            🧠 סיכום AI
            <BasisBadge label={BASIS_LABELS[basis]} title={BASIS_TITLES[basis]} />
          </span>
          <button
            type="button"
            className="rpt-ai-refresh"
            onClick={run}
            title="הפק סיכום מחדש"
          >
            ↻ רענן
          </button>
        </div>
        <div className="rpt-ai-text">{renderSummary(text)}</div>
      </div>
    );
  }
  return (
    <div className="rpt-ai-trigger">
      <button
        type="button"
        className="rpt-ai-btn"
        onClick={run}
        disabled={state === "loading"}
      >
        {state === "loading" ? "מייצר סיכום…" : "🧠 סיכום AI"}
      </button>
      {state === "error" && <span className="rpt-ai-err">⚠️ {err}</span>}
    </div>
  );
}

export default function ReportHeader({ data }: { data: ProjectReportData }) {
  const { basis } = useMeetingBasis();
  const dated = basis === "dated";
  const t = data.totals;
  const pace = data.pacing;
  const isMonth = data.mode === "month";
  const spendDelta =
    t && data.prevFunnel
      ? deltaInfo(t.spend, data.prevFunnel.spend, "neutral")
      : null;
  // Lead-entry-only chips drop out under dated (see the header comment).
  const anomalies = dated
    ? data.anomalies.filter((a) => !isMeetingAnomaly(a))
    : data.anomalies;

  return (
    <div className="rpt-header">
      <div className="rpt-header-top">
        <div className="rpt-header-title">
          <h2>{data.project}</h2>
          {data.company && <span className="rpt-header-company">{data.company}</span>}
        </div>
        <div className="rpt-header-dates">
          📅 {fmtDateHe(data.window.startIso)} — {fmtDateHe(data.window.endIso)}
        </div>
      </div>

      {anomalies.length > 0 && (
        <div className="rpt-header-alerts">
          {anomalies.map((a, i) => (
            <div key={i} className={`rpt-anomaly is-${a.type}`}>
              {a.text}
            </div>
          ))}
        </div>
      )}

      {t && t.budget > 0 && (
        <div className="rpt-util">
          {/* Spend + time bars stacked vertically (same track width) so
              the two fills line up and pacing reads at a glance. */}
          <div className="rpt-util-bars">
            <div className="rpt-util-block">
              <div className="rpt-util-label">
                ניצול תקציב: {fmtILS(t.spend)} מתוך {fmtILS(t.budget)}
                {spendDelta && (
                  <span className="rpt-util-delta" title={`בתקופה הקודמת: ${fmtILS(data.prevFunnel!.spend)}`}>
                    {spendDelta.arrow} {spendDelta.text}
                  </span>
                )}
              </div>
              <div className="rpt-util-track">
                <div
                  className="rpt-util-fill"
                  style={{
                    width: `${Math.min(isMonth ? (t.budget > 0 ? (t.spend / t.budget) * 100 : 0) : pace?.spendPct ?? 0, 100)}%`,
                    background: isMonth ? "#7c3aed" : PACE_BAR_COLOR[pace?.cls ?? "neutral"],
                  }}
                >
                  {Math.round(isMonth ? (t.budget > 0 ? (t.spend / t.budget) * 100 : 0) : pace?.spendPct ?? 0)}%
                </div>
              </div>
            </div>
            {!isMonth && pace && (
              <div className="rpt-util-block">
                <div className="rpt-util-label">
                  התקדמות בזמן: {Math.round(pace.dayPct)}%
                </div>
                <div className="rpt-util-track">
                  {/* Colour lives in CSS, not inline: this bar was
                      hardcoded #16213e, a near-black navy that vanishes
                      against the dark-theme track. The budget bar above
                      keeps its inline colour because that colour is
                      data — it encodes the pacing verdict. */}
                  <div
                    className="rpt-util-fill rpt-util-fill-time"
                    style={{ width: `${pace.dayPct}%` }}
                  >
                    {Math.round(pace.dayPct)}%
                  </div>
                </div>
              </div>
            )}
          </div>
          {!isMonth && pace && (
            <div className={`rpt-pace-badge is-${pace.cls}`}>
              ⦿ {pace.label}
              {pace.detail && <span className="rpt-pace-detail">{pace.detail}</span>}
            </div>
          )}
        </div>
      )}

      {data.forecast && (
        <div className="rpt-forecast">
          <div className="rpt-forecast-label">
            📈 תחזית לסוף התקופה ({data.forecast.daysLeft} ימים נותרו)
          </div>
          <div className="rpt-forecast-pills">
            <ForecastBudget f={data.forecast} />
            {data.forecast.leads > 0 && (
              <span className="rpt-forecast-pill">🎯 לידים: {fmtInt(data.forecast.leads)}</span>
            )}
            {/* Lead-entry projections — hidden under dated (header comment). */}
            {!dated && data.forecast.scheduled > 0 && (
              <span className="rpt-forecast-pill">📅 תיאומים: {fmtInt(data.forecast.scheduled)}</span>
            )}
            {!dated && data.forecast.meetings > 0 && (
              <span className="rpt-forecast-pill">🏆 ביצועים: {fmtInt(data.forecast.meetings)}</span>
            )}
          </div>
        </div>
      )}

      {/* LandingPreview moved out of the header — it now renders beside
          the GA4 live-traffic section. See NativeProjectRail. */}

      <AiSummary data={data} />
    </div>
  );
}

function ForecastBudget({ f }: { f: NonNullable<ProjectReportData["forecast"]> }) {
  const pct = f.budget > 0 ? f.spend / f.budget : 0;
  const tone = pct > 1.1 ? "bad" : pct > 0.95 ? "good" : "neutral";
  const icon = pct > 1.1 ? "⚠️" : pct >= 0.9 ? "✅" : "💰";
  return (
    <span className={`rpt-forecast-pill is-${tone}`}>
      {f.budget > 0
        ? `${icon} תקציב: ${fmtILS(f.spend)} (${Math.round(pct * 100)}% מ-${fmtILS(f.budget)})`
        : `💰 הוצאה: ${fmtILS(f.spend)}`}
    </span>
  );
}
