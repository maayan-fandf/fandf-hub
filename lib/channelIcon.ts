/**
 * Map a free-form media-channel string (Hebrew or English) to a single
 * emoji icon. Port of the dashboard's `channelIcon` (dashboard-clasp/
 * Index.html ~line 6758) so the CRM card's source legend can match the
 * dashboard's visual language.
 *
 * Returns just the emoji (no prefixed bullet, no trailing label) — the
 * caller composes "emoji + label" however it likes. Empty / dash input
 * returns an empty string so the caller can fall back to a generic dot.
 */
export function channelIcon(name: string): string {
  const n = String(name || "").toLowerCase().trim();
  if (!n || n === "—") return "";
  for (const r of RULES) {
    if (r.test.test(n)) return r.icon;
  }
  return "";
}

/**
 * The platform key for channels that have a real brand mark, or "" for
 * everything else.
 *
 * Runs the SAME rule list as `channelIcon` so the two can never disagree
 * about what a string is — a channel that resolves to 📘 here resolves
 * to Facebook, always. Channels with no brand (שילוט, פניה טלפונית, קשר
 * אישי…) return "" and keep their emoji.
 *
 * כתבה used to be in that list on the grounds that there is no Article
 * Inc. logo to show. There is: every article the agency buys runs on i11
 * NEWS, so the row now wears the outlet's mark like any other platform.
 *
 * Consumed by components/ChannelIcon.tsx. `channelIcon` itself is left
 * alone because several call sites interpolate it into a `title=`
 * string, where a React element cannot go.
 */
export function channelPlatform(name: string): string {
  const n = String(name || "").toLowerCase().trim();
  if (!n || n === "—") return "";
  for (const r of RULES) {
    if (r.test.test(n)) return r.platform ?? "";
  }
  return "";
}

/**
 * The channel BUCKET a free-form string belongs to — the third projection
 * of the same rule list, alongside the emoji and the brand key.
 *
 * The vocabulary is BMBY's: the warehouse resolves its own touch chain into
 * `first_lid_channel` / `last_lid_channel` with values like `fb`, `gs`,
 * `discovery`, `article`, `phone`, `minisite`. Sehel has no such view — its
 * touches carry the salesperson's raw string ("פייסבוק - ויזלמרקטינג",
 * "Article-march", "facebook-leadgen", "אתר קאזר"), 60 distinct values of
 * them — so מקור מול טריגר has to bucket them here to compare the two
 * columns at all. Sharing this list rather than writing a second one is the
 * point: a string that shows Facebook's logo in the ערוצים table cannot
 * quietly land in a different bucket on the journey card.
 *
 * Returns "other" when nothing matches, which is the honest bucket for a
 * developer's own name or a one-off campaign code — 11 of Sehel's 60
 * values, and 1.1% of its lead events.
 */
export function channelSlug(name: string): string {
  const n = String(name || "").toLowerCase().trim();
  if (!n || n === "—") return "other";
  for (const r of RULES) {
    if (r.test.test(n)) return r.slug ?? "other";
  }
  return "other";
}

const RULES: { test: RegExp; icon: string; platform?: string; slug?: string }[] = [
  { test: /(?:^|[-_\s])(?:google|גוגל)[\s\-_].*(?:discover|דיסקובר|דיסקאברי)/, icon: "🌐", platform: "google", slug: "discovery" },
  { test: /(?:^|[-_\s])(?:google|גוגל).*(?:search|חיפוש|seach)/, icon: "🔍", platform: "google", slug: "gs" },
  { test: /(?:^|[-_\s])(?:google|גוגל|goolge|pmax|dv360|gs)(?:$|[-_\s])/, icon: "🔍", platform: "google", slug: "gs" },
  { test: /(?:^|[-_\s])(?:google|גוגל)/, icon: "🔍", platform: "google", slug: "gs" },
  { test: /(?:^|[-_\s])(?:facebook|פייסבוק|fb|meta|מטא)(?:$|[-_\s])/, icon: "📘", platform: "facebook", slug: "fb" },
  { test: /(?:^|[-_\s])(?:instagram|אינסטגרם|ig)(?:$|[-_\s])/, icon: "📸", platform: "instagram", slug: "social" },
  { test: /(?:^|[-_\s])(?:tiktok|טיקטוק)/, icon: "🎵", platform: "tiktok", slug: "social" },
  { test: /(?:^|[-_\s])(?:youtube|יוטיוב|yt)(?:$|[-_\s])/, icon: "▶️", slug: "social" },
  { test: /(?:^|[-_\s])(?:linkedin|לינקדאין)/, icon: "💼", slug: "social" },
  { test: /(?:^|[-_\s])(?:twitter)(?:$|[-_\s])|^x$/, icon: "🐦", slug: "social" },
  { test: /(?:^|[-_\s])(?:yad\s?2|יד\s?2)(?:$|[-_\s])/, icon: "🏠", platform: "yad2", slug: "yad2" },
  { test: /(?:^|[-_\s])(?:madlan|מדלן)(?:$|[-_\s])|(?:^|[-_\s])nadlan(?:\.|[-_\s])|(?:^|[-_\s])(?:נדלן)(?:$|[-_\s])/, icon: "🏘️", slug: "madlan" },
  { test: /(?:^|[-_\s])(?:onmap|אונמפ)(?:$|[-_\s])/, icon: "🗺️", slug: "other" },
  { test: /(?:^|[-_\s])(?:outbrain|אאוטבריין)/, icon: "📰", platform: "outbrain", slug: "outbrain" },
  { test: /(?:^|[-_\s])(?:taboola|טאבולה)/, icon: "📰", platform: "taboola", slug: "taboola" },
  /* i11 NEWS publishes every כתבה in this portfolio — the Keys "בנפיט"
     lookup points at i11.co.il for all of them — so it gets its own mark
     while the rest of the press list keeps the generic 📰. Listed BEFORE
     the general rule, which also matches `i11` via its `i1[123]` branch. */
  { test: /(?:^|[-_\s])i11(?:$|[-_\s.])|i11\.co\.il/, icon: "📰", platform: "i11", slug: "article" },
  { test: /(?:^|[-_\s])(?:ynet|walla|mako|calcalist|globes|גלובס|haaretz|הארץ|jerusalempost|ashdodnet|n1[123]|i1[123])/, icon: "📰", slug: "article" },
  { test: /(?:^|[-_\s])(?:כתבה|article)/, icon: "📄", platform: "i11", slug: "article" },
  /* F&F name their Google Demand Gen campaigns `…-discovery` with no
     `google` token, so this rule carries the platform key too. */
  { test: /(?:^|[-_\s])dis?c?over/, icon: "🧭", platform: "google", slug: "discovery" },
  { test: /(?:^|[-_\s])(?:פניה|פנייה|טלפו[נן]|כוכבית|phone|call)|(?:^|[-_\s])פ\.\s?(?:טלפ|פניה)/, icon: "📞", slug: "phone" },
  { test: /(?:^|[-_\s])(?:שילוט|שלטי|חוצות|billboard)/, icon: "🪧", slug: "billboard" },
  { test: /(?:^|[-_\s])(?:דיוור|mail)/, icon: "✉️", slug: "mail" },
  { test: /(?:^|[-_\s])(?:whatsapp|וואטסאפ|ווטסאפ)/, icon: "💬", slug: "whatsapp" },
  { test: /(?:^|[-_\s])sms(?:$|[-_\s])/, icon: "💬", slug: "whatsapp" },
  { test: /minisite|מיני-?סייט/, icon: "🪟", slug: "minisite" },
  { test: /(?:^|[-_\s])(?:site|website|אתר|אינטרנט)(?:$|[-_\s])/, icon: "🌐", slug: "site" },
  { test: /(?:^|[-_\s])seo(?:$|[-_\s])/, icon: "🔎", slug: "site" },
  { test: /(?:^|[-_\s])(?:רדיו|radio)/, icon: "📻", slug: "radio" },
  { test: /(?:^|[-_\s])(?:טלוויזיה|tv)(?:$|[-_\s])/, icon: "📺", slug: "tv" },
  { test: /(?:^|[-_\s])(?:landing|lp)(?:$|[-_\s])|(?:דף|עמוד)\s?נחיתה/, icon: "🎯", slug: "site" },
  { test: /(?:^|[-_\s])(?:ה?קהילה|community)/, icon: "👥", slug: "referral" },
  { test: /(?:^|[-_\s])(?:influenc|משפיע)/, icon: "⭐", slug: "referral" },
  { test: /nextchat|chatbot|(?:^|[-_\s])(?:chat|bot)(?:$|[-_\s])|צ'?אטבוט|בוט/, icon: "🤖", slug: "other" },
  { test: /(?:^|[-_\s])(?:isracard|ישראכרט|ישראקרט)/, icon: "💳", slug: "other" },
  { test: /(?:^|[-_\s])(?:waze|וייז)/, icon: "🚗", slug: "other" },
  { test: /(?:^|[-_\s])(?:משרד\s?מכירות|sales\s?office)/, icon: "🏢", slug: "walk_in" },
  { test: /(?:^|[-_\s])(?:קשר\s?אישי|personal\s?contact)/, icon: "🤝", slug: "referral" },
  { test: /(?:^|[-_\s])teads(?:$|[-_\s])/, icon: "🎬", slug: "other" },
];
