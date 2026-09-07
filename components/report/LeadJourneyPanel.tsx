"use client";

import { useState } from "react";
import ChannelIcon from "@/components/ChannelIcon";
import type { LeadJourney } from "@/lib/leadJourney";

/**
 * מקור מול טריגר — the card whose behaviour is the argument.
 *
 * Two mirrored columns over the same coordinations: who OPENED the lead on
 * the right, who CLOSED it on the left. Click a channel on either side and
 * it answers the question the columns raise — where did those leads
 * actually go, or where did these actually come from.
 *
 * A CLICK, not a hover. This gets read over someone's shoulder and on a
 * shared screen, where a mouseover is invisible; and the reader needs the
 * answer to stay put while they talk about it. Hover survives as
 * decoration only, lighting the same channel in the other column, because
 * that pairing is the whole reading.
 *
 * Both columns and the drill are slices of one matrix computed in
 * lib/leadJourney.ts — see the note there on why they are not three
 * queries.
 *
 * Colours come from the company palette vars, not literals: this card
 * shipped the same week the נייר skin was completed, and a chart that
 * hard-codes #8b5cf6 is a chart no skin can ever restyle.
 */

type Side = "origin" | "trigger";

/** "ליד אחד" / "7 לידים". A card whose whole job is to be read out loud in
 *  a meeting cannot say "1 לידים". */
const leads = (n: number) => (n === 1 ? "ליד אחד" : `${n} לידים`);

/** Same twelve the rest of the hub tints with, addressed by var so a skin
 *  restyles them. Assigned by position in the origin column so the busiest
 *  channel is always the first hue — stable within a project, which is
 *  what matters when someone compares two screenshots of it. */
const HUES = [
  "--blue",
  "--orange",
  "--teal",
  "--violet",
  "--green",
  "--amber",
  "--pink",
  "--cyan",
  "--lime",
  "--indigo",
  "--rose",
  "--purple",
];

export default function LeadJourneyPanel({ data }: { data: LeadJourney }) {
  const [sel, setSel] = useState<{ slug: string; side: Side } | null>(null);

  const name = (slug: string) => data.channels[slug]?.label ?? slug;
  const iconKey = (slug: string) => data.channels[slug]?.iconKey ?? "";
  // Hue by rank in the origin column, falling back for a channel that only
  // ever appears as a trigger (the phone on some projects).
  const order = new Map(data.origin.map((o, i) => [o.slug, i]));
  const hue = (slug: string) =>
    `var(${HUES[(order.get(slug) ?? order.size + data.trigger.findIndex((t) => t.slug === slug)) % HUES.length]})`;

  const maxO = Math.max(1, ...data.origin.map((o) => o.count));
  const maxT = Math.max(1, ...data.trigger.map((t) => t.count));

  const pick = (slug: string, side: Side) =>
    setSel((cur) =>
      cur && cur.slug === slug && cur.side === side ? null : { slug, side },
    );

  const drill = (() => {
    if (!sel) return null;
    const rows =
      sel.side === "origin"
        ? data.matrix
            .filter((c) => c.from === sel.slug)
            .map((c) => ({ slug: c.to, count: c.count }))
        : data.matrix
            .filter((c) => c.to === sel.slug)
            .map((c) => ({ slug: c.from, count: c.count }));
    const tot = rows.reduce((a, r) => a + r.count, 0);
    const kept = rows.find((r) => r.slug === sel.slug)?.count ?? 0;
    const moved = tot - kept;
    return {
      rows: rows.sort((a, b) => b.count - a.count),
      tot,
      moved,
      max: Math.max(1, ...rows.map((r) => r.count)),
      title: name(sel.slug),
      sub:
        sel.side === "origin"
          ? `לאן זזו · ${tot} לידים`
          : `מאיפה הגיעו · ${tot} לידים`,
      line:
        sel.side === "origin"
          ? moved > 0
            ? `${name(sel.slug)} פתח ${leads(tot)}. ${moved === 1 ? "אחד מהם נסגר" : `${moved} מהם נסגרו`} בערוץ אחר — הקרדיט האחרון הלך לשם, אבל הליד נפתח כאן.`
            : `${name(sel.slug)} פתח ${leads(tot)}, וכולם נסגרו באותו ערוץ.`
          : moved > 0
            ? `${name(sel.slug)} סגר ${leads(tot)}. ${moved === 1 ? "אחד מהם נפתח" : `${moved} מהם נפתחו`} בערוץ אחר — המדיה הביאה אותם, הערוץ הזה קיבל את הקרדיט.`
            : `${name(sel.slug)} סגר ${leads(tot)}, וכולם נפתחו באותו ערוץ.`,
    };
  })();

  // A channel lights on BOTH sides at once. With nothing selected the
  // channel with the biggest gap lights on its own, so the card opens on
  // the thing it exists to show instead of waiting to be asked.
  const lit = (slug: string) => sel?.slug === slug || (!sel && slug === data.hot);

  const row = (slug: string, count: number, side: Side, max: number) => {
    const on = sel?.slug === slug && sel.side === side;
    const label = (
      <span className="lj-label">
        {iconKey(slug) ? <ChannelIcon name={iconKey(slug)} size="0.85em" /> : null}
        {name(slug)}
      </span>
    );
    const bar = (
      <span className="lj-track">
        <i style={{ width: `${(count / max) * 100}%`, background: hue(slug) }} />
      </span>
    );
    return (
      <button
        key={slug}
        type="button"
        className={`lj-row${lit(slug) ? " is-lit" : ""}${on ? " is-sel" : ""}`}
        aria-pressed={on}
        onClick={() => pick(slug, side)}
      >
        {side === "origin" ? (
          <>
            {bar}
            <span className="lj-num">{count}</span>
            {label}
          </>
        ) : (
          <>
            {label}
            <span className="lj-num">{count}</span>
            {bar}
          </>
        )}
      </button>
    );
  };

  return (
    <div className="lj" dir="rtl">
      <div className="lj-cols">
        <div className="lj-col">
          <div className="lj-head">מקור · ליד ראשון</div>
          {data.origin.map((o) => row(o.slug, o.count, "origin", maxO))}
        </div>

        <div className="lj-mid" aria-hidden>
          מקור
          <br />↓<br />
          טריגר
        </div>

        <div className="lj-col">
          <div className="lj-head">טריגר · ליד אחרון</div>
          {data.trigger.map((t) => row(t.slug, t.count, "trigger", maxT))}
        </div>
      </div>

      {drill ? (
        <div className="lj-drill">
          <div className="lj-drill-head">
            <b>{drill.title}</b>
            <span className="lj-drill-sub">{drill.sub}</span>
            <button type="button" className="lj-close" onClick={() => setSel(null)}>
              סגור ✕
            </button>
          </div>
          {drill.rows.map((r) => (
            <div className="lj-drill-row" key={r.slug}>
              <span className="lj-sw" style={{ background: hue(r.slug) }} />
              <span className="lj-drill-name">{name(r.slug)}</span>
              <span className="lj-track">
                <i
                  style={{
                    width: `${(r.count / drill.max) * 100}%`,
                    background: hue(r.slug),
                  }}
                />
              </span>
              <span className="lj-num">
                {r.count} <small>{Math.round((r.count / drill.tot) * 100)}%</small>
              </span>
            </div>
          ))}
          <p className="lj-note">{drill.line}</p>
        </div>
      ) : (
        <p className="lj-note">
          לחצו על ערוץ באחד הטורים כדי לראות לאן הלידים שלו זזו. {leads(data.total)}{" "}
          בשני הטורים,{" "}
          {data.moved === 1 ? "אחד מהם החליף" : `${data.moved} מהם החליפו`} ערוץ
          בדרך.
          {/* The obvious question about this card is whether it is just
              "לידים חוזרים מול חדשים" wearing a different chart. Measured on
              נתיבות over 2026 it is not, but the two are tightly related —
              97% of channel changes are someone coming back, while only 57%
              of returning leads change channel — and the honest thing is to
              say so on the card rather than leave the reader to work it out
              from two blocks that never mention each other. */}
          {data.returningAmongMoved != null && data.moved > 0 ? (
            <>
              {" "}
              {data.returningAmongMoved === data.moved
                ? "כולם לידים חוזרים — אנשים שכבר פנו פעם וחזרו דרך ערוץ אחר."
                : data.returningAmongMoved === 0
                  ? "אף אחד מהם אינו ליד חוזר — כולם החליפו ערוץ בתוך פנייה אחת."
                  : `${data.returningAmongMoved} מתוכם לידים חוזרים — אנשים שכבר פנו פעם וחזרו דרך ערוץ אחר; ${data.moved - data.returningAmongMoved} החליפו ערוץ בתוך פנייה אחת.`}
            </>
          ) : null}
        </p>
      )}

      {/* Arithmetic, deliberately not an accusation. An earlier phrasing of
          this sentence said a channel "steals" coordinations, with a ⚠️
          beside it — which tells the reader something is wrong before the
          campaign manager has said whether it is. Opened four, closed ten,
          difference six. */}
      {data.hot && data.hotDelta > 0 ? (
        <p className="lj-verdict">
          {name(data.hot)} סוגר {data.hotDelta === 1 ? "ליד אחד" : `${data.hotDelta} לידים`}{" "}
          יותר משהוא פותח.{" "}
          {data.hotDelta === 1 ? "הוא נפתח" : "הם נפתחו"} במקום אחר — בדוח שמייחס
          לפי המגע האחרון, הקרדיט עליהם נרשם כאן.
        </p>
      ) : null}
    </div>
  );
}
