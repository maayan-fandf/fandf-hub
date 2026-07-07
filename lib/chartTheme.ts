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
};

export function useChartPalette(): ChartPalette {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setDark(root.dataset.theme === "dark");
    read();
    const mo = new MutationObserver(read);
    mo.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return dark ? DARK : LIGHT;
}
