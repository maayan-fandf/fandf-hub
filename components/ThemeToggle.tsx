"use client";

import { useEffect, useRef, useState } from "react";

/**
 * תצוגה — the look picker.
 *
 * TWO independent axes, which is why this stopped being a three-state
 * cycle. `mode` is light/dark/auto and has always existed. `skin` is the
 * palette: the hub's own M3 violet, or "נייר" — the bone-and-terracotta
 * editorial palette from MOAD's design system (design/moad-base.css),
 * which the owner asked for on 2026-09-07 as a cleaner, more print-like
 * alternative.
 *
 * Cycling through five combinations with one button would mean pressing
 * it four times to get back, so the control is a small menu instead. The
 * two axes stay separate in storage: someone on the paper skin who
 * switches to dark keeps the paper skin.
 */

type Mode = "auto" | "light" | "dark";
type Skin = "hub" | "paper";

const MODE_KEY = "hub-theme";
const SKIN_KEY = "hub-skin";

const OPTIONS: { mode: Mode; skin: Skin; label: string; hint: string }[] = [
  { mode: "auto", skin: "hub", label: "אוטומטי", hint: "לפי הגדרת המערכת" },
  { mode: "light", skin: "hub", label: "בהיר", hint: "" },
  { mode: "dark", skin: "hub", label: "כהה", hint: "" },
  { mode: "light", skin: "paper", label: "נייר · בהיר", hint: "פלטה עיתונאית" },
  { mode: "dark", skin: "paper", label: "נייר · כהה", hint: "פלטה עיתונאית" },
];

/** Resolve and paint. Kept in step with THEME_INIT_SCRIPT in layout.tsx —
 *  that one runs before hydration, this one on every change. */
function apply(mode: Mode, skin: Skin) {
  const effective =
    mode === "dark"
      ? "dark"
      : mode === "light"
        ? "light"
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
  document.documentElement.dataset.theme = effective;
  // Absent rather than "hub" for the default, so every existing rule that
  // matches on :root keeps applying with no skin selector at all.
  if (skin === "paper") document.documentElement.dataset.skin = "paper";
  else delete document.documentElement.dataset.skin;
}

export default function ThemeToggle() {
  // "auto"/"hub" for SSR so server and client agree; the stored values
  // arrive in the effect below.
  const [mode, setMode] = useState<Mode>("auto");
  const [skin, setSkin] = useState<Skin>("hub");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const m = (localStorage.getItem(MODE_KEY) as Mode | null) ?? "auto";
    const s = (localStorage.getItem(SKIN_KEY) as Skin | null) ?? "hub";
    setMode(m);
    setSkin(s);

    // Follow the system while in auto.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystem = () => {
      const cur = (localStorage.getItem(MODE_KEY) as Mode | null) ?? "auto";
      if (cur === "auto") {
        apply("auto", (localStorage.getItem(SKIN_KEY) as Skin | null) ?? "hub");
      }
    };
    mq.addEventListener("change", onSystem);
    return () => mq.removeEventListener("change", onSystem);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (o: (typeof OPTIONS)[number]) => {
    setMode(o.mode);
    setSkin(o.skin);
    localStorage.setItem(MODE_KEY, o.mode);
    localStorage.setItem(SKIN_KEY, o.skin);
    apply(o.mode, o.skin);
    setOpen(false);
  };

  const current =
    OPTIONS.find((o) => o.mode === mode && o.skin === skin) ?? OPTIONS[0];

  return (
    <div className="theme-wrap" ref={wrapRef}>
      <button
        type="button"
        className="theme-toggle"
        onClick={() => setOpen((v) => !v)}
        title={`תצוגה: ${current.label}`}
        aria-label={`תצוגה: ${current.label}`}
        aria-expanded={open}
      >
        <span aria-hidden>◑</span>
      </button>
      {open && (
        <div className="theme-menu" role="menu" aria-label="תצוגה">
          <div className="theme-menu-title">תצוגה</div>
          {OPTIONS.map((o) => {
            const on = o.mode === current.mode && o.skin === current.skin;
            return (
              <button
                key={`${o.skin}-${o.mode}`}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className={"theme-menu-item" + (on ? " is-on" : "")}
                onClick={() => choose(o)}
              >
                <span className={`theme-swatch is-${o.skin}-${o.mode}`} aria-hidden />
                <span className="theme-menu-label">{o.label}</span>
                {o.hint && <span className="theme-menu-hint">{o.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
