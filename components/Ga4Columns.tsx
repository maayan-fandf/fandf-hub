/**
 * The column set every breakdown in the אנליטיקס section reports:
 *
 *   כניסות · חלק · גלישה מעורבת · זמן ממוצע · אירועי מפתח · שיעור המרה
 *
 * Each table started out printing whatever its own query happened to
 * return — devices had no engagement or time, cities had only
 * conversions, pages had no conversions at all. Reading down the section
 * you could not tell whether a missing column meant "not measured here"
 * or "zero", and two blocks describing the SAME sessions sliced
 * differently looked like they came from different systems.
 *
 * This lives in its own module rather than beside the section because
 * Ga4CityMap is a client component: importing anything from
 * Ga4ReportSection would pull resolveGa4Target → lib/sa → googleapis into
 * the browser bundle, which 500s the whole project page. Nothing here may
 * import from a server lib for the same reason.
 */

/** `חלק` is deliberately absent from the data types — it is a share of
 *  whatever the block's total is, and each block has a different one:
 *  a city's share is of mapped Israeli sessions, a device's of all
 *  sessions, a campaign's of that city's sessions. Baking one of those
 *  into the row would be wrong for the others. */
const STANDARD_COLUMNS = ["כניסות", "חלק", "גלישה מעורבת", "זמן ממוצע"] as const;

export function StandardHead({
  first,
  showConv,
}: {
  first: string;
  showConv: boolean;
}) {
  return (
    <thead>
      <tr>
        <th>{first}</th>
        {STANDARD_COLUMNS.map((c) => (
          <th key={c}>{c}</th>
        ))}
        {/* The conversion pair is dropped, not zeroed, when the property
            tags no key events: a column of 0% reads as "nothing here
            converts" rather than "this was never measured". */}
        {showConv && <th>אירועי מפתח</th>}
        {showConv && <th>שיעור המרה</th>}
      </tr>
    </thead>
  );
}

/**
 * The five value cells that follow a row's label cell.
 *
 * `engagementRate` is accepted pre-divided where a row already carries it
 * and derived from engaged/sessions where it does not — GA4 returns
 * whichever the query asked for, and neither is worth a second request to
 * normalise.
 */
export function StandardCells({
  sessions,
  total,
  engaged,
  engagementRate,
  avgSeconds,
  keyEvents,
  convRate,
  showConv,
}: {
  sessions: number;
  total: number;
  engaged?: number;
  engagementRate?: number;
  avgSeconds: number;
  keyEvents: number;
  convRate: number;
  showConv: boolean;
}) {
  const er =
    engagementRate ??
    (sessions > 0 && engaged !== undefined ? engaged / sessions : null);
  return (
    <>
      <td>{fmtInt(sessions)}</td>
      <td>{total > 0 ? fmtPct(sessions / total) : "—"}</td>
      <td>{er === null ? "—" : fmtPct(er)}</td>
      <td>{fmtDuration(avgSeconds)}</td>
      {showConv && <td>{fmtInt(keyEvents)}</td>}
      {showConv && <td>{fmtPct(convRate)}</td>}
    </>
  );
}

function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
}

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}ש'`;
}
