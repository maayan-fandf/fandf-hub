/**
 * Hebrew real-estate price extractor — picks the "starting from"
 * price out of a chunk of marketing text (landing page HTML, ad copy,
 * etc.). Used by the price-mismatch alert to detect when the
 * advertised price drifts between website, Google Ads, and Facebook
 * Ads on the same project.
 *
 * Design decisions:
 *
 * - Returns the LOWEST plausibly-real price detected. Marketing copy
 *   commonly mentions multiple prices (₪2.5M starting / ₪4.3M for the
 *   penthouse / ₪500k mortgage assist), but the "מ-X" / "החל מ-X"
 *   anchor is what shows up as the headline figure across all surfaces.
 *   Picking the minimum captures that intent without needing to parse
 *   the full apartment table.
 *
 * - Hebrew + English number formats both supported. `2,500,000`,
 *   `2.5M`, `2.5 מיליון`, `2500000` all normalise to 2500000.
 *
 * - Plausibility window: 500k–50M ₪. Tighter than full real-estate
 *   range to filter out random page numbers (page IDs / phone digits
 *   / years), and any "₪0" placeholder text.
 *
 * - Currency-marker required somewhere in the immediate vicinity:
 *   one of ₪ / ש"ח / ש״ח / שח / NIS / nis. Stops the regex from
 *   matching e.g. "מ-100,000 צפיות" (100k views).
 */

/**
 * Match a Hebrew/English number, allowing both `,` thousands separators
 * and `.` decimals. The trailing `\b` boundary stops it eating into a
 * following word. Greedy on integer part (so 2,500,000 reads as a
 * single token, not as 2 / 500 / 000).
 */
const NUM_RE = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/;

/**
 * Million-suffix marker — matched after the number to scale it.
 *   "2.5 מיליון"  → ×1_000_000
 *   "2.5M"        → ×1_000_000
 *   "2.5 מ"       → ×1_000_000 (informal Hebrew shorthand "מ׳")
 *
 * The trailing lookahead requires the suffix to end at whitespace,
 * end-of-input, or punctuation — `\b` alone failed here because
 * JavaScript's word-boundary doesn't recognise Hebrew letters as word
 * characters without the `u` flag, so `מיליון\b` would never match
 * when followed by a Hebrew letter (e.g. "מיליון ש״ח").
 */
const MILLION_RE = /\s*(?:מיליון|מיליו׳|מ׳|M|m)(?=\s|$|[.,;:!?'"״׳])/;

/**
 * Currency markers — at least one must appear within `CURRENCY_WINDOW`
 * characters of the matched number. Without this, every number on the
 * page would be a candidate; with it, we anchor on real prices.
 */
const CURRENCY_RE = /(?:₪|ש"ח|ש״ח|שח|NIS|nis)/;
const CURRENCY_WINDOW = 40;

/** Plausibility window for a residential real-estate "starting price"
 *  in NIS. Below 500k catches no legitimate listing in 2026 Israel;
 *  above 50M is almost certainly a typo (or aggregated portfolio
 *  total). Both bounds are wide enough to leave room for outliers. */
const MIN_PLAUSIBLE = 500_000;
const MAX_PLAUSIBLE = 50_000_000;

export type DetectedPrice = {
  /** Normalised value in NIS. */
  value: number;
  /** The literal substring from the source text — kept for debug /
   *  display ("we found this price in this exact phrase"). */
  matched: string;
  /** Char offset of the match in the original text. */
  index: number;
  /** True when the price is immediately preceded by a "headline
   *  marketing anchor" — `החל מ-` / `מ-` / `מחיר:` / `מחיר התחלתי`
   *  within ~12 chars. The whole point of this feature is comparing
   *  the "החל מ-X" advertised price across surfaces; loan balances
   *  / down payments / extras live in unanchored text and shouldn't
   *  steal the headline. See `startingPrice` for how this drives
   *  pick order. */
  anchored: boolean;
};

/**
 * Positive marker that this number is the project's "starting from"
 * marketing price (vs. a loan balance / down payment / random other
 * figure). Matched within ~12 chars before the number.
 *
 *   "החל מ-3,199,000"       → anchored ✓
 *   "מ-2,175,000 ₪"        → anchored ✓
 *   "מחיר: 1,800,000 ₪"     → anchored ✓
 *   "מחיר התחלתי 2.5 מיליון" → anchored ✓
 *   "ע״ס כ-500,000 ₪"       → NOT anchored — anti-pattern wins
 */
const HEADLINE_ANCHOR_RE = /(?:החל\s*מ|מחיר\s*התחלתי|מחיר:?|^)\s*[-־]?\s*$/;

/**
 * Anti-anchor markers — phrases that, when they appear right before
 * an otherwise-anchored price, mean the price is a payment-plan
 * figure (down payment / first payment / equity requirement /
 * remaining balance), NOT the apartment's "starting from" price.
 *
 * Yad2 project pages often carry both — e.g. a project sells at
 * "החל מ-3,199,000" AND offers financing with "מקדמה החל מ-500,000".
 * Without this filter the lowest-anchored rule picks the smaller
 * payment-plan figure and the alert fires a false positive against
 * the website's real headline.
 *
 * Matched in the ~30 chars BEFORE the anchor regex's start. Match
 * → strip the `anchored` flag from this DetectedPrice.
 */
const ANTI_ANCHOR_RE = /(?:מקדמה|תשלום\s*ראשון|הון\s*עצמי|הלוואת\s*יזם|הלוואה|היתרה|מימון|תשלומים)/;
const ANTI_ANCHOR_WINDOW = 30;

/**
 * Invisible Unicode "format" / direction characters that real-world
 * HTML pages (Yad2, Hebrew CMSes, Google Docs paste output) sprinkle
 * between characters to control bidi rendering. Invisible to humans
 * but break the anchor regex — Yad2's `החל מ-3,199,000` actually
 * carries U+200F RLM marks between `מ`/`-` and `-`/`3`, so the literal
 * substring is `החל מ‏-‏3,199,000`, which never matches
 * `החל\s*מ\s*[-־]?\s*\d`. Strip them before extraction.
 *
 *   U+200B–U+200F  zero-width space/joiner/non-joiner + LRM/RLM
 *   U+202A–U+202E  directional embeddings/overrides + PDF
 *   U+2066–U+2069  bidi isolates (LRI/RLI/FSI/PDI)
 *   U+061C         Arabic letter mark
 *   U+FEFF         BOM / zero-width non-breaking space
 */
const BIDI_MARKS_RE = /[​-‏‪-‮⁦-⁩؜﻿]/g;

/**
 * Extract every plausible price from the given text. Order: as they
 * appear in the input (top-to-bottom for landing-page HTML). De-duped
 * by normalised value to avoid the same headline price counting twice
 * when it appears in both the `<title>` and a hero `<h1>`.
 */
export function extractPrices(text: string): DetectedPrice[] {
  if (!text) return [];
  // Strip invisible bidi marks up-front so anchor detection works on
  // bidi-decorated text like Yad2's `החל מ‏-‏3,199,000`.
  text = text.replace(BIDI_MARKS_RE, "");
  const found: DetectedPrice[] = [];
  const seen = new Set<number>();

  // Walk the text with a global regex that captures a number AND
  // optional million-suffix. We then verify a currency marker is
  // within CURRENCY_WINDOW chars on either side.
  const re = new RegExp(NUM_RE.source + "(" + MILLION_RE.source + ")?", "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const rawNum = m[1];
    const millionSuffix = m[2];
    let value = Number(rawNum.replace(/,/g, ""));
    if (!Number.isFinite(value) || value <= 0) continue;
    if (millionSuffix) value *= 1_000_000;
    if (value < MIN_PLAUSIBLE || value > MAX_PLAUSIBLE) continue;
    // Require a currency marker within window.
    const windowStart = Math.max(0, m.index - CURRENCY_WINDOW);
    const windowEnd = Math.min(text.length, re.lastIndex + CURRENCY_WINDOW);
    const ctx = text.slice(windowStart, windowEnd);
    if (!CURRENCY_RE.test(ctx)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    // Check the ~12 chars immediately before the number for a headline-
    // marketing anchor. We trim the prefix to its tail because the
    // anchor's important position is "right next to the number", not
    // somewhere within range.
    const prefixStart = Math.max(0, m.index - 12);
    const prefix = text.slice(prefixStart, m.index);
    let anchored = HEADLINE_ANCHOR_RE.test(prefix);
    // Anti-anchor pass: even if the immediate prefix looks like
    // "החל מ-", a payment-plan keyword in the broader 30-char window
    // (e.g. "מקדמה החל מ-X") flips the anchored bit back off.
    if (anchored) {
      const wide = text.slice(Math.max(0, m.index - ANTI_ANCHOR_WINDOW), m.index);
      if (ANTI_ANCHOR_RE.test(wide)) anchored = false;
    }
    found.push({
      value,
      matched: m[0].trim(),
      index: m.index,
      anchored,
    });
  }
  return found;
}

/**
 * Pick the headline "starting from" price.
 *
 *   1. If any prices are "anchored" (preceded by `החל מ-` / `מ-` /
 *      `מחיר:` etc.), the lowest of THOSE wins. This is the deliberate
 *      marketing pattern across every surface — comparing them is the
 *      whole point of the price-mismatch alert.
 *
 *   2. Otherwise fall back to the lowest absolute price.
 *
 * The 2-tier rule catches the קנקו case where the page also shows a
 * developer-loan figure ("היתרה בהלוואת יזם ע״ס כ-500,000 ₪") that's
 * cheaper than the actual apartment ("דירות 4-6 חד׳ החל מ-3,199,000 ₪")
 * — the anchored ₪3.2M wins over the unanchored ₪500k.
 *
 * Returns null when no plausible price was found.
 */
export function startingPrice(text: string): DetectedPrice | null {
  const all = extractPrices(text);
  if (all.length === 0) return null;
  const anchored = all.filter((p) => p.anchored);
  const pool = anchored.length > 0 ? anchored : all;
  return pool.reduce((min, p) => (p.value < min.value ? p : min));
}

/**
 * Pre-clean HTML for extraction: strip <script> / <style> blocks +
 * collapse all HTML tags to spaces so number-currency adjacency in
 * the visible text isn't broken by tag boundaries. NOT a real DOM
 * parser — we don't need one; we just want the visible price text
 * to be reachable by the regex.
 */
export function htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ");
}

/**
 * Compare prices across multiple surfaces. Used by the price-mismatch
 * alert. Returns null when fewer than 2 surfaces have a detected price
 * (need at least 2 to disagree) — caller should treat that as "no
 * signal" rather than "agreement".
 *
 *   tolerancePct: how far apart prices can drift before being flagged
 *                 as mismatched. Default 1% — anything beyond is
 *                 considered a real discrepancy (a typo correcting
 *                 ₪2,499,000 → ₪2,500,000 stays under).
 */
export function comparePrices(
  surfaces: { name: string; price: number | null }[],
  opts: { tolerancePct?: number } = {},
): {
  mismatched: boolean;
  reason: string;
  surfaces: { name: string; price: number | null }[];
} | null {
  const tol = opts.tolerancePct ?? 1;
  const withPrice = surfaces.filter(
    (s): s is { name: string; price: number } => s.price !== null,
  );
  if (withPrice.length < 2) return null;
  const min = Math.min(...withPrice.map((s) => s.price));
  const max = Math.max(...withPrice.map((s) => s.price));
  const driftPct = ((max - min) / min) * 100;
  const mismatched = driftPct > tol;
  return {
    mismatched,
    reason: mismatched
      ? `מינ׳ ${fmt(min)} · מקס׳ ${fmt(max)} · פער ${driftPct.toFixed(1)}%`
      : `כל המקורות מסכימים על ~${fmt(min)}`,
    surfaces,
  };
}

function fmt(n: number): string {
  return "₪" + Math.round(n).toLocaleString("he-IL");
}
