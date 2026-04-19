/**
 * Deterministic color assignment based on a string (e.g. email, company
 * name). Same input always maps to the same palette slot, so the same
 * company is the same color across every page.
 */

const AVATAR_HUES = [
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#f97316", // orange
  "#eab308", // yellow
  "#84cc16", // lime
  "#10b981", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#a855f7", // purple
  "#f43f5e", // rose
];

const AVATAR_SOFTS = [
  "#ede9fe",
  "#fce7f3",
  "#ffedd5",
  "#fef9c3",
  "#ecfccb",
  "#d1fae5",
  "#ccfbf1",
  "#cffafe",
  "#dbeafe",
  "#e0e7ff",
  "#f3e8ff",
  "#ffe4e6",
];

/** djb2-ish small hash — enough spread for stable bucket assignment. */
function hashString(s: string): number {
  let h = 5381;
  const str = (s || "").toLowerCase();
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Return { solid, soft } colors deterministically derived from `key`. */
export function colorForKey(key: string): { solid: string; soft: string } {
  const idx = hashString(key) % AVATAR_HUES.length;
  return { solid: AVATAR_HUES[idx], soft: AVATAR_SOFTS[idx] };
}

/** The N-th slot's CSS variable pair, for use in inline styles. */
export function companyColorVars(
  key: string,
): { "--co-solid": string; "--co-soft": string } {
  const { solid, soft } = colorForKey(key);
  return { "--co-solid": solid, "--co-soft": soft };
}

/** Pick a 1- or 2-char label from a name/email for avatar use. */
export function initialsForKey(key: string): string {
  const s = String(key || "").trim();
  if (!s) return "?";
  // If it looks like an email, use the part before @ and split on dots/underscores.
  const local = s.includes("@") ? s.split("@")[0] : s;
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return local.slice(0, 1).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
