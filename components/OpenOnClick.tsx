"use client";

import type { ReactNode } from "react";

/**
 * Wraps content in a click-to-navigate surface. A click anywhere on it
 * goes to `href` — EXCEPT a click that lands on an inner interactive
 * element (a <button> like the read-more toggle, or an <a>/autolink),
 * which is left alone to do its own thing.
 *
 * Used to make a תיוגים-inbox mention card's message body open the
 * comment on its project page, without swallowing the read-more toggle
 * or the @-mention / link chips rendered inside the body.
 *
 * Navigation is a full document load (window.location) on purpose: the
 * href carries a `#thread-<id>` hash and the target thread is
 * server-rendered into the project page, so a hard navigation lets the
 * browser scroll to — and `:target`-highlight — the exact message
 * reliably, which a client-side router.push doesn't guarantee for a
 * cross-route hash.
 */
export default function OpenOnClick({
  href,
  className,
  title,
  children,
}: {
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const go = () => window.location.assign(href);
  return (
    <div
      className={className}
      role="link"
      tabIndex={0}
      title={title}
      onClick={(e) => {
        // Inner controls (read-more button, autolinks) keep working.
        if ((e.target as HTMLElement).closest("a, button")) return;
        go();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      }}
    >
      {children}
    </div>
  );
}
