"use client";

import { Fragment, useState } from "react";
import ChannelIcon from "@/components/ChannelIcon";
import { StandardHead, StandardCells } from "@/components/Ga4Columns";
// `import type` ONLY — see the same note in Ga4CampaignTree: a value
// import from lib/ga4Report drags googleapis into the client bundle.
import type { Ga4Returning } from "@/lib/ga4Report";

/**
 * מבקרים חדשים מול חוזרים, each row opening into its campaigns.
 *
 * The honest stand-in for "multi-channel journeys". GA4's Data API has
 * no conversion path, assist or time-to-conversion field, and a
 * first-touch vs last-touch comparison proved redundant on this estate.
 * What people actually want to know is whether visitors convert on the
 * first visit or come back to do it — and, with the parts, which
 * campaigns the returning ones came back through.
 *
 * The parts ship with the page (two visitor types x at most ~15 parts),
 * so expanding is instant and costs no request. Rows start collapsed,
 * like the channel tree above.
 *
 * A campaign's `חלק` is its share of the visitor type it sits under, not
 * of the whole block: the question this answers is "which campaigns
 * brought the returning visitors", and 3% of all traffic would not say
 * that. The note under the table says so.
 */
export default function Ga4ReturningTable({ r }: { r: Ga4Returning }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const total = r.rows.reduce((n, x) => n + x.sessions, 0);
  if (total <= 0) return null;
  const toggle = (kind: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const ret = r.rows.find((x) => x.kind === "returning");
  const nw = r.rows.find((x) => x.kind === "new");
  // The lift is the point of the block — returning visitors are a small
  // slice of sessions and a much larger slice of conversions.
  const lift = ret && nw && nw.convRate > 0 ? ret.convRate / nw.convRate : null;
  const expandable = r.rows.some((x) => (x.parts?.length ?? 0) > 0);

  return (
    <div className="ga4w-block">
      <h3 className="ga4w-h3">מבקרים חדשים מול חוזרים</h3>
      <div className="ga4w-table-wrap">
        <table className="ga4w-table ga4w-table-std ga4w-tree">
          <StandardHead first="סוג מבקר" showConv />
          <tbody>
            {r.rows.map((x) => {
              // `?? []`: a payload cached before the parts existed.
              const parts = x.parts ?? [];
              const hasKids = parts.length > 0;
              const isOpen = hasKids && open.has(x.kind);
              return (
                <Fragment key={x.kind}>
                  <tr
                    className={
                      "ga4w-tree-row is-d0" +
                      (hasKids ? " is-parent" : "") +
                      (isOpen ? " is-open" : "")
                    }
                    onClick={hasKids ? () => toggle(x.kind) : undefined}
                  >
                    <td className="ga4w-tree-name">
                      {hasKids ? (
                        <button
                          type="button"
                          className="ga4w-tree-btn"
                          aria-expanded={isOpen}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(x.kind);
                          }}
                        >
                          <span className="ga4w-tree-caret" aria-hidden>
                            {isOpen ? "▾" : "▸"}
                          </span>
                          <span className="ga4w-tree-lbl is-chan">{x.label}</span>
                          <span className="ga4w-tree-count">
                            {campaignCount(parts)}
                          </span>
                        </button>
                      ) : (
                        <span className="ga4w-tree-lbl is-chan">{x.label}</span>
                      )}
                    </td>
                    <StandardCells
                      sessions={x.sessions}
                      total={total}
                      engaged={x.engaged}
                      avgSeconds={x.avgSeconds}
                      keyEvents={x.keyEvents}
                      convRate={x.convRate}
                      showConv
                    />
                  </tr>
                  {isOpen &&
                    parts.map((p) => (
                      <tr
                        key={`${x.kind}/${p.label}`}
                        className={"ga4w-tree-row is-d1" + (p.campaign ? "" : " is-nocamp")}
                      >
                        <td className="ga4w-tree-name">
                          <span style={{ paddingInlineStart: "1.1rem" }} />
                          <span className="ga4w-tree-caret is-leaf" aria-hidden />
                          {p.campaign && <ChannelIcon name={p.label} size="1.05em" />}
                          <span className="ga4w-tree-lbl" dir="auto" title={p.label}>
                            {p.label}
                          </span>
                        </td>
                        <StandardCells
                          sessions={p.sessions}
                          total={x.sessions}
                          engaged={p.engaged}
                          avgSeconds={p.avgSeconds}
                          keyEvents={p.keyEvents}
                          convRate={p.convRate}
                          showConv
                        />
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {expandable && (
        <div className="ga4w-note">
          לחיצה על סוג מבקר פותחת את הקמפיינים שהביאו אותו. בשורות הקמפיינים,
          ״חלק״ הוא מתוך סוג המבקר ולא מכלל הכניסות.
        </div>
      )}
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

/** "12 קמפיינים" counting the folded row's campaigns, not the row. */
function campaignCount(parts: NonNullable<Ga4Returning["rows"][number]["parts"]>): string {
  const n = parts.reduce((s, p) => s + (p.campaign ? 1 : p.folded), 0);
  if (n === 0) return "";
  return n === 1 ? "קמפיין אחד" : `${n} קמפיינים`;
}
