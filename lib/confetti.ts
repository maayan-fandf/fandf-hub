/**
 * Confetti burst — small celebration animation triggered when a task
 * transitions into `done`. Pure DOM + CSS, no library dependency.
 *
 * Each call appends a fixed-position container to <body>, spawns ~48
 * particles around the given origin (defaulting to viewport-center,
 * upper-third), and self-cleans after the animation finishes. Safe to
 * call multiple times in a row — each burst is its own container.
 *
 * Skips entirely when the user has `prefers-reduced-motion: reduce`.
 */

const COLORS = [
  "#f59e0b", // amber
  "#10b981", // emerald
  "#2563eb", // blue
  "#dc2626", // red
  "#a855f7", // purple
  "#ec4899", // pink
  "#facc15", // yellow
];

const PARTICLE_COUNT = 48;
const ANIMATION_MS = 1400;

export function fireConfetti(origin?: { x: number; y: number }): void {
  if (typeof document === "undefined") return;
  if (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }

  const ox = origin?.x ?? window.innerWidth / 2;
  const oy = origin?.y ?? window.innerHeight / 3;

  const container = document.createElement("div");
  container.className = "confetti-burst-container";
  container.setAttribute("aria-hidden", "true");

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.style.left = `${ox}px`;
    piece.style.top = `${oy}px`;
    piece.style.background =
      COLORS[Math.floor(Math.random() * COLORS.length)];

    // Polar burst with upward bias so pieces shoot up before gravity
    // pulls them down (the keyframe handles the gravity in the second
    // half of the animation).
    const angle = Math.random() * Math.PI * 2;
    const power = 180 + Math.random() * 220;
    const dx = Math.cos(angle) * power;
    const dy = Math.sin(angle) * power - 220;
    const rot = (Math.random() - 0.5) * 720;
    const scale = 0.6 + Math.random() * 0.6;

    piece.style.setProperty("--dx", `${dx.toFixed(0)}px`);
    piece.style.setProperty("--dy", `${dy.toFixed(0)}px`);
    piece.style.setProperty("--rot", `${rot.toFixed(0)}deg`);
    piece.style.setProperty("--scale", `${scale.toFixed(2)}`);
    piece.style.animationDelay = `${Math.floor(Math.random() * 80)}ms`;

    container.appendChild(piece);
  }

  document.body.appendChild(container);
  window.setTimeout(() => container.remove(), ANIMATION_MS + 200);
}
