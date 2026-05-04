import { summarizeClarityForProject } from "@/lib/clarityInsights";

/**
 * Server component — calls the Clarity orchestrator, returns null on
 * any failure (no landing URL, Clarity 4xx, no traffic, etc.) so the
 * project page silently degrades. Mounted under <Suspense fallback={null}>
 * so the slow API chain (~1.4-2.7s cold) doesn't block the rest of
 * the page rendering.
 *
 * Internal-only — gated to !isClientUser at the call site (page.tsx).
 */
export default async function ClarityInsightsSection({
  subjectEmail,
  project,
}: {
  subjectEmail: string;
  project: string;
}) {
  const data = await summarizeClarityForProject({
    subjectEmail,
    project,
  }).catch(() => null);
  if (!data) return null;
  const { insights, hebrewSummary, clarityDashboardUrl } = data;

  return (
    <section className="project-section project-section-clarity">
      <div className="section-head">
        <h2>👁️ התנהגות בדף הנחיתה (3 ימים אחרונים)</h2>
        <a
          className="section-link"
          href={clarityDashboardUrl}
          target="_blank"
          rel="noreferrer"
        >
          פתח ב-Clarity ↗
        </a>
      </div>

      {hebrewSummary && (
        <div className="clarity-summary-card">
          <span className="clarity-summary-badge">Claude</span>
          <p>{hebrewSummary}</p>
        </div>
      )}

      <div className="clarity-kpi-grid">
        <KpiTile label="סשנים" value={fmtNum(insights.sessions)} />
        <KpiTile
          label="זמן ממוצע"
          value={fmtDuration(insights.engagementSecondsAvg)}
        />
        <KpiTile
          label="עומק גלילה"
          value={`${Math.round(insights.scrollDepthPctAvg)}%`}
        />
        <KpiTile
          label="⚠ לחיצות זעם"
          value={fmtNum(insights.rageClicks)}
          tone={insights.rageClicks > 0 ? "warn" : undefined}
        />
        <KpiTile
          label="⚠ לחיצות מתות"
          value={fmtNum(insights.deadClicks)}
          tone={insights.deadClicks > 0 ? "warn" : undefined}
        />
        <KpiTile label="חזרות מהירות" value={fmtNum(insights.quickbacks)} />
        <KpiTile
          label="מובייל / דסקטופ"
          value={fmtDeviceSplit(insights.deviceSplit)}
        />
      </div>
    </section>
  );
}

function KpiTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn";
}) {
  return (
    <div
      className={`clarity-kpi-tile${tone === "warn" ? " clarity-kpi-tile-warn" : ""}`}
    >
      <div className="clarity-kpi-tile-label">{label}</div>
      <div className="clarity-kpi-tile-value">{value}</div>
    </div>
  );
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}ש'`;
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

function fmtDeviceSplit(split: {
  desktop: number;
  mobile: number;
  tablet: number;
}): string {
  const total = split.desktop + split.mobile + split.tablet;
  if (total === 0) return "—";
  const mobilePct = Math.round((split.mobile / total) * 100);
  const desktopPct = Math.round((split.desktop / total) * 100);
  return `${mobilePct}% / ${desktopPct}%`;
}
