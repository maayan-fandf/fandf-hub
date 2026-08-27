"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The dossier behind the מכירות bar: who signed, what they were buying,
 * where they came from, and their touch-by-touch journey.
 *
 * Fetched on open, never on render — see lib/signedClients.ts for why this
 * data does not travel in the page payload. The panel is internal-only and
 * the endpoint enforces that independently, so a client user reaching the
 * URL by hand gets the same 403 as a stranger.
 */

type Touch = {
  date: string;
  type: string;
  agent: string;
  content: string;
  isMeeting: boolean;
};

type Client = {
  clientId: string;
  name: string;
  phone: string;
  status: string;
  stage: string;
  salesperson: string;
  source: string;
  mediaSource: string;
  dealType: string;
  rooms: string;
  notes: string;
  leadCreated: string;
  firstTouch: string;
  lastTouch: string;
  touchesCount: number;
  meetingsCount: number;
  leadsCount: number;
  objections: string;
  journey: Touch[];
};

type Payload = {
  ok: boolean;
  total?: number;
  withJourney?: number;
  clients?: Client[];
  reason?: string;
  platform?: string;
  error?: string;
};

/** Journey icons by BMBY event type. Same vocabulary the touches table
 *  carries: Task / SMS / LID / Appointment / Comment / Phone / Unknown. */
const TOUCH_ICON: Record<string, string> = {
  Task: "✅",
  SMS: "💬",
  LID: "🎯",
  Appointment: "📅",
  Comment: "📝",
  Phone: "📞",
};

function fmtDate(iso: string): string {
  if (!iso || iso.length < 10) return iso || "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

export default function SignedClientsPanel({
  project,
  company,
  from,
  to,
  barValue,
  onClose,
}: {
  project: string;
  company: string;
  from: string;
  /** INCLUSIVE end, as the report window carries it. Converted to the
   *  endpoint's exclusive bound below. */
  to: string;
  /** What the funnel bar says. Shown beside the CRM count so a disagreement
   *  is visible rather than silently reconciled — the bar comes from ALL
   *  CLIENTS' מכירות column and this list from the CRM's חוזה status. */
  barValue: number;
  onClose: () => void;
}) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [data, setData] = useState<Payload | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    // The endpoint's `to` is exclusive; the report window's is inclusive.
    const toExcl = (() => {
      const d = new Date(`${to}T00:00:00Z`);
      if (isNaN(d.getTime())) return to;
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    const qs = new URLSearchParams({ project, company, from, to: toExcl });
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

  const clients = data?.clients ?? [];
  const total = data?.total ?? 0;

  const body = (
    <div className="sc-overlay" onClick={onClose} role="presentation">
      <div
        className="sc-panel"
        dir="rtl"
        role="dialog"
        aria-modal="true"
        aria-label="תיקי לקוחות שחתמו"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sc-head">
          <h3>🖤 לקוחות שחתמו — {project}</h3>
          <button type="button" className="sc-close" onClick={onClose} aria-label="סגירה">
            ✕
          </button>
        </div>

        {state === "loading" && <div className="sc-note">טוען…</div>}
        {state === "error" && (
          <div className="sc-note">
            לא הצלחתי לטעון את הרשימה{data?.error ? ` — ${data.error}` : ""}.
          </div>
        )}

        {state === "ready" && data?.reason === "not-bmby" && (
          <div className="sc-note">
            הפרויקט הזה על {data.platform?.toUpperCase()}. מסע הלקוח קיים רק
            ב-BMBY, ובלעדיו התיק היה כמעט ריק — לכן הוא לא נפתח כאן.
          </div>
        )}
        {state === "ready" && data?.reason === "no-crm" && (
          <div className="sc-note">אין לפרויקט הזה חשבון CRM ב-Keys.</div>
        )}

        {state === "ready" && !data?.reason && (
          <>
            {/* Said out loud rather than reconciled: the two numbers count
                the same thing from different places and can disagree. */}
            <p className="sc-basis">
              {total === 0
                ? `ה-CRM לא מצא לקוחות בסטטוס "חוזה" בפרויקט הזה.`
                : `${total} לקוחות נמצאים כעת בסטטוס "חוזה" ב-CRM.`}{" "}
              זו תמונת מצב ולא טווח: ל-BMBY אין תאריך חתימה, רק תאריך כניסת
              הליד — ולקוח שחותם היום נכנס לרוב חודשים קודם.
              {barValue !== total && (
                <>
                  {" "}
                  הגרף מציג {barValue} לתקופה הנבחרת, מעמודת מכירות ב-ALL
                  CLIENTS. שני מקורות שונים, ולכן הם לא חייבים להסתדר.
                </>
              )}
              {total > 0 && data?.withJourney != null && data.withJourney < total && (
                <>
                  {" "}
                  ל-{total - data.withJourney} מהם אין מסע מסונכרן — המסע נמשך
                  מ-BMBY רק ללקוחות שנקבעה להם פגישה.
                </>
              )}
            </p>

            <ul className="sc-list">
              {clients.map((c) => {
                const isOpen = open === c.clientId;
                return (
                  <li key={c.clientId} className={"sc-item" + (isOpen ? " is-open" : "")}>
                    <button
                      type="button"
                      className="sc-item-head"
                      aria-expanded={isOpen}
                      onClick={() => setOpen(isOpen ? null : c.clientId)}
                    >
                      <span className="sc-name">{c.name || "—"}</span>
                      <span className="sc-chips">
                        {c.rooms && <span className="sc-chip">{c.rooms} חד׳</span>}
                        {c.dealType && <span className="sc-chip">{c.dealType}</span>}
                        {c.salesperson && (
                          <span className="sc-chip sc-chip-agent">{c.salesperson}</span>
                        )}
                      </span>
                      <span className="sc-counts">
                        {c.touchesCount} מגעים · {c.meetingsCount} פגישות
                      </span>
                      <span className="sc-caret" aria-hidden>
                        {isOpen ? "▾" : "◂"}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="sc-body">
                        <dl className="sc-facts">
                          <div>
                            <dt>שלב</dt>
                            <dd>{c.stage || c.status || "—"}</dd>
                          </div>
                          <div>
                            <dt>טלפון</dt>
                            <dd>{c.phone || "—"}</dd>
                          </div>
                          <div>
                            <dt>מקור הגעה</dt>
                            <dd>{c.source || c.mediaSource || "—"}</dd>
                          </div>
                          <div>
                            <dt>ליד נכנס</dt>
                            <dd>{c.leadCreated ? fmtDate(c.leadCreated) : "—"}</dd>
                          </div>
                          <div>
                            <dt>מגע ראשון → אחרון</dt>
                            <dd>
                              {c.firstTouch ? fmtDate(c.firstTouch) : "—"} →{" "}
                              {c.lastTouch ? fmtDate(c.lastTouch) : "—"}
                            </dd>
                          </div>
                          {c.objections && (
                            <div>
                              <dt>התנגדות</dt>
                              <dd>{c.objections}</dd>
                            </div>
                          )}
                          {c.notes && (
                            <div className="sc-fact-wide">
                              <dt>הערות</dt>
                              <dd className="sc-notes">{c.notes}</dd>
                            </div>
                          )}
                        </dl>

                        <div className="sc-journey-title">
                          מסע לקוח
                          {c.journey.length > 0 && (
                            <span className="sc-journey-n">{c.journey.length} אירועים</span>
                          )}
                        </div>
                        {c.journey.length === 0 ? (
                          <div className="sc-note sc-note-inline">
                            אין מסע מסונכרן ללקוח הזה — לא אומר שלא היו מגעים.
                          </div>
                        ) : (
                          <ol className="sc-journey">
                            {c.journey.map((t, i) => (
                              <li
                                key={`${t.date}-${i}`}
                                className={"sc-touch" + (t.isMeeting ? " is-meeting" : "")}
                              >
                                <span className="sc-touch-icon" aria-hidden>
                                  {TOUCH_ICON[t.type] || "•"}
                                </span>
                                <span className="sc-touch-date">{fmtDate(t.date)}</span>
                                <span className="sc-touch-type">{t.type}</span>
                                <span className="sc-touch-content">{t.content || "—"}</span>
                                {t.agent && <span className="sc-touch-agent">{t.agent}</span>}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(body, document.body);
}
