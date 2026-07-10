"use client";

import { useState } from "react";
import {
  deltaInfo,
  fmtILS,
  fmtInt,
  fmtDateHe,
  type ProjectReportData,
} from "@/lib/reportShared";

/**
 * Native report header — the legacy project-header block above the tabs:
 * budget-utilization bar (colored by pacing) + time-progress bar +
 * pacing badge, the end-of-period forecast strip, period-over-period
 * anomaly chips, landing-page preview, and the on-demand AI summary
 * button. All numbers are precomputed server-side (data.pacing /
 * .forecast / .anomalies) so this is a pure render.
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

function LandingPreview({ url, project }: { url: string; project: string }) {
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
  const thumio = `https://image.thum.io/get/width/900/crop/600/noanimate/wait/4/${encodeURI(url)}`;
  const microlink = `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false&embed=screenshot.url`;
  const [src, setSrc] = useState(thumio);
  const [dead, setDead] = useState(false);
  return (
    <div className="rpt-landing">
      <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
        {dead ? (
          <div className="rpt-landing-fallback">🌐 {url}</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            loading="eager"
            alt={`דף נחיתה — ${project}`}
            onError={() => (src === thumio ? setSrc(microlink) : setDead(true))}
          />
        )}
        <div className="rpt-landing-caption">🌐 {url} — לחץ לפתיחה</div>
      </a>
    </div>
  );
}

function AiSummary({ data }: { data: ProjectReportData }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [text, setText] = useState("");
  const [err, setErr] = useState("");

  const run = async () => {
    setState("loading");
    setErr("");
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
        body: JSON.stringify({ project: data.project, period, company: data.company }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setText(json.text);
      setState("done");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  };

  if (state === "done") {
    return (
      <div className="rpt-ai">
        <div className="rpt-ai-head">
          <span>🧠 סיכום AI</span>
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
  const t = data.totals;
  const pace = data.pacing;
  const isMonth = data.mode === "month";
  const spendDelta =
    t && data.prevFunnel
      ? deltaInfo(t.spend, data.prevFunnel.spend, "neutral")
      : null;

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

      {data.anomalies.length > 0 && (
        <div className="rpt-header-alerts">
          {data.anomalies.map((a, i) => (
            <div key={i} className={`rpt-anomaly is-${a.type}`}>
              {a.text}
            </div>
          ))}
        </div>
      )}

      {t && t.budget > 0 && (
        <div className="rpt-util">
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
            <>
              <div className="rpt-util-block">
                <div className="rpt-util-label">
                  התקדמות בזמן: {Math.round(pace.dayPct)}%
                </div>
                <div className="rpt-util-track">
                  <div
                    className="rpt-util-fill"
                    style={{ width: `${pace.dayPct}%`, background: "#16213e" }}
                  >
                    {Math.round(pace.dayPct)}%
                  </div>
                </div>
              </div>
              <div className={`rpt-pace-badge is-${pace.cls}`}>
                ⦿ {pace.label}
                {pace.detail && <span className="rpt-pace-detail">{pace.detail}</span>}
              </div>
            </>
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
            {data.forecast.scheduled > 0 && (
              <span className="rpt-forecast-pill">📅 תיאומים: {fmtInt(data.forecast.scheduled)}</span>
            )}
            {data.forecast.meetings > 0 && (
              <span className="rpt-forecast-pill">🏆 ביצועים: {fmtInt(data.forecast.meetings)}</span>
            )}
          </div>
        </div>
      )}

      {data.landingUrl && <LandingPreview url={data.landingUrl} project={data.project} />}

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
