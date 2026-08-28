"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import ClientDossier, {
  type DossierClient,
} from "@/components/report/ClientDossier";

/**
 * The dossier behind the מכירות bar: who signed, what they were buying,
 * where they came from, and their touch-by-touch journey.
 *
 * Fetched on open, never on render — see lib/signedClients.ts for why this
 * data does not travel in the page payload. The panel is internal-only and
 * the endpoint enforces that independently, so a client user reaching the
 * URL by hand gets the same 403 as a stranger.
 */

type Client = DossierClient;

type Payload = {
  ok: boolean;
  total?: number;
  withJourney?: number;
  clients?: Client[];
  reason?: string;
  platform?: string;
  error?: string;
};

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

        {state === "ready" && data?.reason === "unsupported-platform" && (
          <div className="sc-note">
            ב-{data.platform?.toUpperCase()} אין שדה שלב מכירה ומסע לקוח בצורה
            הזו, ולכן התיק לא נפתח כאן.
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
                        <ClientDossier client={c} />
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
