"use client";

import { useEffect } from "react";

/**
 * Scroll-to-anchor + flash on arrival.
 *
 * Two anchor shapes today, both land the user on a specific row and
 * briefly flash it via the `is-flashing` class:
 *   • `#thread-<id>`  — project timeline rows (⌘K, dashboard drawer)
 *   • `#c=<id>`       — task discussion comments, used as the
 *                       deep-link target by mention notifications
 *                       (see hubTaskDiscussionUrl in
 *                       lib/commentsDirect.ts). The matching DOM id is
 *                       `c-<id>` on the comment <li>.
 *
 * Runs once on mount. Both surfaces add their own `is-flashing` CSS
 * (timeline-flash for cards, thread-reply-flash for comments).
 */
export default function ScrollToThread() {
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;
    let elId: string | null = null;
    if (hash.startsWith("#thread-")) {
      elId = hash.slice(1);
    } else if (hash.startsWith("#c=")) {
      // Mention deep-link. The hash carries the raw (possibly
      // encoded) comment_id; the DOM id is "c-<comment_id>".
      try {
        elId = "c-" + decodeURIComponent(hash.slice(3));
      } catch {
        return;
      }
    } else {
      return;
    }
    const el = document.getElementById(elId);
    if (!el) return;
    // Defer one frame so the browser has layout for the target.
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("is-flashing");
      window.setTimeout(() => el.classList.remove("is-flashing"), 2400);
    });
  }, []);
  return null;
}
