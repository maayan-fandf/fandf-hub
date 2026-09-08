"use client";

import { useEffect, useState } from "react";

/**
 * Theme-aware chart palette. Recharts takes literal color strings (SVG
 * attributes computed in JS), so CSS variables can't carry the theme
 * there — this hook watches <html data-theme> (set by ThemeToggle) and
 * hands charts a palette that clears 3:1 contrast on the active
 * surface (accents validated with the dataviz palette checker:
 * #4338ca on #fffbff, #6366f1 on #1a2234).
 *
 * SSR/first paint assumes light; corrects after hydration. Only the
 * accent hue shifts, so the flash is negligible.
 */

export type ChartPalette = {
  /** Single-series accent (lines, bars, dots). */
  accent: string;
  /** De-emphasized series ("others", reference). */
  deemph: string;
  /** IQR-band / area wash fill. */
  wash: string;
  /** Hairline grid stroke. */
  grid: string;
  /** Axis tick text. */
  tick: string;
  /** Tooltip surface + border (recharts inline styles). */
  tooltipBg: string;
  tooltipBorder: string;
  tooltipInk: string;
  /** Fill for a HOLLOW marker — a dot that means "this period has not
   *  closed yet". It has to be the surface the chart actually sits on, or
   *  the ring reads as a white blob instead of a hole: under the נייר skin
   *  the card is bone (#f1e7d8), not white. Resolved from
   *  --md-sys-color-surface at runtime, with these literals as the
   *  pre-hydration fallback. */
  hollow: string;
};

const LIGHT: ChartPalette = {
  accent: "#4338ca",
  deemph: "#94a3b8",
  wash: "rgba(67,56,202,0.10)",
  grid: "rgba(100,116,139,0.18)",
  tick: "#64748b",
  tooltipBg: "#ffffff",
  tooltipBorder: "#e5e7eb",
  tooltipInk: "#1f2937",
  hollow: "#ffffff",
};

const DARK: ChartPalette = {
  accent: "#6366f1",
  deemph: "#64748b",
  wash: "rgba(99,102,241,0.14)",
  grid: "rgba(148,163,184,0.14)",
  tick: "#94a3b8",
  tooltipBg: "#1e293b",
  tooltipBorder: "#334155",
  tooltipInk: "#e2e8f0",
  hollow: "#1e293b",
};

export function useChartPalette(): ChartPalette {
  const [dark, setDark] = useState(false);
  /** The live surface colour, for markers that must disappear into the
   *  card. Empty until hydration, and empty stays "use the literal". */
  const [surface, setSurface] = useState("");
  useEffect(() => {
    const root = document.documentElement;
    const read = () => {
      setDark(root.dataset.theme === "dark");
      // A skin can repaint the card without touching data-theme, so this
      // is read rather than assumed — נייר's bone surface is neither of
      // the two literals below.
      setSurface(
        getComputedStyle(root).getPropertyValue("--md-sys-color-surface").trim(),
      );
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme", "data-skin", "data-look"],
    });
    return () => mo.disconnect();
  }, []);
  const base = dark ? DARK : LIGHT;
  return surface ? { ...base, hollow: surface } : base;
}
