"use client";

import { useEffect, useRef, useState } from "react";

const HIDE_ENDED_KEY = "hub_hide_ended";

// Filter bar for the home page — currently just the hide-ended toggle.
// Per-person scoping moved to the gear-menu "view as" pref so a single
// control drives the home grid, top-nav projects list, and /tasks default
// filter together. The hide-ended toggle is independent (UI-local: it
// hides past-end project rows via a CSS data attribute).
//
// Default ON; explicit opt-out persists in localStorage. `mounted` gates
// the first DOM write to avoid hydration mismatch on the <html> data-
// attribute.
export default function HomeFilterBar() {
  const [hideEnded, setHideEnded] = useState(true);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    try {
      const v = localStorage.getItem(HIDE_ENDED_KEY);
      if (v === "0") setHideEnded(false);
    } catch {
      /* private mode — keep default */
    }
  }, []);
  useEffect(() => {
    if (!mounted) return;
    document.documentElement.dataset.hideEnded = hideEnded ? "1" : "0";
    try {
      localStorage.setItem(HIDE_ENDED_KEY, hideEnded ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [hideEnded, mounted]);
  // Apply the default data-attribute immediately on first mount, even if
  // the stored value matches the default — so CSS takes effect on first
  // hydration.
  const appliedInit = useRef(false);
  useEffect(() => {
    if (!mounted || appliedInit.current) return;
    appliedInit.current = true;
    document.documentElement.dataset.hideEnded = hideEnded ? "1" : "0";
  }, [mounted, hideEnded]);

  return (
    <div className="home-filter-bar">
      <button
        type="button"
        className={`home-filter-pill home-filter-pill--button${hideEnded ? " is-active" : ""}`}
        onClick={() => setHideEnded((v) => !v)}
        title={
          hideEnded
            ? "מציג רק פרויקטים פעילים (הסתיימו לפני יותר מ-5 ימים מוסתרים)"
            : "הסתר פרויקטים שתאריך הסיום שלהם עבר לפני יותר מ-5 ימים"
        }
      >
        <span className="home-filter-pill-icon" aria-hidden>
          🕑
        </span>
        <span>{hideEnded ? "הצג שהסתיימו" : "הסתר שהסתיימו"}</span>
      </button>
    </div>
  );
}
