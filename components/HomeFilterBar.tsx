"use client";

import { useEffect, useRef, useState } from "react";

const HIDE_ENDED_KEY = "hub_hide_ended";
const SHOW_MINE_KEY = "hub_show_mine";

// Filter bar for the home page — two pills:
//   1. הצג / הסתר שהסתיימו  — hides project rows past their end-date
//   2. הצג את כולם / רק את שלי — narrows the grid to projects where
//      the user has an open task or an open mention. "Mine" is computed
//      server-side from the byProject counts and stamped onto each
//      project row via data-mine="0|1" + each company group via
//      data-any-mine="0|1"; the toggle here flips data-show-mine on
//      <html> so the existing CSS-only hide pattern handles the rest.
//
// Per-person scoping moved to the gear-menu "view as" pref so a single
// control drives the home grid, top-nav projects list, and /tasks default
// filter together. Both toggles here are UI-local: they don't refetch
// data, just hide rows via CSS data attributes.
//
// Defaults: hide-ended ON, show-mine OFF. Explicit choices persist in
// localStorage. `mounted` gates the first DOM write to avoid hydration
// mismatch on the <html> data-attributes.
export default function HomeFilterBar() {
  const [hideEnded, setHideEnded] = useState(true);
  const [showMine, setShowMine] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    try {
      const v = localStorage.getItem(HIDE_ENDED_KEY);
      if (v === "0") setHideEnded(false);
      const m = localStorage.getItem(SHOW_MINE_KEY);
      if (m === "1") setShowMine(true);
    } catch {
      /* private mode — keep defaults */
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
  useEffect(() => {
    if (!mounted) return;
    document.documentElement.dataset.showMine = showMine ? "1" : "0";
    try {
      localStorage.setItem(SHOW_MINE_KEY, showMine ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [showMine, mounted]);
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
          onClick={() => setShowMine(true)}
          aria-selected={showMine}
          role="tab"
          title="מציג רק פרויקטים עם משימות פתוחות או תיוגים שלי"
        >
          <span aria-hidden>🎯</span>
          רק שלי
        </button>
        <button
          type="button"
          className={`tasks-scope-toggle-btn${!showMine ? " is-active" : ""}`}
          onClick={() => setShowMine(false)}
          aria-selected={!showMine}
          role="tab"
          title="הצג את כל הפרויקטים, גם אלה שאין לי בהם משימות / תיוגים פתוחים"
        >
          <span aria-hidden>🌐</span>
          הכל
        </button>
      </div>
    </div>
  );
}
