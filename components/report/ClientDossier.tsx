"use client";

import { useState } from "react";
import ChannelIcon from "@/components/ChannelIcon";
import { channelIcon } from "@/lib/channelIcon";

/**
 * One client's file: who they are, which media brought them, and the whole
 * journey from first touch to the sale.
 *
 * Shared by the מכירות drill and the חוזים table so a client reads the same
 * either way. Pure presentation — the caller owns the fetch, and the data
 * only ever arrives from the internal-only endpoint (see lib/signedClients).
 */

export type DossierTouch = {
  date: string;
  type: string;
  agent: string;
  content: string;
  isMeeting: boolean;
};

export type DossierClient = {
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
  journey: DossierTouch[];
  salespersonInferred?: boolean;
  saleStage?: "signed" | "opportunity";
  saleLabel?: string;
};

/** BMBY event types, plus Sehel's Hebrew ones ("שיחה יוצאת"). Unknown types
 *  fall through to a bullet rather than guessing. */
const TOUCH_ICON: Record<string, string> = {
  Task: "✅",
  SMS: "💬",
  LID: "🎯",
  Appointment: "📅",
  Comment: "📝",
  Phone: "📞",
};
function touchIcon(t: DossierTouch): string {
  if (TOUCH_ICON[t.type]) return TOUCH_ICON[t.type];
  const s = t.type;
  if (/פגיש/.test(s)) return "📅";
  if (/שיחה|טלפ/.test(s)) return "📞";
  if (/sms|מסרון/i.test(s)) return "💬";
  if (/ליד|פני/.test(s)) return "🎯";
  return "•";
}

export function fmtDate(iso: string): string {
  if (!iso || iso.length < 10) return iso || "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

/**
 * Every media channel that touched this client.
 *
 * `source_agg` is the right field HERE and the wrong one for attribution:
 * it lists every channel the client ever arrived through, so crediting a
 * sale to all of them would multiply one sale across five channels. On a
 * single client's file that breadth is exactly the point — it answers "what
 * actually contributed", which one attributed source cannot.
 *
 * The attributed one is marked so the two readings stay distinguishable.
 */
function contributingChannels(c: DossierClient): {
  label: string;
  attributed: boolean;
}[] {
  const attributed = c.mediaSource.trim();
  const all = (c.source || attributed)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: { label: string; attributed: boolean }[] = [];
  for (const label of all) {
    const k = label.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ label, attributed: !!attributed && k === attributed.toLowerCase() });
  }
  if (attributed && !seen.has(attributed.toLowerCase())) {
    out.unshift({ label: attributed, attributed: true });
  }
  // Attributed first, then the rest in the order the CRM listed them.
  return out.sort((a, b) => Number(b.attributed) - Number(a.attributed));
}

/** A journey row that represents a MEDIA arrival rather than desk activity —
 *  a BMBY "LID" or a Sehel lead event. These are the rungs the channel strip
 *  above is built from, so they are marked in the timeline too. */
function isMediaTouch(t: DossierTouch): boolean {
  return t.type === "LID" || /ליד|פניה|פנייה/.test(t.type);
}

export default function ClientDossier({ client }: { client: DossierClient }) {
  const c = client;
  // Which long touches the reader has opened. Desks paste whole marketing
  // scripts into a touch — one אהרון event runs to a full clinic brochure —
  // and at full length two of them bury an eleven-event journey. Clamped to
  // three lines, with the whole text one click away.
  const [openTouch, setOpenTouch] = useState<Set<number>>(new Set());
  const toggleTouch = (i: number) =>
    setOpenTouch((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const channels = contributingChannels(c);
  const days =
    c.leadCreated && c.lastTouch
      ? Math.round(
          (Date.parse(`${c.lastTouch}T00:00:00Z`) -
            Date.parse(`${c.leadCreated}T00:00:00Z`)) /
            86400000,
        )
      : null;

  return (
    <div className="cd-wrap">
      <dl className="cd-facts">
        <div>
          <dt>שלב</dt>
          <dd>{c.saleLabel || c.stage || c.status || "—"}</dd>
        </div>
        <div>
          <dt>טלפון</dt>
          <dd>{c.phone || "—"}</dd>
        </div>
        {c.salesperson && (
          <div>
            <dt>
              {c.salespersonInferred ? "הנציג הפעיל ביותר" : "איש מכירות"}
            </dt>
            <dd>{c.salesperson}</dd>
          </div>
        )}
        {c.rooms && (
          <div>
            <dt>חדרים</dt>
            <dd>{c.rooms}</dd>
          </div>
        )}
        {c.dealType && (
          <div>
            <dt>סוג עסקה</dt>
            <dd>{c.dealType}</dd>
          </div>
        )}
        <div>
          <dt>ליד נכנס ← מגע אחרון</dt>
          <dd>
            {fmtDate(c.leadCreated)} ← {fmtDate(c.lastTouch)}
            {days != null && days >= 0 && (
              <span className="cd-days"> ({days} ימים)</span>
            )}
          </dd>
        </div>
        {c.objections && (
          <div>
            <dt>התנגדות</dt>
            <dd>{c.objections}</dd>
          </div>
        )}
        {c.notes && (
          <div className="cd-fact-wide">
            <dt>הערות</dt>
            <dd className="cd-notes">{c.notes}</dd>
          </div>
        )}
      </dl>

      {channels.length > 0 && (
        <div className="cd-channels">
          <div className="cd-sub">
            ערוצי מדיה שתרמו
            <span className="cd-sub-note">
              {channels.length > 1
                ? "הלקוח הגיע דרך יותר מערוץ אחד — המסומן הוא זה שה-CRM ייחס לו את הליד"
                : "הערוץ שה-CRM ייחס לו את הליד"}
            </span>
          </div>
          <div className="cd-chips">
            {channels.map((ch) => (
              <span
                key={ch.label}
                className={"cd-chip" + (ch.attributed ? " is-attributed" : "")}
                title={
                  ch.attributed
                    ? "הערוץ שהליד יוחס אליו"
                    : "ערוץ נוסף שהלקוח נגע בו לפני הסגירה"
                }
              >
                <ChannelIcon name={ch.label} fallback="●" /> {ch.label}
                {ch.attributed && <span className="cd-chip-star">★</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="cd-sub cd-sub-journey">
        מסע לקוח
        {c.journey.length > 0 && (
          <span className="cd-sub-note">
            {c.journey.length} אירועים · {c.meetingsCount || 0} פגישות
          </span>
        )}
      </div>
      {c.journey.length === 0 ? (
        <div className="cd-empty">
          אין מסע מסונכרן ללקוח הזה — לא אומר שלא היו מגעים.
        </div>
      ) : (
        <ol className="cd-journey">
          {c.journey.map((t, i) => (
            <li
              key={`${t.date}-${i}`}
              className={
                "cd-touch" +
                (t.isMeeting ? " is-meeting" : "") +
                (isMediaTouch(t) ? " is-media" : "")
              }
            >
              <span className="cd-touch-icon" aria-hidden>
                {touchIcon(t)}
              </span>
              <span className="cd-touch-date">{fmtDate(t.date)}</span>
              {/* "Unknown" is BMBY's own label for an untyped touch. Shown,
                  because hiding it would leave an unexplained gap in the
                  timeline, but dimmed — it carries no information. */}
              <span
                className={
                  "cd-touch-type" + (/^unknown$/i.test(t.type) ? " is-untyped" : "")
                }
              >
                {t.type}
              </span>
              <span
                className={
                  "cd-touch-content" + (openTouch.has(i) ? " is-open" : "")
                }
                title={t.content || undefined}
                role={t.content && t.content.length > 120 ? "button" : undefined}
                tabIndex={t.content && t.content.length > 120 ? 0 : undefined}
                onClick={
                  t.content && t.content.length > 120
                    ? () => toggleTouch(i)
                    : undefined
                }
                onKeyDown={
                  t.content && t.content.length > 120
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleTouch(i);
                        }
                      }
                    : undefined
                }
              >
                {t.content || "—"}
              </span>
              {t.agent && <span className="cd-touch-agent">{t.agent}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Emoji for a channel in a plain-string context (titles, aria labels). */
export const channelEmoji = (name: string) => channelIcon(name) || "●";
