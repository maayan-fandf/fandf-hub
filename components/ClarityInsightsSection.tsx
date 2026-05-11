import { summarizeClarityForProject } from "@/lib/clarityInsights";

/**
 * Server component — calls the Clarity orchestrator, returns null on
 * any failure (no landing URL, Clarity 4xx, no traffic, etc.) so the
 * project page silently degrades. Mounted under <Suspense fallback={null}>
 * so the slow API chain (~1.4-2.7s cold) doesn't block the rest of
 * the page rendering.
 *
 * Internal-only — gated to !isClientUser at the call site (page.tsx).
 *
 * On `monthFilter`: the Clarity Data Export API only returns the
 * trailing 3 days (lib/clarity.ts has `numOfDays: "3"` hardcoded; the
 * endpoint doesn't accept a date-range param either). So when the page
 * is rewound to a past month via `?monthOverride=YYYY-MM`, we can't
 * honestly show Clarity data — the API would return today's numbers
 * labeled as the past month, which is misleading. We hide the section
 * entirely in that case. When the filter is empty OR equals the
 * current calendar month, we render normally (trailing 3 days is a
 * subset of the current month and labels itself as such in the
 * section heading).
 */
function currentMonthIL(): string {
  // Asia/Jerusalem-anchored YYYY-MM, matches lib/crmData.currentMonthIL
  // and the rest of the codebase's date math.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  return y && m ? `${y}-${m}` : "";
}

export default async function ClarityInsightsSection({
  subjectEmail,
  project,
  monthFilter,
}: {
  subjectEmail: string;
  project: string;
  /** "YYYY-MM" — when set to a past month, the section self-hides
   *  because Clarity has no historical data. Empty or current-month
   *  → render normally. */
  monthFilter?: string;
}) {
  // Self-hide when filtered to a past month — see fn-level comment.
  const filter = (monthFilter || "").trim();
  if (filter && /^\d{4}-\d{2}$/.test(filter) && filter !== currentMonthIL()) {
    return null;
  }
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
