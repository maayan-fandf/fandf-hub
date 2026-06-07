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
  /** Apartment room count, when detectable in the ~120-char window
   *  before the price. Single integer when the page labels this
   *  price unambiguously (e.g., "4 חד׳ 116 מ״ר ... החל מ-3,110,000"
   *  → rooms=4; Yad2 sponsored "חדרים: 3 ... החל מ- 3,320,000" →
   *  rooms=3). Null when the page only shows a range ("דירות 3-5
   *  חד׳ ופנטהאוזים יוקרתיים החל מ-X" → rooms=null, but
   *  `roomsLabel="3-5 חד׳"` captures the raw substring for display)
   *  or when no room marker is in the window. */
  rooms?: number | null;
  /** Raw room/apartment-type label for display — preferred over `rooms`
   *  for the UI because it carries ranges ("3-5 חד׳"), penthouse
   *  prefixes ("פנטהאוז · 5 חד׳"), and other natural-language tags
   *  the page used. Empty string when no marker was detected. */
  roomsLabel?: string;
  /** Where the room label came from. Used during value-dedup so a
   *  table-form match (most structured) can override a single-int
   *  match that grabbed a digit out of a comma list. Optional —
   *  consumers that don't care can ignore. */
  roomSource?: "table" | "single" | "range" | "list" | "none";
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
 *
 * Dash class accepts the whole Unicode dash family — Yad2 sponsored
 * pages render the headline as `החל מ – 3,320,000` (U+2013 en dash)
 * while the per-apartment-type table below renders `החל מ- 3,320,000`
 * (U+002D hyphen-minus). Before this fix the regex matched the second
 * one only; the FIRST (the actual marketing headline) was lost as
 * "unanchored", which combined with the value-dedup in extractPrices
 * meant the real headline price never reached the anchored bucket.
 * Members: hyphen-minus, Hebrew makaf, Unicode hyphen, non-breaking
 * hyphen, en dash, em dash, minus sign.
 */
const HEADLINE_ANCHOR_RE =
  /(?:החל\s*מ|מחיר\s*התחלתי|מחיר:?|^)\s*[-־‐‑–—−]?\s*$/;

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
 * Room-label proximity matching — given a price's char offset, look back
 * ~120 chars and try to find the apartment-type marker that labels THIS
 * price. Returns the marker CLOSEST to the price (highest index in the
 * back window) so that, when a page mixes a wide headline range with a
 * specific per-apartment table, the table row "wins" for the price it
 * directly precedes. Patterns supported:
 *
 *   - Yad2 sponsored table  → "חדרים: 3 שטח: 80 מ״ר … החל מ- 3,320,000"
 *   - Landing hero block    → "4 חד׳ 116 מ״ר + 10 מ״ר מרפסת החל מ-3,110,000"
 *   - Marketing range copy  → "3-5 חד׳ ופנטהאוזים … החל מ-3,320,000"
 *                             (label kept verbatim, `rooms` left null)
 *
 * Penthouse / unique-type keywords in the same window decorate the
 * label as "פנטהאוז · X חד׳" so the UI can flag the row visually.
 *
 * Empty-result fallback: when nothing matches, returns
 * `{ rooms: null, roomsLabel: "" }` — the price still gets extracted,
 * just without a label.
 */
const ROOMS_BACK_WINDOW = 120;
/** When a TABLE-form room marker matched (Yad2 sponsored "חדרים: N"),
 *  look this far back from its position for an apartment-type keyword
 *  to attach as a decoration. Yad2 lays the table out as "<type>
 *  חדרים: N שטח: …" — type is the word right before "חדרים:". A
 *  generous 20 chars covers "גג/פנטהאוז " (10) plus a synonym. */
const PENTHOUSE_BEFORE_TABLE = 20;
const ROOMS_TABLE_RE = /חדרים\s*:\s*(\d+)/g;
const ROOMS_RANGE_RE = /(\d+)\s*[-–—־]\s*(\d+)\s*חד['׳ר]?/g;
/** Comma-list pattern — "3,4,5 חד׳" / "3, 4, 5 חד'" / similar with
 *  Arabic comma (U+060C). Treat as a multi-value LIST: the marker
 *  spans the whole pattern and shouldn't be interpreted as a single
 *  "5 חד'" tag for any specific price. Yad2 marketing headlines
 *  routinely use this: "דירות 3,4,5 חד' ופנטהאוזים החל מ-2,420,000"
 *  where ₪2.42M is the 3-room (not 5-room) starting price. */
const ROOMS_LIST_RE = /(\d+(?:\s*[,،]\s*\d+){1,})\s*חד['׳ר]?/g;
const ROOMS_SINGLE_RE = /(?<!\d)(\d+)\s*חד['׳ר]?/g;
const PENTHOUSE_KW_RE = /(?:פנטהאוז|דופלקס|גג\s*דירה|מיני\s*פנט|גג\b)/;

function findRoomLabel(
  text: string,
  priceIdx: number,
): {
  rooms: number | null;
  roomsLabel: string;
  /** Provenance of the label — drives dedup priority when the same
   *  value reappears with a different label kind. Table form (Yad2
   *  sponsored "חדרים: N") beats single form (which can pick up
   *  digits from comma lists or marketing copy). */
  source: "table" | "single" | "range" | "list" | "none";
} {
  const start = Math.max(0, priceIdx - ROOMS_BACK_WINDOW);
  const window = text.slice(start, priceIdx);
  let bestIdx = -1;
  let rooms: number | null = null;
  let label = "";
  let bestSource: "range" | "table" | "single" | null = null;
  // Position in the FULL text (not the window) where the chosen
  // table-form match starts — used to anchor the penthouse-prefix
  // check to the apartment-type cell, not random text upstream.
  let bestTablePriceAbsIdx = -1;

  // Range pass first — remember each range's char span so we can
  // suppress the bare-int matches inside it. Without this, "5 חד'"
  // inside "3-5 חד'" gets picked up by ROOMS_SINGLE_RE as a stronger
  // closer-to-price match, and the headline ends up labeled "5 חד'"
  // instead of the proper "3-5 חד׳" range.
  const exclusionSpans: Array<{ start: number; end: number }> = [];
  {
    const re = new RegExp(ROOMS_RANGE_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(window)) !== null) {
      exclusionSpans.push({ start: m.index, end: re.lastIndex });
      if (m.index >= bestIdx) {
        bestIdx = m.index;
        rooms = null;
        label = `${m[1]}-${m[2]} חד׳`;
        bestSource = "range";
      }
    }
  }
  // Comma-list pass — same idea: remember the span so the single
  // pass below skips "5" inside "3,4,5 חד'". Stores the literal as
  // the label when this becomes the best match.
  {
    const re = new RegExp(ROOMS_LIST_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(window)) !== null) {
      exclusionSpans.push({ start: m.index, end: re.lastIndex });
      if (m.index >= bestIdx) {
        bestIdx = m.index;
        rooms = null;
        label = `${m[1].replace(/\s*,\s*/g, ",")} חד׳`;
        bestSource = "list";
      }
    }
  }
  const insideAnyExcluded = (idx: number) =>
    exclusionSpans.some((s) => idx >= s.start && idx < s.end);

  // Table form — Yad2 sponsored "חדרים: N". Most authoritative
  // because it's a per-apartment-type tag in a structured table row.
  {
    const re = new RegExp(ROOMS_TABLE_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(window)) !== null) {
      if (m.index < bestIdx) continue;
      bestIdx = m.index;
      rooms = Number(m[1]);
      label = `${m[1]} חד׳`;
      bestSource = "table";
      bestTablePriceAbsIdx = start + m.index;
    }
  }

  // Single int form — "4 חד'" / "5 חדר" / "6 חדרים". Skip anything
  // sitting inside a range OR comma-list span (the broader pattern
  // already labeled that text more meaningfully).
  {
    const re = new RegExp(ROOMS_SINGLE_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(window)) !== null) {
      if (insideAnyExcluded(m.index)) continue;
      if (m.index < bestIdx) continue;
      bestIdx = m.index;
      rooms = Number(m[1]);
      label = `${m[1]} חד׳`;
      bestSource = "single";
    }
  }

  // Penthouse decoration — only applied when the table form won AND
  // the apartment-type keyword sits immediately before "חדרים:" (the
  // Yad2 sponsored table cell layout: "גג/פנטהאוז חדרים: 5 …").
  // Marketing narrative pages mention פנטהאוז in nearby copy but
  // not in this strict "<type-word> חדרים:" structure, so this rule
  // cleanly rejects the headline-range false positive.
  if (bestSource === "table" && bestTablePriceAbsIdx >= 0) {
    const tagWindow = text.slice(
      Math.max(0, bestTablePriceAbsIdx - PENTHOUSE_BEFORE_TABLE),
      bestTablePriceAbsIdx,
    );
    if (PENTHOUSE_KW_RE.test(tagWindow)) {
      label = label ? `פנטהאוז · ${label}` : "פנטהאוז";
    }
  }
  return {
    rooms,
    roomsLabel: label,
    source: bestSource ?? "none",
  };
}

/** Specificity score for a room label — used during dedup promotion to
 *  prefer a structured label over an ambiguous one when the same value
 *  reappears with a cleaner tag.
 *
 *   table  = 4  (Yad2 sponsored "חדרים: N" — most structured)
 *   single = 3  (bare "N חד'", as in landing hero blocks)
 *   range  = 2  ("3-5 חד'", "3,4,5 חד'" — multi-value marker)
 *   list   = 2  (same as range, just comma-separated)
 *   none w/ label = 1
 *   nothing = 0
 *
 * Cases this resolves:
 *   - Yad2 headline "3-5 חד׳" → table row "חדרים: 3" : table beats range
 *   - אנדה headline "3,4,5 חד'" → table row "חדרים: 3" : table beats list
 *   - אנדה headline "3,4,5 חד' החל מ-X" : list label beats nothing
 *     so the user sees "3,4,5 חד'" instead of just the value */
function roomLabelScore(
  rooms: number | null,
  label: string,
  source: "table" | "single" | "range" | "list" | "none" = "none",
): number {
  if (source === "table") return 4;
  if (source === "single" && rooms != null) return 3;
  if (source === "range" || source === "list") return 2;
  if (rooms != null) return 3; // legacy callers without source
  if (label) return 1;
  return 0;
}

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
  // value → index in `found`. Lets a later occurrence UPGRADE the
  // stored entry's `anchored` flag without changing iteration order —
  // important because Yad2 sponsored pages render the marketing
  // headline `החל מ – 3,320,000` (en dash, easy to miss as an anchor)
  // BEFORE the per-apartment-type table where the same `3,320,000`
  // reappears with a clean hyphen anchor `החל מ- 3,320,000`. The old
  // logic dropped the second occurrence entirely; we'd then pick the
  // 4-room (3,930,000) as "lowest anchored" because 3,320,000 was
  // mis-classified as unanchored. The fix is symmetric: any later
  // occurrence with a stronger anchor promotes the earlier entry.
  const byValue = new Map<number, number>();

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
    const { rooms, roomsLabel, source } = findRoomLabel(text, m.index);
    const existingIdx = byValue.get(value);
    if (existingIdx !== undefined) {
      // Same value seen earlier. If THIS occurrence is anchored and
      // the stored one wasn't, promote the stored entry. Likewise for
      // the room label — a later occurrence with a STRUCTURALLY
      // STRONGER source (table beats single beats range/list) overrides
      // the earlier sighting. Matches the Yad2 sponsored-page reality
      // where the marketing headline shows "3,4,5 חד׳" (list) but the
      // per-apartment table beneath repeats the same price with
      // "חדרים: 3" (table) — אנדה case 2026-06-07: ₪2.42M was
      // mislabeled as "5 חד'" because ROOMS_SINGLE_RE grabbed the
      // trailing "5" from the comma list and equal-score dedup
      // ignored the cleaner table form. We leave index/matched on
      // the first occurrence so debug output still points at where
      // we first saw the price in the page.
      const cur = found[existingIdx];
      const next = { ...cur };
      if (anchored && !cur.anchored) next.anchored = true;
      if (
        roomLabelScore(rooms, roomsLabel, source) >
        roomLabelScore(
          cur.rooms ?? null,
          cur.roomsLabel ?? "",
          cur.roomSource ?? "none",
        )
      ) {
        next.rooms = rooms;
        next.roomsLabel = roomsLabel;
        next.roomSource = source;
      }
      found[existingIdx] = next;
      continue;
    }
    byValue.set(value, found.length);
    found.push({
      value,
      matched: m[0].trim(),
      index: m.index,
      anchored,
      rooms,
      roomsLabel,
      roomSource: source,
    });
  }
  return found;
}

/**
 * Yad2 page-type classification — drives whether `startingPrice` trusts
 * the page enough to emit a value. Two real-world shapes:
 *
 *   - SPONSORED — a developer-paid project page on Yad2's "yad1"
 *     vertical (the same kind of marketing experience as a landing
 *     page). Carries `החל מ-X` anchors as headline copy. Comparable
 *     to the landing / FB / Google surfaces because it advertises
 *     the same "starting from" number.
 *
 *   - ORGANIC — an aggregated project listing without a developer-
 *     curated headline. Renders as a per-apartment-type price table
 *     (3 חד׳ ₪X, 4 חד׳ ₪Y, …). The smallest row is structurally "the
 *     cheapest apartment type", NOT the project's headline price —
 *     it's the wrong thing to compare against a landing-page
 *     "starting from" anchor (kazar: organic Yad2 surfaced ₪2.65M
 *     while the landing page advertises ₪3.29M; comparing them
 *     produces a false drift signal).
 *
 *   - UNKNOWN — we couldn't tell (e.g. zero plausible prices).
 *
 * The detection rule: presence of any anchored price → sponsored;
 * absence → organic. It's a heuristic but maps cleanly to how the
 * two page types differ visually + structurally.
 */
export type Yad2PageType = "sponsored" | "organic" | "unknown";

export function classifyYad2Page(text: string): Yad2PageType {
  const prices = extractPrices(text);
  if (prices.length === 0) return "unknown";
  return prices.some((p) => p.anchored) ? "sponsored" : "organic";
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
 * Yad2 hint (`opts.surface === "yad2"`): the fallback to "lowest
 * absolute" is DISABLED. If no anchored price is found, returns null
 * (caller should treat as "no usable price"). Reason: organic Yad2
 * listing pages have no headline anchor; the lowest-absolute pick
 * is the smallest apartment type in a price table, not a comparable
 * "starting from" headline. See classifyYad2Page() doc above.
 *
 * Returns null when no plausible (or comparable, for Yad2) price was
 * found.
 */
export function startingPrice(
  text: string,
  opts: { surface?: "landing" | "yad2" } = {},
): DetectedPrice | null {
  const all = extractPrices(text);
  if (all.length === 0) return null;
  const anchored = all.filter((p) => p.anchored);
  if (anchored.length === 0) {
    // Yad2 organic-page guard — see fn doc + classifyYad2Page() above.
    if (opts.surface === "yad2") return null;
    return all.reduce((min, p) => (p.value < min.value ? p : min));
  }
  return anchored.reduce((min, p) => (p.value < min.value ? p : min));
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
