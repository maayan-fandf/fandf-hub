"use client";

import { useEffect, useRef, useState } from "react";

/**
 * תצוגה — the look picker.
 *
 * TWO axes, shown as two axes, because that is what they are:
 *
 *   מצב     בהיר / כהה / אוטומטי        → data-theme
 *   נראות   the backdrop scene + palette → data-skin + the particles pair
 *
 * The four original scenes (זוהר / שלג / קוסמוס / זוהר ירוק) already
 * existed but were only reachable by rotation — each light→dark toggle
 * advanced to the next one and there was no way to ask for a particular
 * one. A first version of this menu offered five flat entries and made
 * that worse: the four looked like they had been removed. They are named
 * here instead, alongside מתחלף, which is the old rotating behaviour and
 * stays the default.
 *
 * Picking a look is what selects the palette too: the two נייר scenes
 * carry the bone-and-terracotta token skin, the other four carry the
 * hub's own. A backdrop and a palette that disagree are two products on
 * one screen, so they are one choice rather than two.
 */

type Mode = "auto" | "light" | "dark";
/** "rotate" keeps the historical behaviour; anything else pins a pair by
 *  its name in components/ParticlesBackground.tsx. */
type Look =
  | "rotate"
  | "aurora"
  | "snow"
  | "cosmos"
  | "aurora-green"
  | "paper"
  | "paper-teal";

const MODE_KEY = "hub-theme";
const LOOK_KEY = "hub-look";
/** Read by ParticlesBackground, which owns the pair list. */
const PAIR_KEY = "hub-particles-pair";
const PAIR_ORDER: Look[] = [
  "aurora",
  "snow",
  "cosmos",
  "aurora-green",
  "paper",
  "paper-teal",
];
const PAPER_LOOKS = new Set<Look>(["paper", "paper-teal"]);

const MODES: { key: Mode; label: string; hint?: string }[] = [
  { key: "auto", label: "אוטומטי", hint: "לפי הגדרת המערכת" },
  { key: "light", label: "בהיר" },
  { key: "dark", label: "כהה" },
];

const LOOKS: { key: Look; label: string; hint?: string }[] = [
  { key: "rotate", label: "מתחלף", hint: "נראות חדשה בכל מעבר לכהה" },
  { key: "aurora", label: "זוהר" },
  { key: "snow", label: "שלג" },
  { key: "cosmos", label: "קוסמוס" },
  { key: "aurora-green", label: "זוהר ירוק" },
  { key: "paper", label: "נייר", hint: "פלטה עיתונאית" },
  { key: "paper-teal", label: "נייר · טורקיז", hint: "פלטה עיתונאית" },
];

function apply(mode: Mode, look: Look) {
  const effective =
    mode === "dark"
      ? "dark"
      : mode === "light"
        ? "light"
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
  document.documentElement.dataset.theme = effective;
  // Absent rather than "hub" for the default, so every rule written
  // against plain :root keeps applying with no skin selector at all.
  if (PAPER_LOOKS.has(look)) document.documentElement.dataset.skin = "paper";
  else delete document.documentElement.dataset.skin;
  // Pin the scene by writing the pair index the backdrop reads. "rotate"
  // leaves whatever is stored alone — that is the whole point of it.
  if (look !== "rotate") {
    try {
      localStorage.setItem(PAIR_KEY, String(PAIR_ORDER.indexOf(look)));
    } catch {
      /* private mode */
    }
  }
  document.documentElement.dataset.look = look;
}

export default function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("auto");
  const [look, setLook] = useState<Look>("rotate");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const m = (localStorage.getItem(MODE_KEY) as Mode | null) ?? "auto";
    const l = (localStorage.getItem(LOOK_KEY) as Look | null) ?? "rotate";
    setMode(m);
    setLook(l);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystem = () => {
      if ((localStorage.getItem(MODE_KEY) as Mode | null) === "auto" || !localStorage.getItem(MODE_KEY)) {
        apply("auto", (localStorage.getItem(LOOK_KEY) as Look | null) ?? "rotate");
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

  const chooseMode = (m: Mode) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
    apply(m, look);
  };
  const chooseLook = (l: Look) => {
    setLook(l);
    localStorage.setItem(LOOK_KEY, l);
    apply(mode, l);
  };

  return (
    <div className="theme-wrap" ref={wrapRef}>
      <button
        type="button"
        className="theme-toggle"
        onClick={() => setOpen((v) => !v)}
        title="תצוגה"
        aria-label="תצוגה"
        aria-expanded={open}
      >
        <span aria-hidden>◑</span>
      </button>
      {open && (
        <div className="theme-menu" role="menu" aria-label="תצוגה">
          <div className="theme-menu-title">מצב</div>
          {MODES.map((o) => (
            <button
              key={o.key}
              type="button"
              role="menuitemradio"
              aria-checked={mode === o.key}
              className={"theme-menu-item" + (mode === o.key ? " is-on" : "")}
              onClick={() => chooseMode(o.key)}
            >
              <span className={`theme-swatch is-mode-${o.key}`} aria-hidden />
              <span className="theme-menu-label">{o.label}</span>
              {o.hint && <span className="theme-menu-hint">{o.hint}</span>}
            </button>
          ))}
          <div className="theme-menu-sep" />
          <div className="theme-menu-title">נראות</div>
          {LOOKS.map((o) => (
            <button
              key={o.key}
              type="button"
              role="menuitemradio"
              aria-checked={look === o.key}
              className={"theme-menu-item" + (look === o.key ? " is-on" : "")}
              onClick={() => chooseLook(o.key)}
            >
              <span className={`theme-swatch is-look-${o.key}`} aria-hidden />
              <span className="theme-menu-label">{o.label}</span>
              {o.hint && <span className="theme-menu-hint">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
