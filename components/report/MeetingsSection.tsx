"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import ChannelIcon from "@/components/ChannelIcon";
import ClientDossier, {
  type DossierClient,
} from "@/components/report/ClientDossier";
import { BasisBadge } from "@/components/report/BasisBadge";
import type { HeldMeeting } from "@/lib/heldMeetings";

/**
 * פגישות שהתקיימו — the meetings the project actually held in the window.
 *
 * The funnel counts them; this says who they were with, where that person
 * came from, and what the salesperson wrote down afterwards. Before it, a
 * client file could only be opened from חוזים, which lists people who
 * reached a sale stage — 18 of the 422 people met across the ten busiest
 * projects in August. The other 404 were a number and nothing else.
 *
 * Structured like ContractsSection on purpose: same tiles, same table, and
 * the SAME drawer, so a client reads identically whichever door was used.
 *
 * ── Against the page's meeting-count switch ──
 * It does not follow it and never reads it: a list of meetings that took
 * place is dated by nature, so it wears the fixed "תמיד לפי מועד הפגישה"
 * badge instead, and a flip changes nothing here. What it shares with the
 * dated basis is the meaning of a ביצוע. The tile counts confirmed meetings
 * only (the route's `authoritativeHeld`), so it equals "לפי מועד הפגישה"
 * ביצועים for the same window — The 57, September 2026: 15 and 15. Before,
 * it also counted meetings BMBY never marked, inferred from the client's
 * status, and could sit above the number the rest of the page showed. Those
 * rows are still listed, marked "משוער", and the tile names how many.
 */

/** Copy for the inferred rows — BMBY only; Sehel has no such tier. */
const ESTIMATED_ROW_TITLE =
  "ב-BMBY לא סומנה לפגישה הזו תוצאה. היא ברשימה כי הסטטוס של הלקוח מעיד שהתקיימה, אבל אינה נספרת באריח ״פגישות שהתקיימו״ — כמו שאינה נספרת בביצועים בשאר הדוח.";
const ESTIMATED_TILE_TITLE =
  "פגישות שב-BMBY לא סומנה להן תוצאה, והסטטוס של הלקוח מעיד שהתקיימו. הן מופיעות בטבלה ומסומנות ״משוער״, ואינן נספרות במספר שלמעלה — כמו שאינן נספרות בביצועים בשאר הדוח.";

type Payload = {
  ok: boolean;
  /** Every meeting in the list, inferred ones included. */
  total?: number;
  /** Confirmed only — the tile. total − this = the "משוער" rows. */
  authoritativeHeld?: number;
  clientsMet?: number;
  withNotes?: number;
  meetings?: HeldMeeting[];
  clients?: DossierClient[];
  reason?: string;
  platform?: string;
  /** How many of the project's CRM accounts the meetings sync has not
   *  reached — see getUnsyncedMeetingAccounts for the proof it requires. */
  notSynced?: number;
  /** How many accounts were checked; equal to notSynced when none of the
   *  project's accounts is synced. */
  syncChecked?: number;
  /** Which ones, and which proof fired — sent to staff only.
   *  missingClients null: not one meeting row for the account on any date.
   *  A number: that many meeting-stage clients in the window, none with a
   *  meeting row, on an account that has some. */
  notSyncedAccounts?: { account: string; missingClients: number | null }[];
};

const quoteList = (names: string[]) => names.map((n) => `״${n}״`).join(", ");

function fmtDay(iso: string): string {
  if (!iso || iso.length < 10) return "—";
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Objections are comma-joined on the client record. */
function objectionList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function MeetingsSection({
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
  const [openClient, setOpenClient] = useState<DossierClient | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!openClient) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenClient(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openClient]);

  useEffect(() => {
    let alive = true;
    setState("loading");
    const qs = new URLSearchParams({ project, company, from, to });
    fetch(`/api/crm/meetings?${qs.toString()}`)
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

  const meetings = useMemo(() => data?.meetings ?? [], [data]);
  const byClient = useMemo(() => {
    const m = new Map<string, DossierClient>();
    for (const c of data?.clients ?? []) m.set(c.clientId, c);
    return m;
  }, [data]);

  /** Which channels brought the people who were actually met. Counted per
   *  MEETING, matching the number in the tile above it — a client met twice
   *  is two meetings and the reader is comparing against a meeting count.
   *  Confirmed and inferred are kept apart for the same reason: the bold
   *  number adds up to the tile, the muted one to the "משוערות" beside it. */
  const bySource = useMemo(() => {
    const m = new Map<string, { n: number; est: number }>();
    for (const x of meetings) {
      const k = x.firstSource || "לא ידוע";
      const v = m.get(k) ?? { n: 0, est: 0 };
      if (x.estimated) v.est++;
      else v.n++;
      m.set(k, v);
    }
    return [...m.entries()]
      .map(([label, v]) => ({ label, ...v }))
      .sort((a, b) => b.n - a.n || b.est - a.est);
  }, [meetings]);

  /** Objections across the people met. Counted once per CLIENT, not per
   *  meeting: the column belongs to the client record, so counting it twice
   *  for someone met twice would invent a trend out of a second visit. */
  const byObjection = useMemo(() => {
    const m = new Map<string, number>();
    const seen = new Set<string>();
    for (const x of meetings) {
      if (seen.has(x.clientId)) continue;
      seen.add(x.clientId);
      for (const o of objectionList(byClient.get(x.clientId)?.objections ?? ""))
        m.set(o, (m.get(o) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([label, n]) => ({ label, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
  }, [meetings, byClient]);

  if (state === "loading") return <div className="rpt-empty">טוען פגישות…</div>;
  // "unavailable" is the route's word for a warehouse read that failed. It
  // used to fall through to "no meetings were held", reporting an outage
  // as a fact about the project.
  if (state === "error" || data?.reason === "unavailable")
    return <div className="rpt-empty">לא הצלחתי לטעון את נתוני הפגישות.</div>;
  if (data?.reason === "unsupported-platform")
    return (
      <div className="rpt-empty">
        הפגישות נקראות מ-BMBY ומ-Sehel. ב-{data.platform?.toUpperCase()} אין
        טבלת פגישות כלל — ה-CRM שלו הוא טאב בגיליון — ולכן הסקשן לא נפתח כאן.
      </div>
    );
  if (data?.reason === "no-crm")
    return <div className="rpt-empty">אין לפרויקט הזה חשבון CRM ב-Keys.</div>;
  const unsyncedCount = data?.notSynced ?? 0;
  const unsyncedAccounts = data?.notSyncedAccounts ?? [];
  // An account the sync has not reached has no meeting rows to count, so an
  // empty list there says nothing about whether meetings happened. Worded
  // for the whole project only when every account it has is the problem —
  // on חמסה one account of five is, and the other four may simply have held
  // nothing in the window.
  if (!meetings.length && unsyncedCount > 0)
    return (
      <div className="rpt-empty">
        {unsyncedCount === data?.syncChecked
          ? "הפגישות של הפרויקט הזה עוד לא מסונכרנות מה-CRM, ולכן אין כאן רשימה — זה לא אומר שלא התקיימו פגישות."
          : `${
              unsyncedCount === 1
                ? "חשבון CRM אחד של הפרויקט עוד לא מסונכרן"
                : `${unsyncedCount} חשבונות CRM של הפרויקט עוד לא מסונכרנים`
            }, ולכן רשימה ריקה כאן לא אומרת שלא התקיימו פגישות.`}
        {unsyncedAccounts.length > 0 && (
          <div className="rpt-empty-why">
            {unsyncedAccounts.map((a) => (
              <div key={a.account}>
                ״{a.account}״:{" "}
                {a.missingClients == null
                  ? "יש בטווח הדוח לידים בשלב פגישה, ואין במחסן הנתונים אף פגישה של החשבון, מאף תאריך — הוא לא נכלל בסנכרון הפגישות."
                  : `ל-${a.missingClients} לקוחות שבשלב פגישה בטווח הדוח אין אף פגישה במחסן הנתונים — החשבון מסונכרן רק בחלקו.`}
              </div>
            ))}
            <div>התיקון הוא בסנכרון הפגישות, לא בדוח.</div>
          </div>
        )}
      </div>
    );
  if (!meetings.length)
    return (
      <div className="rpt-empty">
        לא התקיימו פגישות בטווח התאריכים של הדוח.
        <BasisBadge kind="heldMeetings" />
      </div>
    );

  const anyKind = meetings.some((m) => m.kind);
  const maxSrc = Math.max(...bySource.map((s) => s.n + s.est), 1);
  const maxObj = Math.max(...byObjection.map((s) => s.n), 1);
  const repeat = meetings.filter((m) => m.seq > 1).length;
  // From the route's uncapped counts; the list fallback only covers a
  // payload from before authoritativeHeld existed.
  const listed = data?.total ?? meetings.length;
  const confirmed =
    data?.authoritativeHeld ?? meetings.filter((m) => !m.estimated).length;
  const estimated = Math.max(0, listed - confirmed);

  return (
    <div className="ct-wrap" dir="rtl">
      {/* Its own line, not a grid item: .ct-wrap is a grid and would
          stretch a bare badge across the full width. */}
      <div>
        <BasisBadge kind="heldMeetings" />
      </div>
      <div className="ct-tiles">
        <div className="ct-tile">
          <div className="ct-tile-v">{confirmed}</div>
          <div className="ct-tile-l">
            פגישות שהתקיימו
            {estimated > 0 && (
              <span className="ct-tile-n" title={ESTIMATED_TILE_TITLE}>
                {estimated === 1
                  ? "ועוד אחת משוערת"
                  : `ועוד ${estimated} משוערות`}
              </span>
            )}
          </div>
        </div>
        <div className="ct-tile">
          <div className="ct-tile-v">{data?.clientsMet ?? 0}</div>
          <div className="ct-tile-l">לקוחות שנפגשו</div>
        </div>
        <div className="ct-tile">
          <div className="ct-tile-v">{repeat}</div>
          <div className="ct-tile-l">פגישות המשך</div>
        </div>
        <div className="ct-tile">
          <div className="ct-tile-v">{data?.withNotes ?? 0}</div>
          <div className="ct-tile-l">
            עם סיכום כתוב
            <span className="ct-tile-n">מתוך {meetings.length}</span>
          </div>
        </div>
      </div>

      {unsyncedCount > 0 && (
        <p className="ct-note">
          <b>
            הרשימה חלקית:{" "}
            {unsyncedCount === 1
              ? "חשבון CRM אחד של הפרויקט לא מסונכרן במלואו, ופגישות שלו חסרות כאן"
              : `${unsyncedCount} חשבונות CRM של הפרויקט לא מסונכרנים במלואם, ופגישות שלהם חסרות כאן`}
            {unsyncedAccounts.length > 0 &&
              ` (${quoteList(unsyncedAccounts.map((a) => a.account))})`}
            .
          </b>
        </p>
      )}
      <p className="ct-note">
        נספרות פגישות לפי <b>מועד קיומן</b> בתוך טווח הדוח, לא לפי מועד
        התיאום — שתי אוכלוסיות שונות. הסיכום הוא מה שאיש המכירות כתב ב-CRM;
        פגישה בלי סיכום היא פגישה שלא תועדה, לא פגישה שלא קרתה.
      </p>

      <div className="ct-cols">
        <div className="ct-col">
          <div className="ct-col-title">
            מאיפה הגיעו
            <span className="ct-col-legend">
              לפי הערוץ שפתח את הליד
              {estimated > 0 && " · התקיימו · משוערות"}
            </span>
          </div>
          {bySource.map((s) => (
            <div
              key={s.label}
              className="ct-row"
              title={`${s.label}: ${s.n}${s.est ? ` · ועוד ${s.est} ${s.est === 1 ? "משוערת" : "משוערות"}` : ""}`}
            >
              <div
                className="ct-bar"
                style={{ width: `${Math.max(4, ((s.n + s.est) / maxSrc) * 100)}%` }}
              />
              <span className="ct-row-label">
                <ChannelIcon name={s.label} fallback="●" /> {s.label}
              </span>
              <span className="ct-row-nums">
                <b>{s.n}</b>
                {s.est > 0 && <span className="ct-row-opp">{s.est}</span>}
              </span>
            </div>
          ))}
        </div>

        <div className="ct-col">
          <div className="ct-col-title">
            התנגדויות
            <span className="ct-col-legend">על תיק הלקוח · לא פר פגישה</span>
          </div>
          {byObjection.length === 0 ? (
            <div className="ct-empty">לא נרשמו התנגדויות</div>
          ) : (
            byObjection.map((o) => (
              <div key={o.label} className="ct-row" title={`${o.label}: ${o.n}`}>
                <div
                  className="ct-bar is-obj"
                  style={{ width: `${Math.max(4, (o.n / maxObj) * 100)}%` }}
                />
                <span className="ct-row-label">{o.label}</span>
                <span className="ct-row-nums">
                  <b>{o.n}</b>
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="ct-col-title ct-list-title">
        כל הפגישות
        <span className="ct-col-legend">
          לחצו על שורה לפתיחת תיק הלקוח · לחצו על סיכום כדי לפרוס אותו
        </span>
      </div>
      <div className="ct-table-wrap">
        <table className="ct-table mt-table">
          <thead>
            <tr>
              <th>התקיימה</th>
              <th>לקוח</th>
              <th>מקור</th>
              <th>איש מכירות</th>
              {/* Sehel names the kind of meeting (פרזנטציה, חתימת הסכם);
                  BMBY only numbers them. One column, whichever the row
                  has — a project on both CRMs shows each row's own. */}
              <th>{anyKind ? "סוג" : "מס׳"}</th>
              <th>ימים מהליד</th>
              <th>סיכום</th>
            </tr>
          </thead>
          <tbody>
            {meetings.map((m) => {
              const c = byClient.get(m.clientId);
              const key = m.meetingId || `${m.clientId}-${m.date}`;
              const isOpen = expanded === key;
              const text = m.note || m.subject;
              return (
                <tr key={key}>
                  {/* Sehel records one timestamp — when the meeting is —
                      so there is no booked date to name on those rows. */}
                  <td
                    className="ct-num"
                    title={m.bookedDate ? `תואמה ב-${fmtDay(m.bookedDate)}` : undefined}
                  >
                    {fmtDay(m.date)}
                    {/* Inferred, not confirmed — listed, but outside the
                        tile's count. */}
                    {m.estimated && (
                      <BasisBadge
                        label="משוער"
                        title={ESTIMATED_ROW_TITLE}
                        tone="fallback"
                      />
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="mt-client"
                      title="פתיחת תיק הלקוח — כל המסע מהמגע הראשון"
                      onClick={() => c && setOpenClient(c)}
                      disabled={!c}
                    >
                      {c?.name || "—"}
                    </button>
                  </td>
                  <td className="ct-src">
                    <ChannelIcon name={m.firstSource} fallback="●" />{" "}
                    {m.firstSource || "—"}
                    {m.sourceMoved && (
                      <span
                        className="mt-moved"
                        title={`נפתח דרך ${m.firstSource}, הגיע לפגישה דרך ${m.lastSource}`}
                      >
                        ← {m.lastSource}
                      </span>
                    )}
                  </td>
                  <td>{m.agents[0] || "—"}
                    {m.agents.length > 1 && (
                      <span className="mt-more" title={m.agents.join(", ")}>
                        +{m.agents.length - 1}
                      </span>
                    )}
                  </td>
                  <td className="ct-num" title={m.seq > 1 ? `פגישה מספר ${m.seq}` : undefined}>
                    {m.kind ? (
                      <>
                        {m.kind}
                        {m.seq > 1 && <span className="mt-more">#{m.seq}</span>}
                      </>
                    ) : m.seq > 1 ? (
                      `#${m.seq}`
                    ) : (
                      "1"
                    )}
                  </td>
                  <td className="ct-num">
                    {m.leadAgeDays == null ? "—" : m.leadAgeDays}
                  </td>
                  <td className="mt-note-cell">
                    {text ? (
                      <button
                        type="button"
                        className={"mt-note" + (isOpen ? " is-open" : "")}
                        onClick={() => setExpanded(isOpen ? null : key)}
                      >
                        {text}
                      </button>
                    ) : (
                      <span className="mt-nonote">לא נרשם סיכום</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {openClient &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="sc-overlay"
            onClick={() => setOpenClient(null)}
            role="presentation"
          >
            <div
              className="sc-panel"
              dir="rtl"
              role="dialog"
              aria-modal="true"
              aria-label={`תיק לקוח — ${openClient.name}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sc-head">
                <h3>🖤 {openClient.name || "תיק לקוח"}</h3>
                <button
                  type="button"
                  className="sc-close"
                  onClick={() => setOpenClient(null)}
                  aria-label="סגירה"
                >
                  ✕
                </button>
              </div>
              <ClientDossier client={openClient} />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
