"use client";

import { useEffect, useState } from "react";

type Theme = "auto" | "light" | "dark";

const ICONS: Record<Theme, string> = {
  auto: "🖥️",
  light: "☀️",
  dark: "🌙",
};

const LABELS: Record<Theme, string> = {
  auto: "אוטומטי",
  light: "בהיר",
  dark: "כהה",
};

const STORAGE_KEY = "hub-theme";

/** Resolve chosen theme to "light" | "dark" and apply to <html>. */
function applyTheme(theme: Theme) {
  let effective: "light" | "dark";
  if (theme === "dark") effective = "dark";
  else if (theme === "light") effective = "light";
  else {
    effective = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  document.documentElement.dataset.theme = effective;
}

/**
 * Three-state theme toggle — auto → light → dark → auto. Persisted to
 * localStorage under "hub-theme". The blocking <script> injected in
 * layout.tsx handles the pre-hydration paint; this component handles
 * user toggling + reactive system-preference changes while in auto.
 */
export default function ThemeToggle() {
  // Start in "auto" for SSR so server+client agree on markup. We read the
  // real stored value in useEffect and re-render the icon.
  const [theme, setTheme] = useState<Theme>("auto");

  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "auto";
    setTheme(stored);

    // If we're in auto, follow system changes live.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const current = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "auto";
      if (current === "auto") applyTheme("auto");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  function cycle() {
    const order: Theme[] = ["auto", "light", "dark"];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycle}
      title={`תצוגה: ${LABELS[theme]} · לחץ להחלפה`}
      aria-label={`תצוגה: ${LABELS[theme]}`}
    >
      <span aria-hidden>{ICONS[theme]}</span>
    </button>
  );
}
