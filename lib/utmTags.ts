/**
 * UTM tags, read the way the platform that wrote them meant them.
 *
 * The same five parameters carry DIFFERENT things per source, and labelling
 * them generically ("term", "content") makes a Google keyword and a Facebook
 * audience look like the same fact. Observed in the warehouse:
 *
 *   gs      utm_term    = the search keyword   ("פרשקובסקי אשדוד")
 *           utm_content = the numeric ad id    ("780764450290")
 *           utm_medium  = "cpc"                (carries nothing)
 *   fb      utm_term    = the audience code    ("RM" = remarketing)
 *           utm_content = the creative code    ("2026-03-25B")
 *           utm_medium  = the placement        ("Facebook_Mobile_Feed")
 *
 * So the labels are chosen per platform. This mirrors the aggregate
 * breakdowns in lib/crmData.ts (audience=utm_term, creative=utm_content)
 * rather than inventing a second vocabulary for the same columns.
 */

export type UtmTag = {
  /** Hebrew label for what this value IS on this platform. */
  label: string;
  value: string;
  /** Which utm_* column it came from — shown on hover so the reader can go
   *  back to the source parameter without guessing. */
  param: string;
  /** The tag fired but never got substituted. Shown, not hidden: a silent
   *  drop reads as "no campaign", when the truth is "tagging is broken
   *  here" — a different problem with a different owner. */
  broken?: boolean;
  /** Why it is broken: "placeholder" (never substituted) or "truncated"
   *  (arrived cut off). Drives the tooltip wording. */
  brokenKind?: "placeholder" | "truncated";
};

/** Values that are a tag failure rather than a value.
 *
 *  `{campaigned}` is Google ValueTrack that never resolved — 441 of 1,627
 *  leads carry it, concentrated in a handful of accounts. The others are a
 *  parameter left at its own name: one Taboola row reads
 *  utm_campaign="camapign", utm_content="content" — a template someone
 *  pasted and never filled in (the misspelling is theirs). */
const PLACEHOLDER = new Set([
  "campaign",
  "camapign",
  "content",
  "term",
  "medium",
  "source",
  "keyword",
  "adset",
  "ad",
  "n/a",
  "na",
  "null",
  "undefined",
]);

/**
 * A value that arrived cut off rather than wrong.
 *
 * gindi-muman.co.il writes utm_medium="Fa" and "In" — the first two
 * characters of Facebook_/Instagram_ placements. Compare אפרידר on the same
 * CRM, which sends the whole "Facebook_Mobile_Feed": the field is not
 * short by design, that site truncates it. Two characters cannot identify a
 * placement, so this is flagged like any other broken tag instead of being
 * printed as if it were one.
 *
 * Deliberately narrow — only a short value that PREFIXES the platform it
 * came in on. "cpc" and "RM" are short and meaningful, and neither
 * prefixes a platform name, so neither is caught.
 */
const PLATFORM_WORDS = [
  "facebook",
  "instagram",
  "google",
  "youtube",
  "messenger",
  "audience",
  "taboola",
  "outbrain",
];
function isTruncated(v: string): boolean {
  if (v.length < 2 || v.length > 4) return false;
  const lc = v.toLowerCase();
  return PLATFORM_WORDS.some((w) => w.startsWith(lc));
}

function isBroken(v: string): boolean {
  // {campaigned}, {{ad.name}}, {adgroupid} — anything still in its braces.
  if (/^\{+.*\}+$/.test(v)) return true;
  return PLACEHOLDER.has(v.toLowerCase());
}

/** The warehouse stores these with the surrounding spaces the landing URL
 *  had (" פרס אשדוד ") — comparing or displaying them untrimmed splits one
 *  keyword into two. */
function clean(v: unknown): string {
  return String(v ?? "").trim();
}

export type UtmSourceRow = {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  /** BMBY has no utm_source; it resolves the platform itself into
   *  channel_key (gs / fb / taboola / …). */
  channel_key?: string | null;
};

/** gs, google, google-search → google. fb, facebook, ig → facebook. */
function platformOf(row: UtmSourceRow): "google" | "facebook" | "other" {
  const s = `${clean(row.channel_key)} ${clean(row.utm_source)}`.toLowerCase();
  if (/\bgs\b|google|adwords|gdn|pmax|demand/.test(s)) return "google";
  if (/\bfb\b|facebook|meta|instagram|\big\b/.test(s)) return "facebook";
  return "other";
}

/** Human name for the platform chip itself. Falls back to whatever the CRM
 *  wrote, so a source we have not met yet still shows up by name. */
function platformLabel(row: UtmSourceRow): string {
  const p = platformOf(row);
  if (p === "google") return "Google";
  if (p === "facebook") return "Facebook";
  return clean(row.utm_source) || clean(row.channel_key);
}

/**
 * One lead's UTMs as labelled tags, in the order that answers "where did
 * this client come from" — platform, then campaign, then the narrowing
 * dimensions. Empty values are dropped; broken ones are kept and flagged.
 */
export function describeUtms(
  row: UtmSourceRow,
  /** Google campaign id → name, from lib/googleCampaignNames. Optional:
   *  without it the id is shown as-is rather than nothing. */
  campaignNames?: Record<string, string>,
): UtmTag[] {
  const p = platformOf(row);
  const out: UtmTag[] = [];
  const push = (label: string, param: string, raw: unknown, opts?: {
    /** Allow the truncation check — only meaningful on placement-ish
     *  fields, never on a keyword, which may legitimately be short. */
    truncatable?: boolean;
    /** A resolved name to show in place of the raw id. */
    display?: string;
  }) => {
    const value = clean(raw);
    if (!value) return;
    const placeholder = isBroken(value);
    const truncated = !placeholder && !!opts?.truncatable && isTruncated(value);
    out.push({
      label,
      value: clean(opts?.display) || value,
      param,
      broken: placeholder || truncated || undefined,
      brokenKind: placeholder ? "placeholder" : truncated ? "truncated" : undefined,
    });
  };

  const plat = platformLabel(row);
  if (plat) {
    out.push({ label: "פלטפורמה", value: plat, param: "utm_source" });
  }
  // Google writes the campaign's numeric id, not its name. The hub already
  // keeps an id→name map for the "קמפיין ID גוגל" tab, so a caller that has
  // it can hand it in and the tag reads as a campaign instead of a number.
  const campRaw = clean(row.utm_campaign);
  const campName = campRaw ? campaignNames?.[campRaw] : undefined;
  push("קמפיין", "utm_campaign", row.utm_campaign, { display: campName });

  if (p === "google") {
    push("מילת מפתח", "utm_term", row.utm_term);
    push("מזהה מודעה", "utm_content", row.utm_content);
    // "cpc" on every Google row — true, and it distinguishes nothing.
    if (clean(row.utm_medium).toLowerCase() !== "cpc") {
      push("מדיום", "utm_medium", row.utm_medium);
    }
  } else if (p === "facebook") {
    push("מיקום", "utm_medium", row.utm_medium, { truncatable: true });
    push("קריאייטיב", "utm_content", row.utm_content);
    push("קהל", "utm_term", row.utm_term);
  } else {
    push("מדיום", "utm_medium", row.utm_medium, { truncatable: true });
    push("תוכן", "utm_content", row.utm_content);
    push("מונח", "utm_term", row.utm_term);
  }
  return out;
}

/** Stable identity for one tag set, so a client with five leads off the same
 *  ad shows that ad once instead of five times. */
export function utmKey(row: UtmSourceRow): string {
  return [
    row.channel_key,
    row.utm_source,
    row.utm_medium,
    row.utm_campaign,
    row.utm_content,
    row.utm_term,
  ]
    .map((v) => clean(v).toLowerCase())
    .join("|");
}

/** True when the row carries nothing beyond a platform — an untagged lead.
 *  Worth knowing: it is the difference between "organic" and "we lost it". */
export function hasRealUtms(row: UtmSourceRow): boolean {
  return [row.utm_medium, row.utm_campaign, row.utm_content, row.utm_term].some(
    (v) => {
      const s = clean(v);
      return !!s && !isBroken(s);
    },
  );
}
