"use client";

import { useEffect, useRef, useState } from "react";

const HIDE_ENDED_KEY = "hub_hide_ended";
// `_v3` — third revision. Earlier keys accumulated pollution because
// the storage write fired on every state change, so any transient
// `false` during hydration / re-render persisted forever. v3 only
// writes when the user actively flips to non-default (הכל / הצג
// שהסתיימו), and clears the key when they flip back to default.
// Absence of a value MEANS "use default" — which means future
// transient renders can't write spurious "0" entries.
const SHOW_MINE_KEY = "hub_show_mine_v3";

// Filter bar for the home page — two controls:
//   1. הצג / הסתר שהסתיימו  — hides project rows past their end-date
//      Default: hide ended.
//   2. רק שלי / הכל — narrows the grid to projects where the user is
//      on the roster (same "involved at" semantic as /tasks).
//      Default: רק שלי (narrowed).
//
// Storage discipline: localStorage is written ONLY when the user
// actively opts away from a default, and CLEARED when they opt back.
// This means the absence of a value is always interpretable as
// "default applies", which makes the defaults immune to mid-render
// state flips writing spurious values.
export default function HomeFilterBar() {
  const [hideEnded, setHideEnded] = useState(true);
  const [showMine, setShowMine] = useState(true);
  const [mounted, setMounted] = useState(false);

  // First-mount read: hydrate state from localStorage exactly once.
  useEffect(() => {
    setMounted(true);
    try {
      const v = localStorage.getItem(HIDE_ENDED_KEY);
      if (v === "0") setHideEnded(false);
      const m = localStorage.getItem(SHOW_MINE_KEY);
      // Only flip OFF the default when the user has explicitly opted
      // out — any other value (including missing) keeps the default.
      if (m === "0") setShowMine(false);
    } catch {
      /* private mode — keep defaults */
    }
  }, []);

  // Reflect state to the <html> data-attributes so the CSS hide rules
  // pick it up. No localStorage write here — writes happen in the
  // explicit click handlers below.
  useEffect(() => {
    if (!mounted) return;
    document.documentElement.dataset.hideEnded = hideEnded ? "1" : "0";
    document.documentElement.dataset.showMine = showMine ? "1" : "0";
  }, [hideEnded, showMine, mounted]);

  // Apply default data-attributes immediately on first mount, even if
  // the stored values match defaults — so CSS takes effect on first
  // hydration.
  const appliedInit = useRef(false);
  useEffect(() => {
    if (!mounted || appliedInit.current) return;
    appliedInit.current = true;
    document.documentElement.dataset.hideEnded = hideEnded ? "1" : "0";
    document.documentElement.dataset.showMine = showMine ? "1" : "0";
  }, [mounted, hideEnded, showMine]);

  // Click handlers — single source of truth for localStorage writes.
  // Each handler writes ONLY when moving to the non-default state and
  // CLEARS the key when moving back to default. That way no stale
  // value can persist past a deliberate user action.
  function toggleHideEnded() {
    const next = !hideEnded;
    setHideEnded(next);
    try {
      if (next) localStorage.removeItem(HIDE_ENDED_KEY);
      else localStorage.setItem(HIDE_ENDED_KEY, "0");
    } catch {
      /* ignore */
    }
  }

  function setMine(active: boolean) {
    setShowMine(active);
    try {
      if (active) localStorage.removeItem(SHOW_MINE_KEY);
      else localStorage.setItem(SHOW_MINE_KEY, "0");
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="home-filter-bar">
      <button
        type="button"
        className={`home-filter-pill home-filter-pill--button${hideEnded ? " is-active" : ""}`}
        onClick={toggleHideEnded}
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
      {/* Segmented "scope" control — visual twin of the /tasks page's
          TasksScopeToggle so the gesture feels the same across surfaces.
          Buttons (not Links) because the toggle is client-only state:
          flips data-show-mine on <html>; CSS does the hide. */}
      <div
        className="tasks-scope-toggle"
        role="tablist"
        aria-label="היקף הרשת"
      >
        <button
          type="button"
          className={`tasks-scope-toggle-btn${showMine ? " is-active" : ""}`}
          onClick={() => setMine(true)}
          aria-selected={showMine}
          role="tab"
          title="הראה רק פרויקטים שאני ברשימת הצוות שלהם"
        >
          <span aria-hidden>🎯</span>
          רק שלי
        </button>
        <button
          type="button"
          className={`tasks-scope-toggle-btn${!showMine ? " is-active" : ""}`}
          onClick={() => setMine(false)}
          aria-selected={!showMine}
          role="tab"
          title="הצג את כל הפרויקטים שיש לי גישה אליהם, גם אם איני בצוות"
        >
          <span aria-hidden>🌐</span>
          הכל
        </button>
      </div>
    </div>
  );
}
