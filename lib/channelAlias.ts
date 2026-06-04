/**
 * Normalize a raw channel name to a benchmark "family" so per-channel
 * benchmarks roll up across spelling variants (google-search, Google-
 * Search, google_search, גוגל-search etc. all land in the same bucket).
 *
 * Byte-identical to client-dashboard/Index.html:3739 — both the
 * dashboard's client-side diagnosis and the hub's stats page diagnosis
 * MUST classify the same way or the same project will see different
 * "ערוץ יקר" verdicts in each surface.
 */
export function channelAlias(name: string): string {
  const n = String(name || "").toLowerCase().trim();
  // Discovery — three variants now caught here:
  //   1. Hebrew גוגל prefix ("גוגל דיסקאברי") — was English-only
  //   2. Standalone "discover" / "discovery" tokens — the sheet often
  //      omits the "google" prefix entirely and just says "discover".
  //      Anchored to the START so a hypothetical "outbrain-discover"
  //      still routes to outbrain (handled in the outbrain branch).
  //   3. Common "dicovery" typo
  // Owner pulled standalone discovery labels in here 2026-06-05.
  if (
    /(google|גוגל).*(discover|דיסקובר|דיסקאברי)/.test(n) ||
    /^(discover|discovery|dicovery)([-_\s]|$)/.test(n)
  )
    return "google-discovery";
  // DV360 (Display & Video 360) — own bucket. Distinct platform from
  // Google Ads (display+video buying tool), so its CPL distribution
  // shouldn't pollute search/PMax benchmarks. Catches "DV360" /
  // "dv360" / "dv 360" / "dv-360" / standalone "dv". Owner asked for
  // this separation 2026-06-05.
  if (/\bdv[\s-]?360\b|\bdv\b/.test(n)) return "dv360";
  // google-other: now PMax-only. Checked BEFORE the broad google-search
  // catch-all so "Google-pmax" doesn't get pulled into search.
  if (/\bpmax\b/.test(n) || /^pmax([-_\s]|$)/.test(n))
    return "google-other";
  // YouTube — its own bucket. Owner asked 2026-06-05. Catches the
  // standalone "youtube" token plus the project-suffix "_yt" / "-yt"
  // pattern (e.g. "large_apatments_yt"). Placed BEFORE google-search
  // so YouTube doesn't fall into the broad google catch-all below.
  if (/\byoutube\b|(?:^|[-_\s])yt(?:[-_\s]|$)/.test(n)) return "youtube";
  // google-search: anything else Google-flavored. Owner decision
  // 2026-06-05 — the team's "google" / "גוגל" rows are universally
  // search campaigns in practice. The broad `/google/` catch at the end
  // handles project-suffix labels (e.g. "ampa-givat-shmuel-google").
  if (
    /google.*(search|seach|serach|חיפוש)|google_search|^gs([-_\s]|$)/.test(n) ||
    /^(google|גוגל|goolge)([-_\s]|$)/.test(n) ||
    /גוגל/.test(n) ||
    /google/.test(n)
  )
    return "google-search";
  if (/facebook.*lead.*generation|facebook-lead/.test(n))
    return "facebook-lead-gen";
  // Facebook — also catches the standalone "meta" token (the company's
  // current platform name) so labels like "large_apatments_meta" land
  // here instead of falling to (other). Owner asked 2026-06-05.
  if (/facebook|פייסבוק|(^|[-_\s])(fb|meta)([-_\s]|$)/.test(n))
    return "facebook-other";
  if (/yad\s?2|יד\s?2/.test(n)) return "yad2";
  if (/madlan|מדלן/.test(n)) return "madlan";
  if (/onmap|אונמפ/.test(n)) return "onmap";
  // Outbrain — also catches Teads (rebrand/alias of Outbrain per the
  // owner's note in lib/budgetTypes.ts:46) and the Hebrew variants,
  // matching how the budget-side classifyChannel does it.
  if (/outbrain|אאוטבריין|אאוטברין|teads|טידס/.test(n)) return "outbrain";
  if (/taboola/.test(n)) return "taboola";
  if (/tiktok|טיקטוק/.test(n)) return "tiktok";
  if (/instagram|אינסטגרם/.test(n)) return "instagram";
  if (/פניה|פנייה|טלפו[נן]|פ\./.test(n) || /כוכבית/.test(n))
    return "phone-lead";
  if (/nadlan|נדלן/.test(n)) return "nadlan";
  if (/ynet|walla|mako|calcalist|globes|גלובס|jerusalempost|ashdodnet/.test(n))
    return "news";
  if (/article|כתבה/.test(n)) return "article";
  if (/minisite|מיני-?סייט/.test(n)) return "minisite";
  if (/site|אתר|website|אינטרנט/.test(n)) return "site";
  return "(other)";
}
