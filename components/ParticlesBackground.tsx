"use client";

import { useEffect, useRef } from "react";

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
    },
    light: {
      count: 70, area: 900,
      colors: ["#a78bfa", "#c4b5fd", "#93c5fd", "#ddd6fe"],
      opacity: 0.7, opacityMin: 0.25, size: 2.8,
      linkColor: "#8b5cf6", linkOpacity: 0.22, linkOpacityHover: 0.5,
      speed: 0.6, direction: "none", mode: "grab",
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
    },
    light: {
      count: 90, area: 800,
      colors: ["#bfdbfe", "#dbeafe", "#ffffff"],
      opacity: 0.85, opacityMin: 0.4, size: 3.5, link: false,
      speed: 1.5, direction: "bottom", mode: "bubble",
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
    },
    light: {
      count: 60, area: 900,
      colors: ["#fbcfe8", "#f9a8d4", "#fda4af", "#fecdd3"],
      opacity: 0.85, opacityMin: 0.35, size: 4, link: false,
      speed: 1.2, direction: "bottom", mode: "bubble",
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
    },
    light: {
      count: 75, area: 800,
      colors: ["#0ea5e9", "#38bdf8", "#7dd3fc", "#0284c7"],
      opacity: 0.7, opacityMin: 0.25, size: 2.6,
      linkColor: "#2563eb", linkOpacity: 0.22, linkOpacityHover: 0.5,
      speed: 0.6, direction: "none", mode: "grab",
    },
  },
];

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

// Destroy any prior instance bound to our container so re-init doesn't
// leak canvases + RAF loops. particles.js exposes its instances in
// window.pJSDom — we filter the array in place to drop ours.
function destroyExisting() {
  const w = window as unknown as {
    pJSDom?: Array<{ pJS?: { canvas?: { el?: HTMLCanvasElement }; fn?: { vendors?: { destroypJS?: () => void } } } }>;
  };
  if (!Array.isArray(w.pJSDom)) return;
  for (let i = w.pJSDom.length - 1; i >= 0; i--) {
    const inst = w.pJSDom[i];
    const canvasEl = inst?.pJS?.canvas?.el;
    if (canvasEl && canvasEl.parentElement?.id === CONTAINER_ID) {
      try {
        inst?.pJS?.fn?.vendors?.destroypJS?.();
      } catch {
        // best-effort
      }
      w.pJSDom.splice(i, 1);
    }
  }
  // Also wipe any orphaned canvas children just in case destroypJS
  // didn't fully clean up.
  const container = document.getElementById(CONTAINER_ID);
  if (container) {
    container.querySelectorAll("canvas").forEach((c) => c.remove());
  }
}

function currentMode(): "dark" | "light" {
  const t = document.documentElement.dataset.theme;
  return t === "dark" ? "dark" : "light";
}

function readPairIdx(): number {
  try {
    const v = parseInt(localStorage.getItem(PAIR_KEY) || "0", 10);
    if (!Number.isFinite(v) || v < 0) return 0;
    return v % PAIRS.length;
  } catch {
    return 0;
  }
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
          if (r.type === "attributes" && r.attributeName === "data-theme") {
            const next = currentMode();
            const prev = lastModeRef.current;
            if (next === prev) continue;
            // light → dark: advance pair before rendering the new dark side.
            if (prev === "light" && next === "dark") {
              pairIdxRef.current = (pairIdxRef.current + 1) % PAIRS.length;
              writePairIdx(pairIdxRef.current);
            }
            lastModeRef.current = next;
            renderCurrent();
          }
        }
      });
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      // Stash on the closure so cleanup can disconnect.
      cleanupRef.current = () => {
        obs.disconnect();
        destroyExisting();
      };

      function renderCurrent() {
        const w = window as unknown as { particlesJS?: (id: string, cfg: object) => void };
        if (typeof w.particlesJS !== "function") return;
        destroyExisting();
        const pair = PAIRS[pairIdxRef.current];
        const cfg = lastModeRef.current === "dark" ? pair.dark : pair.light;
        w.particlesJS(CONTAINER_ID, buildParticlesConfig(cfg));
        // Fade in once initialized.
        containerRef.current?.classList.add("ready");
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
