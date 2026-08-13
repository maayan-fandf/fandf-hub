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
 * to Facebook, always. Channels with no brand (כתבה, שילוט, פניה
 * טלפונית, קשר אישי…) return "" and keep their emoji, which is the
 * right answer: there is no Article Inc. logo to show.
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

const RULES: { test: RegExp; icon: string; platform?: string }[] = [
  { test: /(?:^|[-_\s])(?:google|גוגל)[\s\-_].*(?:discover|דיסקובר|דיסקאברי)/, icon: "🌐", platform: "google" },
  { test: /(?:^|[-_\s])(?:google|גוגל).*(?:search|חיפוש|seach)/, icon: "🔍", platform: "google" },
  { test: /(?:^|[-_\s])(?:google|גוגל|goolge|pmax|dv360|gs)(?:$|[-_\s])/, icon: "🔍", platform: "google" },
  { test: /(?:^|[-_\s])(?:google|גוגל)/, icon: "🔍", platform: "google" },
  { test: /(?:^|[-_\s])(?:facebook|פייסבוק|fb|meta|מטא)(?:$|[-_\s])/, icon: "📘", platform: "facebook" },
  { test: /(?:^|[-_\s])(?:instagram|אינסטגרם|ig)(?:$|[-_\s])/, icon: "📸", platform: "instagram" },
  { test: /(?:^|[-_\s])(?:tiktok|טיקטוק)/, icon: "🎵", platform: "tiktok" },
  { test: /(?:^|[-_\s])(?:youtube|יוטיוב|yt)(?:$|[-_\s])/, icon: "▶️" },
  { test: /(?:^|[-_\s])(?:linkedin|לינקדאין)/, icon: "💼" },
  { test: /(?:^|[-_\s])(?:twitter)(?:$|[-_\s])|^x$/, icon: "🐦" },
  { test: /(?:^|[-_\s])(?:yad\s?2|יד\s?2)(?:$|[-_\s])/, icon: "🏠" },
  { test: /(?:^|[-_\s])(?:madlan|מדלן)(?:$|[-_\s])|(?:^|[-_\s])nadlan(?:\.|[-_\s])|(?:^|[-_\s])(?:נדלן)(?:$|[-_\s])/, icon: "🏘️" },
  { test: /(?:^|[-_\s])(?:onmap|אונמפ)(?:$|[-_\s])/, icon: "🗺️" },
  { test: /(?:^|[-_\s])(?:outbrain|אאוטבריין)/, icon: "📰", platform: "outbrain" },
  { test: /(?:^|[-_\s])(?:taboola|טאבולה)/, icon: "📰", platform: "taboola" },
  { test: /(?:^|[-_\s])(?:ynet|walla|mako|calcalist|globes|גלובס|haaretz|הארץ|jerusalempost|ashdodnet|n1[123]|i1[123])/, icon: "📰" },
  { test: /(?:^|[-_\s])(?:כתבה|article)/, icon: "📄" },
  { test: /(?:^|[-_\s])dis?c?over/, icon: "🧭" },
  { test: /(?:^|[-_\s])(?:פניה|פנייה|טלפו[נן]|כוכבית|phone|call)|(?:^|[-_\s])פ\.\s?(?:טלפ|פניה)/, icon: "📞" },
  { test: /(?:^|[-_\s])(?:שילוט|שלטי|חוצות|billboard)/, icon: "🪧" },
  { test: /(?:^|[-_\s])(?:דיוור|mail)/, icon: "✉️" },
  { test: /(?:^|[-_\s])(?:whatsapp|וואטסאפ|ווטסאפ)/, icon: "💬" },
  { test: /(?:^|[-_\s])sms(?:$|[-_\s])/, icon: "💬" },
  { test: /minisite|מיני-?סייט/, icon: "🪟" },
  { test: /(?:^|[-_\s])(?:site|website|אתר|אינטרנט)(?:$|[-_\s])/, icon: "🌐" },
  { test: /(?:^|[-_\s])seo(?:$|[-_\s])/, icon: "🔎" },
  { test: /(?:^|[-_\s])(?:רדיו|radio)/, icon: "📻" },
  { test: /(?:^|[-_\s])(?:טלוויזיה|tv)(?:$|[-_\s])/, icon: "📺" },
  { test: /(?:^|[-_\s])(?:landing|lp)(?:$|[-_\s])|(?:דף|עמוד)\s?נחיתה/, icon: "🎯" },
  { test: /(?:^|[-_\s])(?:ה?קהילה|community)/, icon: "👥" },
  { test: /(?:^|[-_\s])(?:influenc|משפיע)/, icon: "⭐" },
  { test: /nextchat|chatbot|(?:^|[-_\s])(?:chat|bot)(?:$|[-_\s])|צ'?אטבוט|בוט/, icon: "🤖" },
  { test: /(?:^|[-_\s])(?:isracard|ישראכרט|ישראקרט)/, icon: "💳" },
  { test: /(?:^|[-_\s])(?:waze|וייז)/, icon: "🚗" },
  { test: /(?:^|[-_\s])(?:משרד\s?מכירות|sales\s?office)/, icon: "🏢" },
  { test: /(?:^|[-_\s])(?:קשר\s?אישי|personal\s?contact)/, icon: "🤝" },
  { test: /(?:^|[-_\s])teads(?:$|[-_\s])/, icon: "🎬" },
];
