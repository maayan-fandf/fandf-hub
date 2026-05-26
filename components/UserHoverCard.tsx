"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Global hover card for user chips across the Hub. Mount ONCE in the
 * root layout — it attaches a single document-level listener that pops
 * a contextual card whenever the mouse hovers any element carrying
 * `data-user-email`. The data attribute is emitted by `<Avatar>` and
 * can be added to any other user-chip surface (mentions, comboboxes,
 * raw text mentions) by setting the attribute on the trigger element.
 *
 * Why event delegation (not a wrapper component): wrapping every
 * existing chip with a new component would mean touching dozens of
 * call sites and would re-render their trees. A single delegated
 * listener + a single data attribute scales linearly and lets us roll
 * the card out to new chip surfaces just by adding the attribute.
 *
 * UX:
 *   - 350 ms hover delay before opening (avoids popups on accidental
 *     mouse-overs while scanning a list).
 *   - 200 ms close delay on mouseleave (the user can move from the
 *     trigger onto the card itself — entering the card cancels close).
 *   - Card stays open while the cursor is over either the trigger OR
 *     the card.
 *   - Click on the trigger (or inside the card) cancels the open timer
 *     so a click never accidentally summons a card.
 *
 * v1 ships with email/calendar/contacts URL actions + Hub-internal
 * "their open tasks" and "assign new task" links. v2 will add
 * Workspace Directory enrichment (phone, title) + comment-mention
 * support.
 */

type Anchor = {
  el: HTMLElement;
  email: string;
  name: string;
  role: string;
};

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 200;

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export default function UserHoverCard() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; placement: "below" | "above" } | null>(null);
  // Mount guard for portal — render nothing on the SSR pass; the card
  // only ever appears after a hover, which is client-only anyway.
  const [mounted, setMounted] = useState(false);

  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Track the last triggering element so we can both reposition on
  // scroll/resize AND ignore stale enter events from the same node.
  const currentTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const cancelOpen = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);
  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelOpen();
    cancelClose();
    closeTimer.current = setTimeout(() => {
      setAnchor(null);
      setPosition(null);
      currentTriggerRef.current = null;
    }, CLOSE_DELAY_MS);
  }, [cancelOpen, cancelClose]);

  const computePosition = useCallback((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Card is ~340 wide × ~280 tall in v1.
    const cw = 340;
    const ch = 280;
    const margin = 8;
    // Default: open BELOW the trigger, RIGHT-aligned in LTR, LEFT-
    // aligned in RTL. Flip above if it would overflow the viewport.
    const rtl =
      typeof document !== "undefined" &&
      document.documentElement.getAttribute("dir") === "rtl";
    let top = r.bottom + 6;
    let placement: "below" | "above" = "below";
    if (top + ch + margin > vh) {
      top = r.top - ch - 6;
      placement = "above";
      if (top < margin) top = margin;
    }
    // Horizontal: align card's near edge to the trigger's near edge.
    let left = rtl ? r.right - cw : r.left;
    if (left + cw + margin > vw) left = vw - cw - margin;
    if (left < margin) left = margin;
    return { left, top, placement };
  }, []);

  const openFor = useCallback(
    (a: Anchor) => {
      cancelClose();
      cancelOpen();
      openTimer.current = setTimeout(() => {
        currentTriggerRef.current = a.el;
        setAnchor(a);
        setPosition(computePosition(a.el));
      }, OPEN_DELAY_MS);
    },
    [cancelOpen, cancelClose, computePosition],
  );

  // Global hover delegation. One listener; no per-chip wiring needed.
  useEffect(() => {
    function readAnchor(el: HTMLElement): Anchor | null {
      const email = (el.getAttribute("data-user-email") || "").trim();
      if (!email || !isEmail(email)) return null;
      const name = (el.getAttribute("data-user-name") || "").trim() || email;
      const role = (el.getAttribute("data-user-role") || "").trim();
      return { el, email, name, role };
    }
    function onEnter(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target?.closest) return;
      const trigger = target.closest<HTMLElement>("[data-user-email]");
      if (!trigger) return;
      // Re-enter on same trigger (e.g., moving within the chip) — keep
      // the existing schedule or open state.
      if (currentTriggerRef.current === trigger) {
        cancelClose();
        return;
      }
      const a = readAnchor(trigger);
      if (!a) return;
      openFor(a);
    }
    function onLeave(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target?.closest) return;
      const trigger = target.closest<HTMLElement>("[data-user-email]");
      if (!trigger) return;
      // If the mouse moved INTO the card itself, don't close — the card's
      // own onMouseEnter cancels the close timer.
      const related = e.relatedTarget as HTMLElement | null;
      if (related && cardRef.current && cardRef.current.contains(related)) {
        return;
      }
      scheduleClose();
    }
    function onClickAny(e: MouseEvent) {
      // Clicking on a chip shouldn't summon the card — that gesture means
      // "open the row" (or whatever the chip's own click does). Cancel
      // any pending open. Click inside the card itself is left alone.
      const target = e.target as HTMLElement | null;
      if (!target?.closest) return;
      const trigger = target.closest<HTMLElement>("[data-user-email]");
      const insideCard = !!(cardRef.current && cardRef.current.contains(target));
      if (trigger && !insideCard) {
        cancelOpen();
      }
    }
    document.addEventListener("mouseover", onEnter);
    document.addEventListener("mouseout", onLeave);
    document.addEventListener("click", onClickAny, true);
    return () => {
      document.removeEventListener("mouseover", onEnter);
      document.removeEventListener("mouseout", onLeave);
      document.removeEventListener("click", onClickAny, true);
    };
  }, [openFor, scheduleClose, cancelOpen, cancelClose]);

  // Reposition on scroll/resize while open.
  useEffect(() => {
    if (!anchor) return;
    function reposition() {
      const el = currentTriggerRef.current;
      if (!el) return;
      setPosition(computePosition(el));
    }
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [anchor, computePosition]);

  // Escape closes.
  useEffect(() => {
    if (!anchor) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setAnchor(null);
        setPosition(null);
        currentTriggerRef.current = null;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [anchor]);

  if (!mounted || !anchor || !position) return null;

  const { email, name, role } = anchor;
  // External (non-fandf) users → no Workspace photo, no internal actions.
  const isFandf = /@fandf\.co\.il$/i.test(email);
  const photoUrl = isFandf
    ? `/api/avatar/${encodeURIComponent(email.toLowerCase().trim())}`
    : "";

  const calendarUrl = `https://calendar.google.com/calendar/u/0/r/eventedit?add=${encodeURIComponent(email)}`;
  const contactsUrl = `https://contacts.google.com/${encodeURIComponent(email)}`;
  const tasksUrl = `/tasks?assignee=${encodeURIComponent(email)}`;
  const newTaskUrl = `/tasks/new?assignees=${encodeURIComponent(email)}`;

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(email);
    } catch {
      /* best-effort */
    }
  }

  return createPortal(
    <div
      ref={cardRef}
      className="user-hover-card"
      role="dialog"
      aria-label={`כרטיס משתמש — ${name}`}
      style={{ left: position.left, top: position.top }}
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
    >
      <div className="uhc-head">
        <span className="uhc-avatar" aria-hidden>
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl} alt="" />
          ) : (
            <span className="uhc-initials">
              {(name[0] || email[0] || "?").toUpperCase()}
            </span>
          )}
        </span>
        <div className="uhc-id">
          <div className="uhc-name" dir="auto">
            {name}
          </div>
          {role && <div className="uhc-role">{role}</div>}
          <div className="uhc-email">
            <a href={`mailto:${email}`} dir="ltr">
              {email}
            </a>
            <button
              type="button"
              className="uhc-copy-btn"
              onClick={copyEmail}
              title="העתק כתובת"
              aria-label="העתק כתובת"
            >
              📋
            </button>
          </div>
        </div>
      </div>

      <div className="uhc-actions">
        <a
          className="uhc-action"
          href={`mailto:${email}`}
          title="שלח אימייל"
        >
          <span aria-hidden>✉️</span>
          <span>אימייל</span>
        </a>
        <a
          className="uhc-action"
          href={calendarUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="קבע פגישה ב-Calendar (האדם נוסף כאורח)"
        >
          <span aria-hidden>📅</span>
          <span>פגישה</span>
        </a>
        {isFandf && (
          <a
            className="uhc-action"
            href={contactsUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="פתח ב-Google Contacts"
          >
            <span aria-hidden>👤</span>
            <span>איש קשר</span>
          </a>
        )}
      </div>

      {isFandf && (
        <div className="uhc-actions uhc-actions-hub">
          <a className="uhc-action uhc-action-hub" href={tasksUrl} title="המשימות שלו/ה">
            <span aria-hidden>📋</span>
            <span>המשימות שלו/ה</span>
          </a>
          <a
            className="uhc-action uhc-action-hub"
            href={newTaskUrl}
            title="הקצה משימה חדשה"
          >
            <span aria-hidden>➕</span>
            <span>הקצה משימה</span>
          </a>
        </div>
      )}
    </div>,
    document.body,
  );
}
