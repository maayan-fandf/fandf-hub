import GoogleAnalyticsMark from "@/components/GoogleAnalyticsMark";
import PlatformIcon from "@/components/PlatformIcon";
import ChannelIcon from "@/components/ChannelIcon";
import { resolveGa4Target } from "@/lib/ga4Project";
import { getProjectFlightWindow } from "@/lib/allClients";
import { lookupCity } from "@/lib/israelMap";
import Ga4CityMap from "@/components/Ga4CityMap";
import Ga4CampaignTree from "@/components/Ga4CampaignTree";
import Ga4Demographics from "@/components/Ga4Demographics";
import {
  fetchGa4Report,
  reportWindow,
  type Ga4ReportData,
  type Ga4Point,
} from "@/lib/ga4Report";

/**
 * אנליטיקס — the period-scoped GA4 section, between קמפיינים and מגמות.
 *
 * Every GA4 call happens here on the server; the charts are inline SVG,
 * so nothing on this section polls and nothing competes with
 * Ga4LiveClient for the realtime quota. The tree and the demographics
 * toggle only re-read data that already shipped with the page; the city
 * map is the one component that fetches, and only on a click. Returns
 * null on any failure, like every other optional section on this page.
 *
 * Client-visible (real-estate gate only), which is why every number here
 * is either exact or explicitly labelled, and why conversions are absent
 * entirely — see the header comment in lib/ga4Report.ts.
 */
export default async function Ga4ReportSection({
  subjectEmail,
  project,
  monthFilter,
  dateRange,
  isInternal = false,
}: {
  subjectEmail: string;
  project: string;
  monthFilter?: string;
  /** Free date range from the shared page picker (?from=&to=). */
  dateRange?: { from: string; to: string };
  /** Tagging-health warnings are internal-only; clients see the section
   *  quietly omit a block rather than a diagnostic about broken UTMs. */
  isInternal?: boolean;
}) {
  const target = await resolveGa4Target(subjectEmail, project).catch(() => null);
  if (!target) return null;

  // Default to the campaign's own flight dates rather than a trailing 28
  // days, so this section and the report header beside it describe the
  // same period. Best-effort: a project with no flight falls back to the
  // trailing window inside reportWindow().
  const flight = await getProjectFlightWindow({
    subjectEmail,
    project,
  }).catch(() => null);
  const win = reportWindow(monthFilter, dateRange, flight);
  const data = await fetchGa4Report(
    subjectEmail,
    target.propertyId,
    target.paths,
    win,
  ).catch(() => null);
  if (!data) return null;

  return (
    <section className="project-section project-section-ga4rep">
      <div className="section-head">
        <h2>
          <GoogleAnalyticsMark /> אנליטיקס — תנועה ואיכות גלישה
        </h2>
        {/* The dates alone would read as an arbitrary window. Naming the
            flight is what tells a reader the section covers the campaign
            rather than some trailing period — and that a running flight
            is measured only up to yesterday. */}
        <span className="section-link-static">
          {win.source === "flight" && "תקופת הקמפיין · "}
          {fmtRange(data.window.start, data.window.end)}
        </span>
      </div>

      <div className="ga4w-kpis">
        <Kpi
          label="כניסות לדף"
          value={fmtInt(data.totals.sessions)}
          delta={delta(data.totals.sessions, data.prevTotals.sessions)}
        />
        <Kpi
          label="משתמשים ייחודיים"
          value={fmtInt(data.totals.users)}
          delta={delta(data.totals.users, data.prevTotals.users)}
        />
        <Kpi
          label="גלישה מעורבת"
          value={fmtPct(data.quality.engagementRate)}
          delta={delta(data.quality.engagementRate, data.prevQuality.engagementRate)}
          hint="סשן שנמשך מעל 10 שניות, כלל אירוע המרה, או שנצפו בו לפחות שני עמודים"
        />
        <Kpi
          label="זמן ממוצע בדף"
          value={fmtDuration(data.quality.avgSeconds)}
          delta={delta(data.quality.avgSeconds, data.prevQuality.avgSeconds)}
        />
      </div>
      <div className="ga4w-cmp">לעומת התקופה הקודמת ({fmtRange(data.prevWindow.start, data.prevWindow.end)})</div>

      {/* Conversions sit directly under the headline KPIs, not below the
          campaign table — they are the outcome everything else explains. */}
      {data.conversions && (
        <Conversions c={data.conversions} sessions={data.totals.sessions} />
      )}

      {data.trend.length > 1 && <TrendChart points={data.trend} />}

      {/* ONE channel table, not two. The source table and the campaign
          table were the same numbers at two depths — the tree now carries
          every channel including organic/direct/referral (which simply
          have nothing to expand into), so the flat source block is gone.
          The flat campaign table survives only as a fallback for
          properties where the ad-group dimensions come back empty. */}
      {(data.tree?.adset?.length ?? 0) > 0 ? (
        <Ga4CampaignTree trees={data.tree} showConv={!!data.conversions} />
      ) : data.sources.length > 0 ? (
        <Sources data={data} showConv={!!data.conversions} />
      ) : (
        data.campaigns &&
        data.campaigns.length > 0 && (
          <Campaigns data={data} showConv={!!data.conversions} />
        )
      )}
      {!data.campaigns && isInternal && (
        <div className="ga4w-warn">
          ⚠️ תיוג הקמפיינים בפרויקט הזה חלקי — רק{" "}
          {fmtPct(data.campaignCoverage)} מהתנועה הממומנת נושאת שם קמפיין תקין,
          ולכן הפילוח לפי קמפיין מוסתר.
        </div>
      )}

      {/* Every optional block is read defensively. A cached payload from
          an older schema is missing these keys entirely, and a section
          that crashes the whole project page is far worse than one that
          quietly renders a block short — the version in the cache key in
          lib/ga4Report.ts is the real fix, this is the seatbelt. */}
      {data.returning && <Returning r={data.returning} />}

      {(data.intro?.length ?? 0) > 0 && <IntroCredit rows={data.intro} />}

      {data.demographics && (
        <Ga4Demographics
          d={data.demographics}
          siteKeyEvents={data.conversions?.keyEvents ?? 0}
        />
      )}

      {(data.devices?.length ?? 0) > 0 && (
        <Devices rows={data.devices} hasKeyEvents={!!data.conversions} />
      )}

      {/* Both diagnostics are INTERNAL ONLY. They describe campaign
          misconfiguration, not the project's performance, and some of
          these campaigns are run by other agencies — telling a client
          "80% of your traffic is foreign and never converts" without
          the media context behind it alarms rather than informs. The
          numbers they are computed from remain visible to clients in
          the map and source blocks; only the diagnosis is withheld. */}
      {isInternal && data.abroad && (
        <ForeignTraffic abroad={data.abroad} israel={data.israel} />
      )}

      {isInternal && (data.placementLeaks?.length ?? 0) > 0 && (
        <PlacementLeaks rows={data.placementLeaks} />
      )}

      {(data.cities?.length ?? 0) > 0 && (
        <Ga4CityMap
          project={project}
          cities={data.cities}
          abroad={data.abroad?.sessions ?? 0}
          unmapped={data.cities.reduce(
            (n, c) => (lookupCity(c.city) ? n : n + c.sessions),
            0,
          )}
          windowStart={data.window.start}
          windowEnd={data.window.end}
          showConv={!!data.conversions}
        />
      )}

      {(data.pages?.length ?? 0) > 1 && <Pages rows={data.pages} host={target.host} />}

      <div className="ga4-source">
        מקור: Google Analytics 4 · נכס <strong>{target.propertyName}</strong> ·{" "}
        הנתונים עד {fmtDate(data.window.end)}
        {data.wholeSite && " · הפרויקט תופס את כל האתר"}
        {/* NOT "includes the whole domain" — the filter here IS scoped to
            this project's pages. What differs in pagePath mode is the
            SCOPE of a session: we count visits that reached the project's
            pages, rather than sessions that entered the site on them. So a
            visitor who arrived on another project's ad and then browsed
            here is included, which is why a neighbouring project's
            campaign can appear in the table above. */}
        {data.mode === "pagePath" && !data.wholeSite && (
          <> · הספירה מבוססת על צפיות בעמודי הפרויקט, ולא על עמוד הכניסה לאתר</>
        )}
        {/* Named, not summarised. In pagePath mode the key events fire on
            a page that appears nowhere else in this section, so without
            this line the conversion count comes from a source the reader
            cannot see — and on a shared domain the natural question is
            whether it is really this project's thank-you page. */}
        {(data.conversionPaths?.length ?? 0) > 0 && (
          <> · אירועי המפתח נספרים גם מ-{data.conversionPaths.join(", ")}</>
        )}
        <div className="ga4w-caveat">
          ״כניסות״ נספרות ב-Google Analytics ואינן זהות למספר הקליקים — מבקר
          שנכנס פעמיים נספר כסשן אחד, וחוסמי פרסומות מונעים מדידה של חלק
          מהכניסות. ספירת הלידים מוצגת במערכת ה-CRM ולא כאן.
        </div>
      </div>
    </section>
  );
}

/* ── Trend ────────────────────────────────────────────────────────── */

/**
 * Daily sessions as an inline SVG area chart.
 *
 * Deliberately not a bar chart: 28 bars at panel width in RTL reads as
 * noise. Deliberately not plotting the previous period as a second
 * series either — it doubles the ink for a comparison the KPI deltas
 * already carry precisely.
 */
function TrendChart({ points }: { points: Ga4Point[] }) {
  const W = 800;
  const H = 150;
  const PAD = 6;
  const maxSessions = Math.max(...points.map((p) => p.sessions), 1);
  const maxKe = Math.max(...points.map((p) => p.keyEvents), 1);
  const hasKe = points.some((p) => p.keyEvents > 0);
  const step = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
  const x = (i: number) => PAD + i * step;
  const y = (v: number, max: number) =>
    H - PAD - (v / max) * (H - PAD * 2);

  const path = (pick: (p: Ga4Point) => number, max: number) =>
    points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(p), max).toFixed(1)}`)
      .join(" ");

  const line = path((p) => p.sessions, maxSessions);
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`;
  // Key events are one to two orders of magnitude smaller than sessions,
  // so they get their own scale — on a shared axis the line would sit
  // flat on the floor and read as zero. That means the two lines show
  // SHAPE against each other, never magnitude, which the legend says.
  const keLine = hasKe ? path((p) => p.keyEvents, maxKe) : "";
  const peak = points.reduce((a, b) => (b.sessions > a.sessions ? b : a), points[0]);

  return (
    <div className="ga4w-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="כניסות ואירועי מפתח יומיים">
        <path className="ga4w-chart-area" d={area} />
        <path className="ga4w-chart-line" d={line} />
        {hasKe && <path className="ga4w-chart-ke" d={keLine} />}
      </svg>
      <div className="ga4w-chart-axis">
        <span>{fmtDate(points[0].date)}</span>
        <span className="ga4w-chart-peak">
          שיא: {fmtInt(peak.sessions)} ב-{fmtDate(peak.date)}
        </span>
        <span>{fmtDate(points[points.length - 1].date)}</span>
      </div>
      {hasKe && (
        <div className="ga4w-chart-legend">
          <span className="ga4w-leg">
            <span className="ga4w-leg-swatch is-sessions" aria-hidden="true" />
            כניסות
          </span>
          <span className="ga4w-leg">
            <span className="ga4w-leg-swatch is-ke" aria-hidden="true" />
            אירועי מפתח (שיא {fmtInt(maxKe)})
          </span>
          <span className="ga4w-leg-note">
            הקווים בקנה מידה נפרד — משווים מגמה, לא גודל
          </span>
        </div>
      )}
    </div>
  );
}

/* ── Sources ──────────────────────────────────────────────────────── */

/** Channels that carry a brand logo instead of a colour dot. Keep in
 *  sync with the branches in PlatformIcon. */
const MARKED_CHANNELS = new Set([
  "meta",
  "audiencenetwork",
  "googleads",
  "taboola",
]);

/**
 * `showConv` gates the conversion columns on the property actually
 * tagging key events — otherwise every row reads 0%, which looks like
 * each channel fails to convert rather than like nothing is measured.
 *
 * The rate here is keyEvents ÷ sessions, NOT GA4's sessionKeyEventRate.
 * That metric is a ratio and cannot be summed when several
 * source/medium rows collapse into one bucket, so it is recomputed from
 * the additive parts. It therefore counts a session that fires two key
 * events twice and can read slightly higher than the headline rate —
 * hence the הערה under the table.
 */
function Sources({ data, showConv }: { data: Ga4ReportData; showConv: boolean }) {
  const total = data.sources.reduce((n, s) => n + s.sessions, 0);
  if (total <= 0) return null;
  return (
    <div className="ga4w-block">
      <h3 className="ga4w-h3">מאיפה הגיעה התנועה</h3>
      <div className="ga4w-stack">
        {data.sources.map((s) => (
          <div
            key={s.key}
            className={`ga4w-stack-seg is-${s.key}`}
            style={{ width: `${(s.sessions / total) * 100}%` }}
            title={`${s.label}: ${fmtInt(s.sessions)}`}
          />
        ))}
      </div>
      <table className="ga4w-table">
        <thead>
          <tr>
            <th>מקור</th>
            <th>כניסות</th>
            <th>חלק מהתנועה</th>
            <th>גלישה מעורבת</th>
            {showConv && <th>אירועי מפתח</th>}
            {showConv && <th>שיעור המרה</th>}
          </tr>
        </thead>
        <tbody>
          {data.sources.map((s) => (
            <tr key={s.key}>
              <td className="ga4w-src-cell">
                {/* Logo for the paid platforms, colour dot for everything
                    else — the badge is the signal that money is behind
                    the row, so giving organic/direct one would erase it. */}
                <PlatformIcon platform={s.key} size="1.05em" />
                {!MARKED_CHANNELS.has(s.key) && (
                  <span className={`ga4w-dot is-${s.key}`} aria-hidden="true" />
                )}
                {s.label}
              </td>
              <td>{fmtInt(s.sessions)}</td>
              <td>{fmtPct(s.sessions / total)}</td>
              <td>{s.sessions > 0 ? fmtPct(s.engaged / s.sessions) : "—"}</td>
              {showConv && <td>{fmtInt(s.keyEvents)}</td>}
              {showConv && <td>{fmtPct(s.convRate)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Campaigns ────────────────────────────────────────────────────── */

function Campaigns({ data, showConv }: { data: Ga4ReportData; showConv: boolean }) {
  const rows = data.campaigns ?? [];
  return (
    <div className="ga4w-block">
      <h3 className="ga4w-h3">פילוח לפי קמפיין</h3>
      <div className="ga4w-table-wrap">
        <table className="ga4w-table">
          <thead>
            <tr>
              <th>קמפיין</th>
              <th>כניסות</th>
              <th>גלישה מעורבת</th>
              <th>זמן ממוצע</th>
              {showConv && <th>אירועי מפתח</th>}
              {showConv && <th>שיעור המרה</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.campaign}>
                {/* The platform is encoded in the campaign NAME here
                    (_FB, _GS, discovery), and channelPlatform already
                    resolves those suffixes — so the same resolver that
                    labels channels labels campaigns, with no second
                    mapping to keep in sync. */}
                <td className="ga4w-camp">
                  <ChannelIcon name={c.campaign} /> {c.campaign}
                </td>
                <td>{fmtInt(c.sessions)}</td>
                <td>{c.sessions > 0 ? fmtPct(c.engaged / c.sessions) : "—"}</td>
                <td>{fmtDuration(c.avgSeconds)}</td>
                {showConv && <td>{fmtInt(c.keyEvents)}</td>}
                {showConv && <td>{fmtPct(c.convRate)}</td>}
              </tr>
            ))}
            {data.unattributedSessions > 0 && (
              /* Shown, never folded into the denominator — otherwise the
                 percentages above quietly describe a subset. */
              <tr className="ga4w-unattr">
                <td>לא שויך לקמפיין</td>
                <td>{fmtInt(data.unattributedSessions)}</td>
                <td>—</td>
                <td>—</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Conversions ──────────────────────────────────────────────────── */

/**
 * Key events and conversion rate.
 *
 * `sessionRate` is GA4's own `sessionKeyEventRate`, NOT keyEvents divided
 * by sessions — GA counts a session as converting once however many key
 * events it fires, so the naive ratio can exceed 100%.
 *
 * The caveat text is not optional. Key-event tagging is configured per
 * property and is inconsistent across the estate: one property tags
 * `thank2` while leaving `thank` and `generate_lead` untagged, another
 * double-counts the same lead under two names, a third counts button
 * clicks. So this is labelled אירועי מפתח (what GA calls it) and points
 * at the CRM for the authoritative lead count.
 */
function Conversions({
  c,
  sessions,
}: {
  c: NonNullable<Ga4ReportData["conversions"]>;
  sessions: number;
}) {
  return (
    <div className="ga4w-block">
      <h3 className="ga4w-h3">אירועי מפתח והמרות</h3>
      <div className="ga4w-kpis">
        <Kpi
          label="אירועי מפתח"
          value={fmtInt(c.keyEvents)}
          delta={delta(c.keyEvents, c.prevKeyEvents)}
        />
        <Kpi
          label="שיעור המרה מסשן"
          value={fmtPct(c.sessionRate)}
          delta={delta(c.sessionRate, c.prevSessionRate)}
          hint="שיעור הסשנים שכללו לפחות אירוע מפתח אחד, לפי Google Analytics"
        />
        {sessions > 0 && (
          <Kpi
            label="כניסות לאירוע מפתח"
            value={c.keyEvents > 0 ? `1 : ${Math.round(sessions / c.keyEvents)}` : "—"}
            delta={null}
            hint="כמה כניסות לדף נדרשו בממוצע לכל אירוע מפתח"
          />
        )}
      </div>
      {c.byEvent.length > 0 && (
        <div className="ga4w-chips">
          {c.byEvent.map((e) => (
            <span className="ga4w-chip" key={e.event}>
              {e.event} · {fmtInt(e.count)}
            </span>
          ))}
        </div>
      )}
      <div className="ga4w-note">
        אירועי מפתח מוגדרים בנפרד בכל נכס Google Analytics, ולכן אינם ניתנים
        להשוואה בין פרויקטים. ספירת הלידים הרשמית היא זו שב-CRM.
      </div>
    </div>
  );
}

/* ── New vs returning ─────────────────────────────────────────────── */

/**
 * The honest stand-in for "multi-channel journeys".
 *
 * GA4's Data API has no conversion path, assist or time-to-conversion
 * field, and a first-touch vs last-touch comparison proved redundant on
 * this estate — key-event totals are conserved exactly across the two
 * attributions and channel shares move under 1.2 points, because the
 * traffic is overwhelmingly single-session. What people actually want to
 * know is whether visitors convert on the first visit or come back to do
 * it, and that does vary a lot between projects.
 */
function Returning({ r }: { r: NonNullable<Ga4ReportData["returning"]> }) {
  const total = r.rows.reduce((n, x) => n + x.sessions, 0);
  if (total <= 0) return null;
  const ret = r.rows.find((x) => x.kind === "returning");
  const nw = r.rows.find((x) => x.kind === "new");
  // The lift is the point of the block — returning visitors are a small
  // slice of sessions and a much larger slice of conversions.
  const lift =
    ret && nw && nw.convRate > 0 ? ret.convRate / nw.convRate : null;

  return (
    <div className="ga4w-block">
      <h3 className="ga4w-h3">מבקרים חדשים מול חוזרים</h3>
      <table className="ga4w-table">
        <thead>
          <tr>
            <th>סוג מבקר</th>
            <th>כניסות</th>
            <th>חלק מהתנועה</th>
            <th>אירועי מפתח</th>
            <th>שיעור המרה</th>
          </tr>
        </thead>
        <tbody>
          {r.rows.map((x) => (
            <tr key={x.kind}>
              <td>{x.label}</td>
              <td>{fmtInt(x.sessions)}</td>
              <td>{fmtPct(x.sessions / total)}</td>
              <td>{fmtInt(x.keyEvents)}</td>
              <td>{fmtPct(x.convRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {lift && lift > 1.15 && (
        <div className="ga4w-note">
          מבקרים חוזרים ממירים פי {lift.toFixed(1)} ממבקרים חדשים — כלומר חלק
          מהלידים נסגר רק בביקור השני. זהו המדד הקרוב ביותר שקיים ב-Google
          Analytics למסע רב-ערוצי.
        </div>
      )}
    </div>
  );
}

/* ── Foreign traffic ──────────────────────────────────────────────── */

/**
 * Budget reaching traffic that cannot convert.
 *
 * Only renders above FOREIGN_MIN_SHARE. A few percent of overseas
 * traffic is normal and legitimate — Israelis travelling, agency staff,
 * VPNs — so showing this at every level would train people to ignore it.
 * The threshold is set where the pattern stops looking like travellers:
 * /mia-beer-yaakov ran at roughly half its traffic foreign, essentially
 * none of it converting.
 *
 * What makes this worth its own block rather than a line on the map is
 * that nothing else surfaces it. The foreign traffic's engagement rate
 * (0.51) is almost identical to Israel's (0.52), so it passes every
 * quality check in the section; only the country split gives it away.
 */
const FOREIGN_MIN_SHARE = 0.2;

function ForeignTraffic({
  abroad,
  israel,
}: {
  abroad: NonNullable<Ga4ReportData["abroad"]>;
  israel: Ga4ReportData["israel"];
}) {
  const total = abroad.sessions + (israel?.sessions ?? 0);
  if (total <= 0) return null;
  const share = abroad.sessions / total;
  if (share < FOREIGN_MIN_SHARE || abroad.sessions < 50) return null;

  // Rates come from GA session-weighted (see mergeRate), not keyEvents
  // over sessions — the derived ratio reported Israel at 11% against a
  // 4.6% headline for the same project.
  const foreignCvr = abroad.convRate;
  const israelCvr = israel?.convRate ?? 0;

  return (
    <div className="ga4w-block ga4w-alert">
      <h3 className="ga4w-h3">⚠️ תנועה מחוץ לישראל</h3>
      <p className="ga4w-alert-lead">
        {fmtPct(share)} מהכניסות לדף הגיעו מחוץ לישראל (
        {fmtInt(abroad.sessions)} כניסות). דף נחיתה בעברית לפרויקט נדל״ן בישראל
        לא אמור לקבל תנועה כזו בהיקף הזה — כדאי לבדוק את הגדרות המיקוד
        הגאוגרפי בקמפיינים.
      </p>
      <table className="ga4w-table">
        <thead>
          <tr>
            <th>מקור</th>
            <th>כניסות</th>
            <th>אירועי מפתח</th>
            <th>שיעור המרה</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>ישראל</td>
            <td>{fmtInt(israel?.sessions ?? 0)}</td>
            <td>{fmtInt(israel?.keyEvents ?? 0)}</td>
            <td>{fmtPct(israelCvr)}</td>
          </tr>
          <tr className="ga4w-alert-row">
            <td>מחוץ לישראל</td>
            <td>{fmtInt(abroad.sessions)}</td>
            <td>{fmtInt(abroad.keyEvents)}</td>
            <td>{fmtPct(foreignCvr)}</td>
          </tr>
        </tbody>
      </table>
      {abroad.topCountries.length > 0 && (
        <div className="ga4w-chips">
          {abroad.topCountries.map((c) => (
            <span className="ga4w-chip" key={c.country}>
              {c.country} · {fmtInt(c.sessions)}
            </span>
          ))}
        </div>
      )}
      <div className="ga4w-note">
        חלק מהתנועה הזו לגיטימית (ישראלים בחו״ל, VPN), אך כשהיקפה גבוה והמרות
        כמעט אפסיות מדובר לרוב בתנועת בוטים או במיקוד גאוגרפי רחב מדי.
      </div>
    </div>
  );
}

/* ── Placement leaks ──────────────────────────────────────────────── */

/**
 * Placements delivering real volume with zero conversions and mostly
 * foreign traffic.
 *
 * Sits below the country-level block because it answers the next
 * question: the country split says traffic is arriving from the wrong
 * place, this says which placement is buying it. Meta writes the
 * placement into utm_medium, so a single placement inside an otherwise
 * healthy campaign becomes visible — `Facebook_Right_Column` was גינדי's
 * largest placement by volume at 1,888 sessions and 0 conversions while
 * Facebook_Mobile_Feed converted 138 times from 534.
 *
 * Wording is deliberately restrained. This is client-visible, some of
 * these campaigns are run by other agencies, and "no conversions
 * recorded" is a fact while "someone is wasting your money" is an
 * accusation the data cannot support on its own.
 */
function PlacementLeaks({
  rows,
}: {
  rows: NonNullable<Ga4ReportData["placementLeaks"]>;
}) {
  const wasted = rows.reduce((n, r) => n + r.sessions, 0);
  return (
    <div className="ga4w-block ga4w-alert">
      <h3 className="ga4w-h3">⚠️ מיקומי פרסום ללא המרות</h3>
      <p className="ga4w-alert-lead">
        המיקומים הבאים הביאו {fmtInt(wasted)} כניסות לדף בתקופה, לא נרשמה בהם
        אף המרה, ורוב התנועה מהם הגיעה מחוץ לישראל. שווה לבדוק אותם בהגדרות
        המיקומים של הקמפיין.
      </p>
      <div className="ga4w-table-wrap">
        <table className="ga4w-table">
          <thead>
            <tr>
              <th>מיקום</th>
              <th>כניסות</th>
              <th>מחוץ לישראל</th>
              <th>מדינות עיקריות</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.placement}>
                <td className="ga4w-camp">{r.placement}</td>
                <td>{fmtInt(r.sessions)}</td>
                <td>{fmtPct(r.foreignShare)}</td>
                <td>{r.topCountries.join(" · ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ga4w-note">
        ״מיקום״ הוא שדה ה-utm_medium שמגיע מהפלטפורמה — במטא זהו מיקום המודעה
        (פיד, סטוריז, טור ימני), ובגוגל סוג הרכישה. מיקום ללא המרות אינו
        בהכרח תקלה, אך בשילוב עם תנועה שרובה מחוץ לישראל זהו לרוב סימן להגדרת
        מיקוד רחבה מדי.
      </div>
    </div>
  );
}

/* ── Campaign introduction credit ─────────────────────────────────── */

/**
 * Campaigns that brought in people who converted later under a different
 * campaign — first-touch credit exceeding last-touch credit.
 *
 * The one place first vs last touch genuinely diverges here. A
 * channel-level version of this was measured and rejected: key-event
 * totals are conserved exactly across the two attributions and channel
 * shares move under 1.2 points, so it would have drawn a chart that
 * always agrees with itself. At campaign level the difference is real,
 * because a campaign that stops running keeps its first-touch credit
 * while last-touch moves to whatever is live now.
 *
 * Called "הביאו לידים שנסגרו מאוחר יותר" rather than assisted
 * conversions — GA4 has no assist or path data, and this is the
 * narrower claim the data actually supports.
 */
function IntroCredit({ rows }: { rows: NonNullable<Ga4ReportData["intro"]> }) {
  return (
    <div className="ga4w-block">
      <h3 className="ga4w-h3">קמפיינים שהביאו לידים שנסגרו מאוחר יותר</h3>
      <table className="ga4w-table">
        <thead>
          <tr>
            <th>קמפיין</th>
            <th>הביא (מגע ראשון)</th>
            <th>סגר (מגע אחרון)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.campaign}>
              <td className="ga4w-camp">
                <ChannelIcon name={r.campaign} /> {r.campaign}
              </td>
              <td>{fmtInt(r.introKeyEvents)}</td>
              <td>{fmtInt(r.closeKeyEvents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ga4w-note">
        אלה קמפיינים שהמשתמש נחשף אליהם בביקור הראשון, אך ההמרה עצמה נרשמה
        בביקור מאוחר יותר — לרוב קמפיינים שכבר אינם רצים. הפילוח לפי קמפיין
        שלמעלה מייחס את ההמרה למגע האחרון בלבד, ולכן קמפיינים אלה אינם מופיעים
        בו.
      </div>
    </div>
  );
}

/* ── Devices ──────────────────────────────────────────────────────── */

function Devices({
  rows,
  hasKeyEvents,
}: {
  rows: NonNullable<Ga4ReportData["devices"]>;
  hasKeyEvents: boolean;
}) {
  const total = rows.reduce((n, r) => n + r.sessions, 0);
  if (total <= 0) return null;

  // Donut rather than a pie: these splits are extremely lopsided (96%
  // mobile is typical here), so a filled pie is one colour with two
  // slivers. The hole carries the dominant share as a label, which is
  // the number anyone actually reads off this chart.
  const R = 15.9155; // circumference 100, so dash lengths ARE percentages
  const C = 100;
  let offset = 25; // rotate so the first segment starts at 12 o'clock
  const arcs = rows
    .filter((r) => r.sessions > 0)
    .map((r) => {
      const pct = (r.sessions / total) * 100;
      const arc = { ...r, pct, dash: `${pct} ${C - pct}`, offset };
      offset = (offset - pct + C) % C;
      return arc;
    });
  const top = rows.reduce((a, b) => (b.sessions > a.sessions ? b : a), rows[0]);

  return (
    <div className="ga4w-block">
      <h3 className="ga4w-h3">לפי מכשיר</h3>
      <div className="ga4w-donut-wrap">
        <svg viewBox="0 0 42 42" className="ga4w-donut" role="img" aria-label="פילוח לפי מכשיר">
          <circle className="ga4w-donut-track" cx="21" cy="21" r={R} />
          {arcs.map((a) => (
            <circle
              key={a.device}
              className={`ga4w-donut-seg is-dev-${a.device}`}
              cx="21"
              cy="21"
              r={R}
              strokeDasharray={a.dash}
              strokeDashoffset={a.offset}
            >
              <title>{`${a.label}: ${fmtInt(a.sessions)} (${fmtPct(a.sessions / total)})`}</title>
            </circle>
          ))}
          <text className="ga4w-donut-pct" x="21" y="20.6">
            {fmtPct(top.sessions / total)}
          </text>
          <text className="ga4w-donut-lbl" x="21" y="24.6">
            {top.label}
          </text>
        </svg>
        <table className="ga4w-table ga4w-donut-side">
        <thead>
          <tr>
            <th>מכשיר</th>
            <th>כניסות</th>
            <th>חלק מהתנועה</th>
            {/* The conversion-rate column only earns its place when the
                property tags key events — otherwise it is a column of
                0% that looks like every device fails to convert. */}
            {hasKeyEvents && <th>שיעור המרה</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.device}>
              <td>
                <span className={`ga4w-dot is-dev-${r.device}`} aria-hidden="true" />
                {r.label}
              </td>
              <td>{fmtInt(r.sessions)}</td>
              <td>{fmtPct(r.sessions / total)}</td>
              {hasKeyEvents && <td>{fmtPct(r.keyEventRate)}</td>}
            </tr>
          ))}
        </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Pages ────────────────────────────────────────────────────────── */

function Pages({
  rows,
  host,
}: {
  rows: { path: string; sessions: number; engagementRate: number; avgSeconds: number }[];
  host: string;
}) {
  return (
    <div className="ga4w-block">
      <h3 className="ga4w-h3">לפי עמוד נחיתה</h3>
      <table className="ga4w-table">
        <thead>
          <tr>
            <th>עמוד</th>
            <th>כניסות</th>
            <th>גלישה מעורבת</th>
            <th>זמן ממוצע</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.path}>
              <td>
                <code className="ga4-source-path">
                  {host}
                  {p.path}
                </code>
              </td>
              <td>{fmtInt(p.sessions)}</td>
              <td>{fmtPct(p.engagementRate)}</td>
              <td>{fmtDuration(p.avgSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Bits ─────────────────────────────────────────────────────────── */

function Kpi({
  label,
  value,
  delta: d,
  hint,
}: {
  label: string;
  value: string;
  delta: number | null;
  hint?: string;
}) {
  return (
    <div className="ga4-kpi" title={hint}>
      <div className="ga4-kpi-label">{label}</div>
      <div className="ga4-kpi-value">{value}</div>
      {d !== null && (
        <div className={`ga4w-delta is-${d > 0 ? "up" : d < 0 ? "down" : "flat"}`}>
          {d > 0 ? "▲" : d < 0 ? "▼" : "="} {fmtPct(Math.abs(d))}
        </div>
      )}
    </div>
  );
}

/** Relative change, or null when there is no baseline to compare to —
 *  a jump from 0 is not "+100%", it has no defined ratio. */
function delta(cur: number, prev: number): number | null {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
  return (cur - prev) / prev;
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
function fmtDate(isoDate: string): string {
  // GA4 returns the date dimension as YYYYMMDD, the window as YYYY-MM-DD.
  const clean = isoDate.replace(/-/g, "");
  if (clean.length !== 8) return isoDate;
  return `${clean.slice(6, 8)}/${clean.slice(4, 6)}`;
}
function fmtRange(a: string, b: string): string {
  return `${fmtDate(a)} – ${fmtDate(b)}`;
}
