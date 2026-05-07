"use client";

import { useEffect, useRef, useState } from "react";
import Avatar from "@/components/Avatar";
import { roleEmoji, roleLabel } from "@/components/RoleChip";

/**
 * Topnav user pill: avatar + Hebrew display name + department emoji,
 * all clickable. Click reveals a small dropdown with the user's full
 * details (name, email, role) and a יציאה (sign out) button. Replaces
 * the older inline `<span>email</span>` + standalone signout button so
 * the topnav reads the same way the rest of the hub identifies people
 * (Hebrew name + role chip) instead of an email address.
 *
 * The sign-out path is a server action imported from
 * `@/lib/signOutAction` — a client component can wire a server action
 * directly into a `<form action>` without bouncing through an API
 * route. Closes on outside-click and Escape, matching UserSettingsMenu.
 */
export default function TopnavUserMenu({
  email,
  heName,
  role,
  signOutAction,
}: {
  email: string;
  /** Hebrew name resolved from names_to_emails. Empty string falls back
   *  to the email-prefix shortname (avatar still works the same). */
  heName: string;
  /** Role string from names_to_emails (e.g. "media", "manager"). Empty
   *  hides the emoji + role line in the dropdown. */
  role: string;
  /** Server action that signs the user out and redirects to /signin. */
  signOutAction: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const display =
    heName || (email.includes("@") ? email.slice(0, email.indexOf("@")) : email);
  const emoji = roleEmoji(role);
  const roleText = roleLabel(role);
  const tooltip = roleText ? `${display} · ${roleText}` : display;

  return (
    <div ref={wrapRef} className="topnav-user-menu-wrap">
      <button
        type="button"
        className="topnav-user-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tooltip}
      >
        <Avatar name={email} role={role} title={display} size={22} />
        <span className="topnav-user-name">{display}</span>
        {emoji && (
          <span className="topnav-user-role-emoji" aria-hidden>
            {emoji}
          </span>
        )}
        <span className="topnav-user-chev" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="topnav-user-menu" role="menu">
          <div className="topnav-user-menu-head">
            <Avatar name={email} role={role} title={display} size={36} />
            <div className="topnav-user-menu-meta">
              <div className="topnav-user-menu-name">{display}</div>
              <div className="topnav-user-menu-email" dir="ltr">
                {email}
              </div>
              {roleText && (
                <div className="topnav-user-menu-role">
                  {emoji && <span aria-hidden>{emoji} </span>}
                  {roleText}
                </div>
              )}
            </div>
          </div>
          <form action={signOutAction}>
            <button
              type="submit"
              className="topnav-user-menu-signout"
              role="menuitem"
            >
              יציאה
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
