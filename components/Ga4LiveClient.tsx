"use client";

import { useEffect, useState } from "react";
import type { Ga4Live, Ga4Window } from "@/lib/ga4";

export type Ga4Payload = {
  live: Ga4Live;
  today: Ga4Window | null;
  last7: Ga4Window | null;
};

/**
 * The polling half of the GA4 section. Server-rendered with `initial`
 * so the first paint already has numbers, then refreshes in place.
 *
 * 45s interval: GA4's realtime window is the trailing 30 MINUTES, so
 * polling faster buys almost nothing — a visitor who arrives now stays
 * in the count for half an hour either way. Polling also pauses while
 * the tab is hidden, which matters because this section is client-
 * visible and a client may leave the page open all day.
 */
export default function Ga4LiveClient({
  project,
  initial,
}: {
  project: string;
  initial: Ga4Payload;
}) {
  const [data, setData] = useState<Ga4Payload>(initial);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // A self-rescheduling setTimeout chain is the obvious shape here and
    // it is wrong: the visibilitychange refresh starts a SECOND chain
    // while the first is still in flight, each chain re-arms itself, and
    // the clearTimeout only ever cancels the most recently stored handle.
    // Measured 10 requests inside 13ms before this was rewritten. A plain
    // interval cannot multiply, and inFlight stops overlap.
    let inFlight = false;
    let lastAt = 0;

    const tick = async () => {
      if (cancelled || inFlight || document.hidden) return;
      // Floor between fetches so rapid tab switching can't hammer GA.
      if (Date.now() - lastAt < 10_000) return;
      inFlight = true;
      lastAt = Date.now();
      try {
        const res = await fetch(
          `/api/analytics/live?project=${encodeURIComponent(project)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as
          | ({ ok: true } & Ga4Payload)
          | { ok: false };
        if (cancelled) return;
        if (json.ok) {
          setData({ live: json.live, today: json.today, last7: json.last7 });
          setStale(false);
        } else {
          // Keep the last good numbers on screen rather than blanking the
          // section on a transient failure — just mark them as aging.
          setStale(true);
        }
      } catch {
        if (!cancelled) setStale(true);
      } finally {
        inFlight = false;
      }
    };

    const id = setInterval(tick, 45_000);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [project]);

  const { live, today, last7 } = data;
  const n = live.activeUsers;
  // Three distinct states, because "0 key events" is ambiguous:
  //   attributed  — conversions land on a page we can tie to THIS project
  //   site-wide   — the property tags conversions but funnels every
  //                 project through one shared thank-you page, so the
  //                 number is real but cannot be split per project
  //   none        — the property tags no key events at all → show nothing
  const keAttributed = (last7?.keyEvents ?? 0) > 0 || (today?.keyEvents ?? 0) > 0;
  const keSiteOnly =
    !keAttributed &&
    ((last7?.keyEventsSite ?? 0) > 0 || (today?.keyEventsSite ?? 0) > 0);

  return (
    <>
      <div className="ga4-hero">
        <div className={`ga4-hero-num${n > 0 ? " is-live" : ""}`}>
          {n > 0 && <span className="ga4-dot" aria-hidden="true" />}
          {fmtNum(n)}
        </div>
        <div className="ga4-hero-cap">
          {n === 1 ? "גולש אחד בדף עכשיו" : "גולשים בדף עכשיו"}
        </div>
        {!live.scoped && (
          <div className="ga4-hero-note">
            המספר הוא ברמת הדומיין ({"כולל פרויקטים נוספים באותו אתר"})
          </div>
        )}
        {stale && <div className="ga4-hero-note">הנתונים לא התרעננו כרגע</div>}
      </div>

      {n > 0 && (
        <div className="ga4-chips">
          {live.byDevice.mobile > 0 && (
            <span className="ga4-chip">📱 מובייל {live.byDevice.mobile}</span>
          )}
          {live.byDevice.desktop > 0 && (
            <span className="ga4-chip">🖥 דסקטופ {live.byDevice.desktop}</span>
          )}
          {live.byDevice.tablet > 0 && (
            <span className="ga4-chip">טאבלט {live.byDevice.tablet}</span>
          )}
          {live.topCities.map((c) => (
            <span className="ga4-chip ga4-chip-city" key={c.city}>
              📍 {c.city} {c.users}
            </span>
          ))}
          {live.keyEvents > 0 && (
            <span className="ga4-chip ga4-chip-key">
              ✨ אירועי מפתח {live.keyEvents}
            </span>
          )}
        </div>
      )}

      <div className="ga4-kpi-grid">
        <Kpi label="משתמשים היום" value={fmtNum(today?.users)} />
        <Kpi label="סשנים היום" value={fmtNum(today?.sessions)} />
        <Kpi label="משתמשים ב-7 ימים" value={fmtNum(last7?.users)} />
        <Kpi label="סשנים ב-7 ימים" value={fmtNum(last7?.sessions)} />
        {keAttributed && (
          <>
            <Kpi label="אירועי מפתח היום" value={fmtNum(today?.keyEvents)} />
            <Kpi label="אירועי מפתח ב-7 ימים" value={fmtNum(last7?.keyEvents)} />
          </>
        )}
        {keSiteOnly && (
          <Kpi
            label="אירועי מפתח ב-7 ימים · באתר כולו"
            value={fmtNum(last7?.keyEventsSite)}
          />
        )}
      </div>

      {keSiteOnly && (
        <div className="ga4-hero-note ga4-note-block">
          אירועי המפתח באתר זה נרשמים כולם בדף תודה משותף, ולכן לא ניתן לשייך
          אותם לפרויקט מסוים — המספר מתייחס לכל הפרויקטים באתר.
        </div>
      )}
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="ga4-kpi">
      <div className="ga4-kpi-label">{label}</div>
      <div className="ga4-kpi-value">{value}</div>
    </div>
  );
}

function fmtNum(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}
