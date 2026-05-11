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

const RULES: { test: RegExp; icon: string }[] = [
  { test: /(?:^|[-_\s])(?:google|גוגל)[\s\-_].*(?:discover|דיסקובר|דיסקאברי)/, icon: "🌐" },
  { test: /(?:^|[-_\s])(?:google|גוגל).*(?:search|חיפוש|seach)/, icon: "🔍" },
  { test: /(?:^|[-_\s])(?:google|גוגל|goolge|pmax|dv360|gs)(?:$|[-_\s])/, icon: "🔍" },
  { test: /(?:^|[-_\s])(?:google|גוגל)/, icon: "🔍" },
  { test: /(?:^|[-_\s])(?:facebook|פייסבוק|fb|meta|מטא)(?:$|[-_\s])/, icon: "📘" },
  { test: /(?:^|[-_\s])(?:instagram|אינסטגרם|ig)(?:$|[-_\s])/, icon: "📸" },
  { test: /(?:^|[-_\s])(?:tiktok|טיקטוק)/, icon: "🎵" },
  { test: /(?:^|[-_\s])(?:youtube|יוטיוב|yt)(?:$|[-_\s])/, icon: "▶️" },
  { test: /(?:^|[-_\s])(?:linkedin|לינקדאין)/, icon: "💼" },
  { test: /(?:^|[-_\s])(?:twitter)(?:$|[-_\s])|^x$/, icon: "🐦" },
  { test: /(?:^|[-_\s])(?:yad\s?2|יד\s?2)(?:$|[-_\s])/, icon: "🏠" },
  { test: /(?:^|[-_\s])(?:madlan|מדלן)(?:$|[-_\s])|(?:^|[-_\s])nadlan(?:\.|[-_\s])|(?:^|[-_\s])(?:נדלן)(?:$|[-_\s])/, icon: "🏘️" },
  { test: /(?:^|[-_\s])(?:onmap|אונמפ)(?:$|[-_\s])/, icon: "🗺️" },
  { test: /(?:^|[-_\s])(?:outbrain|אאוטבריין)/, icon: "📰" },
  { test: /(?:^|[-_\s])(?:taboola|טאבולה)/, icon: "📰" },
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
