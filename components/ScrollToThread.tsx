"use client";

import { useEffect } from "react";

// When the URL has a #thread-<id> hash (e.g. from a deep link in ⌘K or a
// dashboard drawer's "פתח בהאב" button), scroll that row into view and
// briefly flash it so the user sees the context. Runs once on mount.
export default function ScrollToThread() {
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || !hash.startsWith("#thread-")) return;
    const el = document.getElementById(hash.slice(1));
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
