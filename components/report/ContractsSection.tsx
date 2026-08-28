"use client";

import { useEffect, useMemo, useState } from "react";
import ChannelIcon from "@/components/ChannelIcon";

/**
 * חוזים — what the project's sales are made of.
 *
 * The מכירות bar answers "how many". This answers "which channels closed
 * them, who closed them, and how long it took" — off the same CRM records
 * the dossier panel opens, fetched from the same internal-only endpoint so
 * customer names never enter the page payload (see lib/signedClients).
 *
 * SIGNED and OPPORTUNITY are reported apart throughout. BMBY tenants write
 * the sale in different fields and with different words — "חוזה", "ברכישה",
 * "הסכם ראשוני" are commitments; "הזדמנות מכירה" is the stage before one.
 * Merging them would inflate לוריא from 4 to 8, so the headline counts
 * commitments and the opportunities sit beside it as their own number.
 */

type Client = {
  clientId: string;
  name: string;
  salesperson: string;
  source: string;
  mediaSource: string;
  rooms: string;
  dealType: string;
  leadCreated: string;
  firstTouch: string;
  lastTouch: string;
  touchesCount: number;
  meetingsCount: number;
  saleStage: "signed" | "opportunity";
  saleLabel: string;
};

type Payload = {
  ok: boolean;
  total?: number;
  opportunities?: number;
  withJourney?: number;
  clients?: Client[];
  reason?: string;
  platform?: string;
};

/** Days from the lead arriving to its last recorded touch — the closest
 *  thing to a sales cycle the warehouse holds, since BMBY records no
 *  signing date. Null when either end is missing. */
function cycleDays(c: Client): number | null {
  const a = c.leadCreated || c.firstTouch;
  const b = c.lastTouch;
  if (!a || !b) return null;
  const d = Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000,
  );
  return Number.isFinite(d) && d >= 0 ? d : null;
}

function median(ns: number[]): number | null {
  if (!ns.length) return null;
  const s = [...ns].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** The row's own media source. `source_agg` lists every channel the client
 *  ever touched, which would credit one sale to five of them; the cleaned
 *  single source is the one BMBY itself attributes the lead to. */
function sourceOf(c: Client): string {
  return c.mediaSource || c.source.split(",")[0]?.trim() || "לא ידוע";
}

export default function ContractsSection({
  project,
  company,
  from,
  to,
}: {
  project: string;
  company: string;
  from: string;
  to: string;
}) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [data, setData] = useState<Payload | null>(null);

  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams({ project, company, from, to });
    fetch(`/api/crm/signed?${qs.toString()}`)
      .then((r) => r.json())
      .then((j: Payload) => {
        if (!alive) return;
        setData(j);
        setState(j?.ok ? "ready" : "error");
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
    };
  }, [project, company, from, to]);

  const clients = useMemo(() => data?.clients ?? [], [data]);
  const signed = useMemo(
    () => clients.filter((c) => c.saleStage === "signed"),
    [clients],
  );

  const stats = useMemo(() => {
    const cyc = signed.map(cycleDays).filter((n): n is number => n != null);
    const touches = signed.map((c) => c.touchesCount).filter((n) => n > 0);
    const meets = signed.map((c) => c.meetingsCount).filter((n) => n > 0);
    // The sample size travels with every median. On לוריא the cycle median
    // rests on 3 of 4 signed clients — a number that small has to say so, or
    // it reads with the authority of a portfolio statistic.
    return {
      medianDays: median(cyc),
      nDays: cyc.length,
      medianTouches: median(touches),
      nTouches: touches.length,
      medianMeetings: median(meets),
      nMeetings: meets.length,
    };
  }, [signed]);

  /** Channels ranked by closes. Only the signed ones count — an opportunity
   *  has not closed anything yet. */
  const bySource = useMemo(() => {
    const m = new Map<string, { signed: number; opp: number }>();
    for (const c of clients) {
      const k = sourceOf(c);
      const r = m.get(k) ?? { signed: 0, opp: 0 };
      if (c.saleStage === "signed") r.signed++;
      else r.opp++;
      m.set(k, r);
    }
    return [...m.entries()]
      .map(([label, v]) => ({ label, ...v }))
      .sort((a, b) => b.signed - a.signed || b.opp - a.opp);
  }, [clients]);

  const byPerson = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of signed) {
      const k = c.salesperson || "—";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([label, n]) => ({ label, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 6);
  }, [signed]);

  if (state === "loading") return <div className="rpt-empty">טוען חוזים…</div>;
  if (state === "error")
    return <div className="rpt-empty">לא הצלחתי לטעון את נתוני החוזים.</div>;
  if (data?.reason === "not-bmby")
    return (
      <div className="rpt-empty">
        ניתוח החוזים נשען על שדות המכירה של BMBY. הפרויקט הזה על{" "}
        {data.platform?.toUpperCase()}, ושם הם לא קיימים באותה צורה.
      </div>
    );
  if (data?.reason === "no-crm")
    return <div className="rpt-empty">אין לפרויקט הזה חשבון CRM ב-Keys.</div>;
  if (!clients.length)
    return (
      <div className="rpt-empty">
        אין לקוחות בשלב מכירה ב-CRM לפרויקט הזה.
      </div>
    );

  const maxSrc = Math.max(...bySource.map((s) => s.signed + s.opp), 1);

  return (
    <div className="ct-wrap" dir="rtl">
      <div className="ct-tiles">
        <div className="ct-tile">
          <div className="ct-tile-v">{data?.total ?? signed.length}</div>
          <div className="ct-tile-l">חתמו</div>
        </div>
        <div className="ct-tile ct-tile-soft">
          <div className="ct-tile-v">{data?.opportunities ?? 0}</div>
          <div className="ct-tile-l">בשלב מכירה</div>
        </div>
        <div className="ct-tile">
          <div className="ct-tile-v">
            {stats.medianDays != null ? stats.medianDays : "—"}
          </div>
          <div className="ct-tile-l">
            ימים לסגירה (חציון)
            {stats.nDays > 0 && <span className="ct-tile-n">מתוך {stats.nDays}</span>}
          </div>
        </div>
        <div className="ct-tile">
          <div className="ct-tile-v">
            {stats.medianTouches != null ? stats.medianTouches : "—"}
          </div>
          <div className="ct-tile-l">
            מגעים עד סגירה (חציון)
            {stats.nTouches > 0 && (
              <span className="ct-tile-n">מתוך {stats.nTouches}</span>
            )}
          </div>
        </div>
        <div className="ct-tile">
          <div className="ct-tile-v">
            {stats.medianMeetings != null ? stats.medianMeetings : "—"}
          </div>
          <div className="ct-tile-l">
            פגישות עד סגירה (חציון)
            {stats.nMeetings > 0 && (
              <span className="ct-tile-n">מתוך {stats.nMeetings}</span>
            )}
          </div>
        </div>
      </div>

      {/* Medians, not averages: one client who lingered 400 days drags a mean
          badly on a set this small. */}
      <p className="ct-note">
        &quot;ימים לסגירה&quot; נמדד מכניסת הליד ועד המגע האחרון — ב-BMBY אין
        תאריך חתימה, ולכן זו הקירוב הקרוב ביותר. חציון ולא ממוצע, כי לקוח
        בודד שנמשך שנה מטה ממוצע על קבוצה קטנה. &quot;מתוך&quot; הוא מספר
        הלקוחות שהיה להם נתון — לא לכולם רשום תאריך מגע אחרון.
      </p>

      <div className="ct-cols">
        <div className="ct-col">
          <div className="ct-col-title">
            מקורות שסוגרים
            <span className="ct-col-legend">חתמו · בשלב מכירה</span>
          </div>
          {bySource.map((s) => (
            <div
              key={s.label}
              className="ct-row"
              title={`${s.label}: ${s.signed} חתמו${s.opp ? ` · ${s.opp} בשלב מכירה` : ""}`}
            >
              <div
                className="ct-bar"
                style={{ width: `${Math.max(4, ((s.signed + s.opp) / maxSrc) * 100)}%` }}
              />
              <span className="ct-row-label">
                <ChannelIcon name={s.label} fallback="●" /> {s.label}
              </span>
              <span className="ct-row-nums">
                <b>{s.signed}</b>
                {s.opp > 0 && <span className="ct-row-opp">{s.opp}</span>}
              </span>
            </div>
          ))}
        </div>

        <div className="ct-col">
          <div className="ct-col-title">אנשי מכירות</div>
          {byPerson.length === 0 ? (
            <div className="ct-empty">לא נרשם איש מכירות</div>
          ) : (
            byPerson.map((p) => (
              <div key={p.label} className="ct-row ct-row-plain">
                <span className="ct-row-label">{p.label}</span>
                <span className="ct-row-nums">
                  <b>{p.n}</b>
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="ct-col-title ct-list-title">
        כל הלקוחות
        <span className="ct-col-legend">
          לפרטים מלאים ומסע הלקוח — לחצו על מכירות במשפך שבסקירת פעילות
        </span>
      </div>
      <div className="ct-table-wrap">
        <table className="ct-table">
          <thead>
            <tr>
              <th>לקוח</th>
              <th>שלב</th>
              <th>מקור</th>
              <th>איש מכירות</th>
              <th>חדרים</th>
              <th>ליד נכנס</th>
              <th>ימים</th>
              <th>מגעים</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => {
              const d = cycleDays(c);
              return (
                <tr
                  key={c.clientId}
                  className={c.saleStage === "opportunity" ? "is-opp" : ""}
                >
                  <td>{c.name || "—"}</td>
                  <td>
                    <span
                      className={
                        "ct-stage" +
                        (c.saleStage === "signed" ? " is-signed" : " is-opp")
                      }
                    >
                      {c.saleLabel || (c.saleStage === "signed" ? "חוזה" : "—")}
                    </span>
                  </td>
                  <td className="ct-src">
                    <ChannelIcon name={sourceOf(c)} fallback="●" /> {sourceOf(c)}
                  </td>
                  <td>{c.salesperson || "—"}</td>
                  <td>{c.rooms || "—"}</td>
                  <td className="ct-num">
                    {c.leadCreated
                      ? c.leadCreated.slice(8, 10) +
                        "/" +
                        c.leadCreated.slice(5, 7) +
                        "/" +
                        c.leadCreated.slice(2, 4)
                      : "—"}
                  </td>
                  <td className="ct-num">{d != null ? d : "—"}</td>
                  <td className="ct-num">{c.touchesCount || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
