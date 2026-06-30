import { useEffect, useLayoutEffect } from "react";

/**
 * Shared motion helpers for the anime.js polish layer.
 *
 * Two rules every animated surface follows:
 *  1. Honor prefers-reduced-motion — this is a daily-driver dashboard,
 *     so a user who asks for reduced motion gets the final state with no
 *     tweening. Every component bails to the static value when this is true.
 *  2. One motion voice — durations / easings / stagger live here as tokens
 *     so the home grid, the KPI tiles, and any future surface animate
 *     consistently instead of each picking its own numbers.
 *
 * anime.js itself is imperative + window-bound, so it's only ever imported
 * inside "use client" components. This file stays import-light (just React
 * hooks) so it's safe to pull into any client component.
 */

/** matchMedia reduced-motion check. Returns false during SSR. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * useLayoutEffect on the client, useEffect on the server — avoids React's
 * "useLayoutEffect does nothing on the server" warning while still letting
 * us mutate the DOM (pre-hide reveal targets, seed the count-up start
 * value) BEFORE the browser paints, so there's no flash of the final state.
 */
export const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** Motion tokens. Kept deliberately calm + short for a tool used all day. */
export const ANIM = {
  /** Count-up tween length (ms). */
  countDuration: 750,
  /** Entrance reveal length (ms). */
  revealDuration: 540,
  /** Per-item stagger (ms) — clamped down for long lists by StaggerReveal. */
  stagger: 70,
  /** Number tween easing — fast out, gentle settle. */
  ease: "outExpo" as const,
  /** Entrance easing. */
  revealEase: "outCubic" as const,
  /** Entrance translateY distance (px). */
  revealY: 14,
} as const;

/**
 * Shared count-up formatters — one numeric voice across every surface.
 * Pass to <CountUp format={…} />. Use `decimals={1}` on CountUp alongside
 * `countPct` so the in-flight tween keeps its decimal.
 */
/** Whole number, he-IL grouping (e.g. 1,234). */
export const countInt = (n: number) => Math.round(n).toLocaleString("he-IL");
/** Shekel currency, no decimals (e.g. ₪1,234). */
export const countILS = (n: number) =>
  "₪" + Math.round(n).toLocaleString("he-IL");
/** Percentage with one decimal (e.g. 12.3%). Use with CountUp decimals={1}. */
export const countPct = (n: number) => `${n.toFixed(1)}%`;
/** Nav-badge count, capped at "99+" (e.g. 7, 99+). */
export const countBadge = (n: number) =>
  n > 99 ? "99+" : Math.round(n).toLocaleString("he-IL");
