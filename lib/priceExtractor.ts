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
};

/**
 * Extract every plausible price from the given text. Order: as they
 * appear in the input (top-to-bottom for landing-page HTML). De-duped
 * by normalised value to avoid the same headline price counting twice
 * when it appears in both the `<title>` and a hero `<h1>`.
 */
export function extractPrices(text: string): DetectedPrice[] {
  if (!text) return [];
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
    found.push({
      value,
      matched: m[0].trim(),
      index: m.index,
    });
  }
  return found;
}

/**
 * Pick the headline "starting from" price — the lowest detected price.
 * Returns null when no plausible price was found.
 */
export function startingPrice(text: string): DetectedPrice | null {
  const all = extractPrices(text);
  if (all.length === 0) return null;
  return all.reduce((min, p) => (p.value < min.value ? p : min));
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
