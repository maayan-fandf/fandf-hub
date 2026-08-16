import { resolveGa4Target } from "@/lib/ga4Project";
import { fetchLive, fetchWindows } from "@/lib/ga4";
import Ga4LiveClient from "@/components/Ga4LiveClient";

/**
 * Server component — resolves the project's GA4 property, does the first
 * fetch so the section paints with real numbers, then hands over to
 * Ga4LiveClient for polling.
 *
 * Returns null on ANY failure (no landing URL in Keys, property not
 * resolvable, GA 4xx). A wrong property here would show one client
 * another developer's traffic, so the section is opt-out-by-silence:
 * it appears only when we know exactly which pages belong to this
 * project.
 *
 * Unlike ClarityInsightsSection this is NOT gated to internal users —
 * clients see their own project's live traffic. That is why the source
 * line under the numbers names the property and paths being read: a
 * client should be able to see where the figure comes from. The numeric
 * property id is deliberately not sent to the browser.
 *
 * Mounted under <Suspense fallback={null}> — the GA chain is 4 API calls
 * (~1-3s cold) and must not block the rest of the project page.
 */
export default async function Ga4LiveSection({
  subjectEmail,
  project,
  monthFilter,
}: {
  subjectEmail: string;
  project: string;
  /** "YYYY-MM" — a past month hides the section, same rule as Clarity:
   *  realtime has no history, so showing today's number under a rewound
   *  month would be a lie. */
  monthFilter?: string;
}) {
  const filter = (monthFilter || "").trim();
  if (filter && /^\d{4}-\d{2}$/.test(filter) && filter !== currentMonthIL()) {
    return null;
  }

  const target = await resolveGa4Target(subjectEmail, project).catch(() => null);
  if (!target) return null;

  const [live, windows] = await Promise.all([
    fetchLive(target.propertyId, target.paths).catch(() => null),
    fetchWindows(target.propertyId, target.paths).catch(() => null),
  ]);
  if (!live) return null;

  return (
    <section className="project-section project-section-ga4">
      <div className="section-head">
        <h2>📈 תנועה בדף הנחיתה — עכשיו</h2>
        <a
          className="section-link"
          href={`https://analytics.google.com/analytics/web/#/p${target.propertyId}/realtime/overview`}
          target="_blank"
          rel="noreferrer"
        >
          פתח ב-Google Analytics ↗
        </a>
      </div>

      <Ga4LiveClient
        project={project}
        initial={{ live, today: windows?.today ?? null, last7: windows?.last7 ?? null }}
      />

      <div className="ga4-source">
        מקור: Google Analytics 4 · נכס <strong>{target.propertyName}</strong> ·{" "}
        {target.paths.map((p) => (
          <code key={p} className="ga4-source-path">
            {target.host}
            {p === "/" ? "/" : p}
          </code>
        ))}
      </div>
    </section>
  );
}

/** Asia/Jerusalem-anchored YYYY-MM, matching lib/crmData.currentMonthIL
 *  and ClarityInsightsSection. */
function currentMonthIL(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  return y && m ? `${y}-${m}` : "";
}
