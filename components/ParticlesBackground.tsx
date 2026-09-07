"use client";

import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "@/lib/anim";

/**
 * ParticlesBackground — animated ambient backdrop using particles.js
 * (VincentGarreau, CDN). Renders a single full-viewport canvas behind
 * all page content (position:fixed, z-index:-1, pointer-events:none).
 *
 * Four PAIRS rotate on each light↔dark toggle:
 *   1 · Aurora       — Dark cyan/white            ⇄ Light lavender
 *   2 · Snow         — Dark falling snow          ⇄ Light pale-blue snow
 *   3 · Cosmos       — Dark pink/purple nebula    ⇄ Light cherry blossom
 *   4 · Aurora-green — Dark green/teal aurora     ⇄ Light sky blue
 *
 * Rotation rule (mirrors the mockup the owner approved):
 *   • dark → light : stay on same pair, show its light twin
 *   • light → dark : advance pairIdx, show the new pair's dark side
 *
 * The pair index lives in localStorage under `hub-particles-pair`,
 * so the rotation persists across reloads. A MutationObserver on
 * <html data-theme> drives all transitions — works equally for
 * manual ThemeToggle clicks and OS "auto" theme flips.
 *
 * Note: particles.js mutates a global `window.pJSDom` array and
 * doesn't expose a clean teardown API, so on every re-init we walk
 * that array, find the entry whose canvas lives in our container,
 * call `pJS.fn.vendors.destroypJS()`, and remove it. Without this,
 * each theme flip would leak another canvas + animation loop.
 */

type ParticlesCfg = {
  count: number;
  area: number;
  colors: string[];
  opacity: number;
  opacityMin: number;
  size: number;
  link?: false;
  linkColor?: string;
  linkOpacity?: number;
  linkOpacityHover?: number;
  speed: number;
  direction?: "none" | "top" | "bottom" | "left" | "right";
  mode?: "grab" | "bubble";
  /** Full CSS `background` value applied to the canvas wrapper.
   *  Combines a soft radial glow + a vertical linear gradient — gives
   *  each pair its own scene rather than a flat M3 surface. Ported
   *  1:1 from the localhost:4321 mockup the owner approved. */
  bg: string;
};

type Pair = { name: string; dark: ParticlesCfg; light: ParticlesCfg };

const PAIRS: Pair[] = [
  {
    name: "aurora",
    dark: {
      count: 80, area: 800,
      colors: ["#a5f3fc", "#67e8f9", "#7dd3fc", "#ffffff"],
      opacity: 0.55, opacityMin: 0.15, size: 2.5,
      linkColor: "#3b82f6", linkOpacity: 0.15, linkOpacityHover: 0.4,
      speed: 0.6, direction: "none", mode: "grab",
      bg: "radial-gradient(ellipse 80% 60% at 50% 30%, rgba(59,130,246,.06), transparent 70%), linear-gradient(180deg, #060916 0%, #0b1430 50%, #060916 100%)",
    },
    light: {
      count: 70, area: 900,
      colors: ["#a78bfa", "#c4b5fd", "#93c5fd", "#ddd6fe"],
      opacity: 0.7, opacityMin: 0.25, size: 2.8,
      linkColor: "#8b5cf6", linkOpacity: 0.22, linkOpacityHover: 0.5,
      speed: 0.6, direction: "none", mode: "grab",
      bg: "radial-gradient(ellipse 80% 60% at 50% 30%, rgba(167,139,250,.10), transparent 70%), linear-gradient(180deg, #faf5ff 0%, #f3e8ff 50%, #faf5ff 100%)",
    },
  },
  {
    name: "snow",
    dark: {
      // Toned down 2026-05-27 — owner felt the snow-night was a little
      // too "in your face". Halved density, dropped opacity floor &
      // size, and slowed the fall so the flakes register as ambience
      // rather than a screen-saver.
      count: 60, area: 900,
      colors: ["#ffffff"],
      opacity: 0.55, opacityMin: 0.15, size: 2.6, link: false,
      speed: 1.1, direction: "bottom", mode: "bubble",
      bg: "radial-gradient(ellipse 80% 60% at 50% 35%, rgba(100,150,220,.08), transparent 70%), linear-gradient(180deg, #020617 0%, #0f172a 50%, #020617 100%)",
    },
    light: {
      count: 90, area: 800,
      colors: ["#bfdbfe", "#dbeafe", "#ffffff"],
      opacity: 0.85, opacityMin: 0.4, size: 3.5, link: false,
      speed: 1.5, direction: "bottom", mode: "bubble",
      bg: "radial-gradient(ellipse 80% 60% at 50% 35%, rgba(147,197,253,.10), transparent 70%), linear-gradient(180deg, #f8fafc 0%, #e0f2fe 50%, #f8fafc 100%)",
    },
  },
  {
    name: "cosmos",
    dark: {
      count: 50, area: 1100,
      colors: ["#ec4899", "#a855f7", "#8b5cf6", "#6366f1"],
      opacity: 0.7, opacityMin: 0.2, size: 4.5,
      linkColor: "#a855f7", linkOpacity: 0.18, linkOpacityHover: 0.5,
      speed: 0.5, direction: "none", mode: "grab",
      bg: "radial-gradient(ellipse 70% 60% at 50% 45%, rgba(168,85,247,.10), transparent 65%), linear-gradient(180deg, #0a0915 0%, #15102a 50%, #0a0915 100%)",
    },
    light: {
      count: 60, area: 900,
      colors: ["#fbcfe8", "#f9a8d4", "#fda4af", "#fecdd3"],
      opacity: 0.85, opacityMin: 0.35, size: 4, link: false,
      speed: 1.2, direction: "bottom", mode: "bubble",
      bg: "radial-gradient(ellipse 80% 60% at 50% 30%, rgba(244,114,182,.12), transparent 70%), linear-gradient(180deg, #fdf2f8 0%, #fce7f3 50%, #fdf2f8 100%)",
    },
  },
  {
    name: "aurora-green",
    dark: {
      count: 70, area: 800,
      colors: ["#10b981", "#34d399", "#22d3ee", "#86efac", "#ffffff"],
      opacity: 0.6, opacityMin: 0.2, size: 2.8,
      linkColor: "#10b981", linkOpacity: 0.15, linkOpacityHover: 0.4,
      speed: 0.5, direction: "none", mode: "grab",
      bg: "radial-gradient(ellipse 80% 60% at 50% 35%, rgba(34,211,238,.08), transparent 70%), linear-gradient(180deg, #050e15 0%, #0a1820 50%, #050e15 100%)",
    },
    light: {
      count: 75, area: 800,
      colors: ["#0ea5e9", "#38bdf8", "#7dd3fc", "#0284c7"],
      opacity: 0.7, opacityMin: 0.25, size: 2.6,
      linkColor: "#2563eb", linkOpacity: 0.22, linkOpacityHover: 0.5,
      speed: 0.6, direction: "none", mode: "grab",
      bg: "radial-gradient(ellipse 80% 60% at 50% 30%, rgba(59,130,246,.10), transparent 70%), linear-gradient(180deg, #f0f9ff 0%, #dbeafe 50%, #eff6ff 100%)",
    },
  },
  // ── The two paper pairs ──────────────────────────────────────────────
  //
  // These belong to the "נייר" skin and are not part of the free
  // rotation — see pairsForSkin(). Colours are MOAD's own (bone ground,
  // terracotta and teal accents), taken from its stylesheets rather than
  // sampled off a screenshot.
  //
  // Deliberately the quietest configs here: a third of aurora's particle
  // count, no link lines, and a ground gradient that barely moves off
  // flat. The point of this skin is that it reads like print, and a
  // constellation drifting behind a bone page undoes that on its own.
  {
    name: "paper",
    dark: {
      count: 26, area: 1400,
      colors: ["#4e9b92", "#93a38c", "#e9e0d2"],
      opacity: 0.3, opacityMin: 0.08, size: 1.8, link: false,
      speed: 0.25, direction: "none", mode: "bubble",
      bg: "radial-gradient(ellipse 80% 60% at 50% 25%, rgba(78,155,146,.07), transparent 70%), linear-gradient(180deg, #141c1b 0%, #1a2422 55%, #141c1b 100%)",
    },
    light: {
      count: 24, area: 1500,
      colors: ["#c4562f", "#e3a492", "#8b9c86"],
      opacity: 0.26, opacityMin: 0.07, size: 2, link: false,
      speed: 0.25, direction: "none", mode: "bubble",
      bg: "radial-gradient(ellipse 80% 60% at 50% 25%, rgba(196,86,47,.05), transparent 70%), linear-gradient(180deg, #f7efe3 0%, #f1e7d8 55%, #f7efe3 100%)",
    },
  },
  {
    name: "paper-teal",
    dark: {
      count: 26, area: 1400,
      colors: ["#e8a33d", "#93a38c", "#a2b0a9"],
      opacity: 0.28, opacityMin: 0.07, size: 1.8, link: false,
      speed: 0.22, direction: "none", mode: "bubble",
      bg: "radial-gradient(ellipse 80% 55% at 50% 30%, rgba(232,163,61,.06), transparent 70%), linear-gradient(180deg, #121917 0%, #19231f 55%, #121917 100%)",
    },
    light: {
      count: 24, area: 1500,
      colors: ["#3d6b6b", "#8b9c86", "#b9cfcb"],
      opacity: 0.24, opacityMin: 0.07, size: 2, link: false,
      speed: 0.22, direction: "none", mode: "bubble",
      bg: "radial-gradient(ellipse 80% 55% at 50% 30%, rgba(61,107,107,.06), transparent 70%), linear-gradient(180deg, #f4efe6 0%, #e9ede8 55%, #f4efe6 100%)",
    },
  },
];

/** Which pairs the current skin may show.
 *
 *  The backdrop and the palette have to agree — a bone page with the
 *  cosmos nebula behind it is two different products on one screen — so
 *  the paper skin rotates only through the paper pairs and the default
 *  skin only through the original four. Names rather than indices so
 *  inserting a pair later cannot silently re-partition the list. */
const PAPER_PAIRS = new Set(["paper", "paper-teal"]);
function pairsForSkin(): number[] {
  const paper =
    typeof document !== "undefined" &&
    document.documentElement.dataset.skin === "paper";
  const idx = PAIRS.map((_, i) => i).filter(
    (i) => PAPER_PAIRS.has(PAIRS[i].name) === paper,
  );
  return idx.length ? idx : [0];
}

const PAIR_KEY = "hub-particles-pair";
const CONTAINER_ID = "particles-bg";
const SCRIPT_SRC = "https://cdn.jsdelivr.net/particles.js/2.0.0/particles.min.js";

function buildParticlesConfig(c: ParticlesCfg) {
  return {
    particles: {
      number: { value: c.count, density: { enable: true, value_area: c.area } },
      color: { value: c.colors },
      shape: { type: "circle" },
      opacity: {
        value: c.opacity,
        random: true,
        anim: { enable: true, speed: 1, opacity_min: c.opacityMin, sync: false },
      },
      size: {
        value: c.size,
        random: true,
        anim: { enable: true, speed: 1.5, size_min: 0.5, sync: false },
      },
      line_linked:
        c.link === false
          ? { enable: false }
          : {
              enable: true,
              distance: 150,
              color: c.linkColor,
              opacity: c.linkOpacity,
              width: 1,
            },
      move: {
        enable: true,
        speed: c.speed,
        direction: c.direction || "none",
        random: true,
        straight: false,
        out_mode: "out",
        bounce: false,
      },
    },
    interactivity: {
      detect_on: "window",
      events: {
        onhover: { enable: true, mode: c.mode || "grab" },
        onclick: { enable: false },
        resize: true,
      },
      modes: {
        grab: {
          distance: 140,
          line_linked: { opacity: c.linkOpacityHover || 0.4 },
        },
        bubble: { distance: 110, size: c.size * 2, duration: 2, opacity: 1 },
      },
    },
    retina_detect: true,
  };
}

function loadParticlesScript(): Promise<void> {
  // Already loaded? — particlesJS is the global injected by the lib.
  if (typeof (window as unknown as { particlesJS?: unknown }).particlesJS === "function") {
    return Promise.resolve();
  }
  // Script tag already in DOM (in-flight)? — wait for its load.
  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${SCRIPT_SRC}"]`,
  );
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("particles.js failed to load")), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("particles.js failed to load"));
    document.head.appendChild(s);
  });
}

// Destroy every pJS instance whose canvas lives inside the given
// wrapper.
//
// IMPORTANT: do NOT call particles.js's own `destroypJS()` — it has a
// long-standing bug where the function body contains an unscoped
// assignment `pJSDom = null` (no `var`/`let`/`const`, no
// `window.` prefix). In sloppy mode that implicitly assigns to the
// global, so calling destroypJS once nukes `window.pJSDom` for the
// whole page and every subsequent `particlesJS()` call throws when
// it tries to push onto an array that's been replaced with null.
// That's exactly what was breaking the theme toggle live: first
// toggle nulled pJSDom, re-init crashed, canvas stayed blank, manual
// refresh fixed it because the lib re-initialised pJSDom = [].
//
// We instead reach into the instance, cancel the RAF directly, drop
// the canvas element from the DOM, and splice the entry out of
// pJSDom ourselves. No mystery globals get clobbered.
type PJSInstance = {
  pJS?: {
    canvas?: { el?: HTMLCanvasElement };
    fn?: { drawAnimFrame?: number };
  };
};
type WindowWithPJS = Window & {
  pJSDom?: PJSInstance[] | null;
  particlesJS?: (id: string, cfg: object) => void;
};

function ensurePJSDom(w: WindowWithPJS): PJSInstance[] {
  // If a previous destroypJS-style bug elsewhere on the page nulled
  // the global, restore it before we touch it.
  if (!Array.isArray(w.pJSDom)) w.pJSDom = [];
  return w.pJSDom;
}

function destroyInstancesInside(wrapper: HTMLElement) {
  const w = window as WindowWithPJS;
  const arr = ensurePJSDom(w);
  for (let i = arr.length - 1; i >= 0; i--) {
    const inst = arr[i];
    const canvasEl = inst?.pJS?.canvas?.el;
    if (canvasEl && wrapper.contains(canvasEl)) {
      const rafId = inst?.pJS?.fn?.drawAnimFrame;
      if (typeof rafId === "number") {
        try {
          cancelAnimationFrame(rafId);
        } catch {
          // best-effort
        }
      }
      try {
        canvasEl.remove();
      } catch {
        // canvas already detached — fine
      }
      arr.splice(i, 1);
    }
  }
}

// Monotonic counter so each re-init gets a never-before-used DOM id.
let innerIdCounter = 0;

function currentMode(): "dark" | "light" {
  const t = document.documentElement.dataset.theme;
  return t === "dark" ? "dark" : "light";
}

/** The look the user pinned in the תצוגה menu, or "" while rotating. */
function pinnedLook(): string {
  const v =
    typeof document !== "undefined" ? document.documentElement.dataset.look : "";
  return !v || v === "rotate" ? "" : v;
}

/** The stored index, snapped into the pairs the current skin allows.
 *
 *  A pinned look wins outright: the reader asked for שלג and must get
 *  שלג, not whatever the rotation had reached. One key across both skins
 *  otherwise, so switching to נייר and back lands where the rotation was
 *  rather than resetting it. */
function readPairIdx(): number {
  const pin = pinnedLook();
  if (pin) {
    const at = PAIRS.findIndex((p) => p.name === pin);
    if (at >= 0) return at;
  }
  const allowed = pairsForSkin();
  try {
    const v = parseInt(localStorage.getItem(PAIR_KEY) || "0", 10);
    if (Number.isFinite(v) && allowed.includes(v)) return v;
  } catch {
    /* localStorage can throw in private mode */
  }
  return allowed[0];
}

/** Next pair WITHIN the current skin's set. */
function nextPairIdx(cur: number): number {
  const allowed = pairsForSkin();
  const at = allowed.indexOf(cur);
  return allowed[(at + 1 + allowed.length) % allowed.length];
}

function writePairIdx(idx: number) {
  try {
    localStorage.setItem(PAIR_KEY, String(idx % PAIRS.length));
  } catch {
    // localStorage can throw in private mode — non-fatal
  }
}

export default function ParticlesBackground() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Track the last mode we initialized for so we can detect light↔dark flips
  // (the MutationObserver fires for any data-theme change including the
  // initial set during hydration, and we don't want to advance the pair
  // when nothing actually changed).
  const lastModeRef = useRef<"dark" | "light" | null>(null);
  const pairIdxRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Respect reduced-motion: skip the ambient particle animation
      // entirely for users who ask for less motion.
      if (prefersReducedMotion()) return;
      try {
        await loadParticlesScript();
      } catch {
        // CDN blocked or offline — silent. The page just doesn't get a
        // particle background; everything else still works.
        return;
      }
      if (cancelled) return;

      pairIdxRef.current = readPairIdx();
      lastModeRef.current = currentMode();
      renderCurrent();

      const obs = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type !== "attributes") continue;
          // A skin change repaints without advancing: the reader picked a
          // palette, not a new scene, and rotating underneath them would
          // make the same menu entry look different every time.
          if (r.attributeName === "data-skin" || r.attributeName === "data-look") {
            pairIdxRef.current = readPairIdx();
            writePairIdx(pairIdxRef.current);
            lastModeRef.current = currentMode();
            renderCurrent();
            continue;
          }
          if (r.attributeName === "data-theme") {
            const next = currentMode();
            const prev = lastModeRef.current;
            if (next === prev) continue;
            // light → dark advances the rotation — unless the reader
            // pinned a look, in which case advancing would silently
            // override the thing they just asked for.
            if (prev === "light" && next === "dark" && !pinnedLook()) {
              pairIdxRef.current = nextPairIdx(pairIdxRef.current);
              writePairIdx(pairIdxRef.current);
            }
            lastModeRef.current = next;
            renderCurrent();
          }
        }
      });
      obs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-skin", "data-look"],
      });

      // Stash on the closure so cleanup can disconnect.
      cleanupRef.current = () => {
        obs.disconnect();
        const wrapper = containerRef.current;
        if (wrapper) {
          destroyInstancesInside(wrapper);
          wrapper.innerHTML = "";
        }
      };

      function renderCurrent() {
        const wrapper = containerRef.current;
        if (!wrapper) return;
        const w = window as WindowWithPJS;
        if (typeof w.particlesJS !== "function") return;
        // Restore window.pJSDom if any prior code path (in this app or
        // a third-party script) clobbered it. particlesJS() pushes to
        // this array internally, so it MUST be an array before we call.
        ensurePJSDom(w);

        // Step 1 — tear down every pJS instance bound to our wrapper.
        destroyInstancesInside(wrapper);

        // Step 2 — completely empty the wrapper. Belt-and-suspenders
        // for any orphaned children we didn't track.
        wrapper.innerHTML = "";

        // Step 3 — create a brand-new inner div with a UNIQUE id and
        // run particles.js against it. The unique id matters because
        // particles.js v2 internally caches the target element ref;
        // reusing the same id on re-init produces a blank canvas.
        // Fresh id = clean init every time.
        const innerId = `particles-bg-inner-${++innerIdCounter}`;
        const inner = document.createElement("div");
        inner.id = innerId;
        inner.style.cssText =
          "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
        wrapper.appendChild(inner);

        const pair = PAIRS[pairIdxRef.current];
        const cfg = lastModeRef.current === "dark" ? pair.dark : pair.light;
        // Per-pair scenery bg (radial glow + vertical linear gradient).
        // Applied to the wrapper so it sits behind the canvas but
        // above the html `var(--bg)` fallback. Transitions smoothly
        // because globals.css gives the wrapper a `transition: opacity`
        // — we add a bg transition too via inline style below.
        wrapper.style.background = cfg.bg;
        w.particlesJS(innerId, buildParticlesConfig(cfg));
        // Fade in once initialized.
        wrapper.classList.add("ready");
      }
    }

    const cleanupRef: { current: (() => void) | null } = { current: null };
    init();

    return () => {
      cancelled = true;
      cleanupRef.current?.();
    };
  }, []);

  return <div id={CONTAINER_ID} ref={containerRef} aria-hidden />;
}
