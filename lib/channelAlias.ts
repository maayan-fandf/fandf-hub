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
  if (/google.*(discover|דיסקובר|דיסקאברי)/.test(n)) return "google-discovery";
  if (/google.*(search|חיפוש)|google_search/.test(n)) return "google-search";
  if (
    /^(google|גוגל|goolge|pmax|dv360|gs)([-_\s]|$)/.test(n) ||
    /גוגל/.test(n) ||
    /^google/.test(n)
  )
    return "google-other";
  if (/facebook.*lead.*generation|facebook-lead/.test(n))
    return "facebook-lead-gen";
  if (/facebook|פייסבוק|(^|[-_\s])fb([-_\s]|$)/.test(n))
    return "facebook-other";
  if (/yad\s?2|יד\s?2/.test(n)) return "yad2";
  if (/madlan|מדלן/.test(n)) return "madlan";
  if (/onmap|אונמפ/.test(n)) return "onmap";
  if (/outbrain/.test(n)) return "outbrain";
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
