"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fmtDateHe, fmtILS, fmtInt, type ReportAdHistory } from "@/lib/reportShared";

/**
 * Per-ad lifetime history panel for the קריאייטיבים cards. INTERNAL ONLY —
 * the payload is stripped for clients server-side in NativeProjectRail.
 *
 * Portaled to <body> as position:fixed, which is not optional here for two
 * independent reasons: .rpt-cr-card is overflow:hidden, so an in-card panel is
 * clipped to a ~215px box; and .prl-panel.is-active animates `transform` on
 * every rail-section switch, and a transformed ancestor becomes the containing
 * block for fixed descendants — the same failure mode commit 28f2aba portaled
 * the approval modal out of.
 *
 * Placement is computed rather than reusing the CRM funnel's useHoverPopover:
 * that one centres on the trigger with translateX(-50%) and never clamps, which
 * walks a 320px panel off-screen from a ~230px card at the grid edge. In RTL
 * the grid starts at the RIGHT, so that is the first case that breaks, not an
 * edge case. The ergonomics (hide grace so the cursor can cross the gap,
 * focus/blur parity for keyboards) are copied; the geometry is not.
 *
 * WHAT THE NUMBERS MEAN — the panel is not a before/after of the card face.
 * Attribution is first-touch at ANY lead age, so an ad keeps accruing meetings
 * from leads it touched months ago, even while paused. A lifetime figure
 * therefore only ever grows and is NOT comparable to the in-window figure on
 * the card. Hence `מאז <date>` in the header and the explicit לפני התקופה row:
 * the panel states its own span rather than implying it knows the ad's whole
 * life (the ad-metrics tab is a rolling ~200-day export — see ReportAdHistory).
 */

const HIDE_GRACE_MS = 80;
const PANEL_W = 340;

export default function AdHistoryPopover({
  ad,
  history,
}: {
  ad: string;
  history: ReportAdHistory;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; flipped: boolean } | null>(
    null,
  );
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const hideT = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHide = useCallback(() => {
    if (hideT.current) {
      clearTimeout(hideT.current);
      hideT.current = null;
    }
  }, []);

  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const rtl =
      typeof document !== "undefined" &&
      document.documentElement.dir.toLowerCase() === "rtl";
    // Anchor to the trigger's leading edge — right in RTL, left in LTR — then
    // clamp to the viewport so a card at either end of the grid still shows a
    // whole panel.
    let left = rtl ? r.right - PANEL_W : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - PANEL_W - 8));
    // Rough height estimate: rows + header + the two summary rows. Only used
    // to decide the flip; the panel sizes itself.
    const estH = 92 + (history.months.length + 2) * 22;
    const flipped = r.bottom + estH + 12 > window.innerHeight && r.top > estH;
    setPos({ top: flipped ? r.top - estH - 8 : r.bottom + 8, left, flipped });
  }, [history.months.length]);

  const show = useCallback(() => {
    cancelHide();
    place();
    setOpen(true);
  }, [cancelHide, place]);

  const hide = useCallback(() => {
    cancelHide();
    hideT.current = setTimeout(() => setOpen(false), HIDE_GRACE_MS);
  }, [cancelHide]);

  // Any scroll or resize invalidates a fixed-position anchor — close rather
  // than chase it, which is what the other portaled popovers in this app do.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => () => cancelHide(), [cancelHide]);

  const { before, total } = history;
  const perSched = total.scheduled > 0 ? total.cost / total.scheduled : 0;
  const perHeld = total.held > 0 ? total.cost / total.held : 0;

  const panel =
    open && pos && typeof document !== "undefined"
      ? createPortal(
          <div
            className="rpt-cr-hist"
            role="tooltip"
            style={{ top: pos.top, left: pos.left, width: PANEL_W }}
            onMouseEnter={cancelHide}
            onMouseLeave={hide}
          >
            <div className="rpt-cr-hist-head">
              <span dir="auto">{ad}</span>
              <span className="rpt-cr-hist-since">מאז {fmtDateHe(history.since)}</span>
            </div>
            <table className="rpt-cr-hist-tbl">
              <thead>
                <tr>
                  <th>חודש</th>
                  <th>עלות</th>
                  <th>לידים</th>
                  <th>תואמו</th>
                  <th>בוצעו</th>
                </tr>
              </thead>
              <tbody>
                {history.months.map((m) => (
                  <tr key={m.month}>
                    <td>{m.month}</td>
                    <td>{m.cost > 0 ? fmtILS(m.cost) : "—"}</td>
                    <td>{fmtInt(m.leads)}</td>
                    <td>{fmtInt(m.scheduled)}</td>
                    <td>{fmtInt(m.held)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="rpt-cr-hist-before">
                  <td>לפני התקופה</td>
                  <td>{before.cost > 0 ? fmtILS(before.cost) : "—"}</td>
                  <td>{fmtInt(before.leads)}</td>
                  <td>{fmtInt(before.scheduled)}</td>
                  <td>{fmtInt(before.held)}</td>
                </tr>
                <tr className="rpt-cr-hist-total">
                  <td>סה״כ</td>
                  <td>{total.cost > 0 ? fmtILS(total.cost) : "—"}</td>
                  <td>{fmtInt(total.leads)}</td>
                  <td>{fmtInt(total.scheduled)}</td>
                  <td>{fmtInt(total.held)}</td>
                </tr>
              </tfoot>
            </table>
            <div className="rpt-cr-hist-foot">
              {perSched > 0 ? `${fmtILS(perSched)} לתיאום` : "—"}
              {perHeld > 0 ? ` · ${fmtILS(perHeld)} לביצוע` : ""}
              <div className="rpt-cr-hist-note">
                תיאומים מיוחסים למודעה שהביאה את הליד, בכל גיל ליד — לכן המספר
                מצטבר גם אחרי שהמודעה הופסקה, ואינו בר-השוואה למספר שבכרטיס.
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className="rpt-cr-hist-btn"
        aria-label={`היסטוריית המודעה ${ad}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        📜 היסטוריה
      </button>
      {panel}
    </>
  );
}
