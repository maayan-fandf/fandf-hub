import { unstable_cache } from "next/cache";
import { callClaude, ClaudeError } from "@/lib/claude";
import { driveFolderOwner } from "@/lib/sa";
import { getProjectReportData } from "@/lib/reportData";
import {
  BASIS_LABELS,
  BASIS_TITLES,
  DEFAULT_MEETING_BASIS,
  type MeetingBasis,
} from "@/lib/meetingBasis";
import {
  sumAdPlatform,
  adLeadsOf,
  applyBasisToChannels,
  applyBasisToCreatives,
  datedUnattributed,
  isMeetingAnomaly,
  totalsForBasis,
  type ProjectReportData,
} from "@/lib/reportShared";

/**
 * On-demand AI performance summary for the native report — the in-hub
 * rebuild of the legacy generateAiSummary (Code.js:8200). Feeds Claude
 * the project's window totals + funnel + top-funnel + channel + creative
 * numbers and asks for a structured Hebrew analyst summary. Cached 6h
 * per (project, period, company, meeting basis) — same TTL as the Apps
 * Script CacheService copy.
 *
 * MEETING BASIS. Every תיאומים / פגישות number handed to the model is on
 * ONE basis — the page-level switch's (lib/meetingBasis) — and the input
 * says which. It used to be mixed without saying so: the funnel and the
 * channels were lead-entry (ALL CLIENTS) while the keywords were dated
 * warehouse joins, so on The 57 in September the model read 3 תיאומים on
 * "גיא ודורון לוי מתחם האלף" under a google-search channel with 0, and
 * could only conclude one of them was wrong.
 *
 * Uses lib/claude (ANTHROPIC_API_KEY, already an App Hosting secret).
 * Web-search-backed competitor analysis (the legacy's 9th subheading)
 * is intentionally dropped — the simple wrapper is tool-less; the other
 * eight sections all come from data we already hold.
 */

const SYSTEM_PROMPT = `אתה אנליסט שיווק דיגיטלי בכיר ב־F&F. אתה מקבל נתוני ביצועים של פרויקט נדל"ן (קמפייני מדיה + משפך CRM) ומפיק סיכום מקצועי בעברית עבור מנהל הקמפיין.

מבנה הסיכום (כותרות משנה ב־**bold**, פסקה קצרה לכל אחת, דלג על כותרת שאין לה נתונים):
**בריאות כללית** — שורה אחת: האם הפרויקט בקצב תקין, מה המספר הבולט.
**ערוץ מוביל** — הערוץ עם העלות-לליד הטובה ביותר ומה כדאי להסיט אליו.
**קריאייטיב ומסרים** — המודעה המנצחת, מודעות בעייתיות/עייפות, מה לרענן.
**מילות חיפוש** — מילות המפתח שמניבות המרות/פגישות.
**בעיות וסיכונים** — חריגות תקציב, ערוצים ללא לידים, צניחות.
**המלצות פעולה מיידיות** — 2-3 פעולות קונקרטיות ממוספרות.

כללים: עברית, לשון הווה, מקצועית וישירה. הישען על המספרים שסופקו בלבד — אל תמציא נתונים. עד 450 מילים. אל תפתח ב"שלום" או "סיכום:", קפוץ ישר לתוכן. ללא אמוג'ים.`;

/**
 * The basis rule appended to the system prompt. Under dated the lead and
 * meeting columns are counted on different bases — leads by arrival,
 * meetings by their own date — so a ליד→תיאום ratio (and any cost-per-lead
 * vs cost-per-meeting comparison built on one) is not a conversion rate,
 * and there is no dated history to compare a month against. The page hides
 * the same things under dated (the ratio arrow, the deltas, the meeting
 * forecast pills, the 🏆 chip); the summary must not reintroduce them.
 */
const BASIS_RULE: Record<MeetingBasis, string> = {
  lead: `ספירת הפגישות בנתונים (תיאומים, פגישות) היא ${BASIS_LABELS.lead}: כל אירועי הפגישה של לידים שנכנסו בתקופה, גם אם הפגישה עצמה אחרי סוף התקופה. אפשר לחשב יחס המרה מליד לתיאום.`,
  dated: `ספירת הפגישות בנתונים (תיאומים, פגישות) היא ${BASIS_LABELS.dated}: פגישות שמועדן בתוך התקופה, בלי קשר למתי נכנס הליד. הלידים נספרים לפי כניסה, ולכן אל תחשב ואל תציג יחס המרה מליד לתיאום או מליד לפגישה — זה אינו בר-השוואה. אל תשווה מספרי פגישות לתקופות קודמות. יחס תיאום→פגישה ועלות לתיאום/לפגישה תקינים. שדה null פירושו שאין נתון לפי מועד הפגישה — אל תציג אותו כאפס.`,
};

/**
 * The model's input on `basis`. Exported for the read-only probe that
 * diffs the two bases' inputs; the route never calls it directly.
 *
 * Meeting fields follow the payload rule (lib/meetingBasis): a basis with
 * no source here is `null`, never the other basis and never 0 — the prompt
 * tells the model what null means. Only fields that carry meetings change
 * with the basis; spend, leads, platform and creative metrics are the same
 * object in both inputs.
 */
export function buildSummaryInput(d: ProjectReportData, basis: MeetingBasis): unknown {
  const dated = basis === "dated";
  const sm = sumAdPlatform(d.adPlatform);
  const t = d.totals;
  // Overview pair on this basis (null ⇒ no number on it — datedTotals is
  // null without a dated source).
  const meet = totalsForBasis(d, basis);
  // ערוצים rows on this basis. Under dated without a dated source there is
  // nothing to substitute; the meeting cells go null rather than keeping
  // the lead-entry numbers they already hold.
  const rowsHaveBasis = !dated || !!d.datedSource;
  const rows = dated && d.datedSource ? applyBasisToChannels(d.channels, "dated") : d.channels;
  const creatives = d.creatives ? applyBasisToCreatives(d.creatives, basis) : null;
  const kwMissing = creatives?.meetingBasisMissing ?? true;
  return {
    פרויקט: d.project,
    חברה: d.company,
    תקופה: `${d.window.startIso} — ${d.window.endIso}`,
    מצב: d.mode,
    בסיס_ספירת_פגישות: `${BASIS_LABELS[basis]} — ${BASIS_TITLES[basis]}`,
    קצב: d.pacing
      ? { label: d.pacing.label, ניצול_תקציב_אחוז: Math.round(d.pacing.spendPct), ימים_אחוז: Math.round(d.pacing.dayPct) }
      : null,
    תקציב_וניצול: t
      ? { תקציב: Math.round(t.budget), הוצאה: Math.round(t.spend) }
      : null,
    משפך: t
      ? {
          לידים: t.leads,
          תיאומים: meet ? meet.scheduled : null,
          פגישות: meet ? meet.meetings : null,
          עלות_לליד: t.leads > 0 ? Math.round(t.spend / t.leads) : 0,
          עלות_לתיאום: meet
            ? meet.scheduled > 0
              ? Math.round(t.spend / meet.scheduled)
              : 0
            : null,
        }
      : null,
    טופ_פאנל: {
      חשיפות: sm.impressions,
      קליקים: sm.clicks,
      CTR_אחוז: +(sm.ctr * 100).toFixed(2),
      CPC: Math.round(sm.cpc),
      המרות_גוגל: sm.conversions,
      לידים_פייסבוק: sm.fbLeads,
      קליק_לליד_אחוז: sm.clicks > 0 ? +((adLeadsOf(sm) / sm.clicks) * 100).toFixed(2) : 0,
    },
    ערוצים: rows.map((c) => ({
      ערוץ: c.channel,
      הוצאה: Math.round(c.spend),
      לידים: c.leads,
      תיאומים: rowsHaveBasis ? c.scheduled : null,
      פגישות: rowsHaveBasis ? c.meetings : null,
      עלות_לליד: Math.round(c.costPerLead),
      קצב_יומי_נדרש: Math.round(c.dailyRate),
      תקציב_מוגדר: c.configuredDaily,
    })),
    // Dated meetings no channel row could claim — with them Σ ערוצים =
    // משפך on the dated basis, so the model is not left reconciling a gap
    // it cannot explain. Lead-entry has no such line: its funnel IS Σ rows.
    ...(dated && d.datedSource
      ? { פגישות_שלא_שויכו_לערוץ: datedUnattributed(d.datedSource) }
      : {}),
    קריאייטיב: creatives
      ? {
          פייסבוק: {
            מודעות_פעילות: creatives.fb.adCount,
            עלות: Math.round(creatives.fb.cost),
            לידים: creatives.fb.leads,
            עלות_לליד: Math.round(creatives.fb.cpl),
            מנצחת: creatives.fb.topAds.find((a) => a.isWinner)?.ad ?? null,
            מודעות: creatives.fb.topAds.slice(0, 8).map((a) => ({
              שם: a.ad,
              עלות_לליד: Math.round(a.cpl),
              CTR_אחוז: +(a.ctr * 100).toFixed(2),
              לידים: a.leads,
              עייפה: a.fatigued ? a.fatigueReason : false,
            })),
            // The campaign rides along because ad-set rows are keyed by
            // (campaign, name) — the same audience is rebuilt per campaign, so
            // without it the model sees two identical "קהל" entries with
            // different numbers and has no way to tell them apart.
            קהלים: creatives.fb.topAdSets.slice(0, 5).map((s) => ({
              קהל: s.name,
              קמפיין: s.campaign,
              עלות_לליד: Math.round(s.cpl),
              לידים: s.leads,
            })),
          },
          גוגל: {
            מילות_מפתח: creatives.google.topKeywords.slice(0, 8).map((k) => ({
              מילה: k.keyword,
              קליקים: k.clicks,
              המרות: k.conversions,
              תיאומים: kwMissing ? null : k.scheduled,
              פגישות: kwMissing ? null : k.held,
            })),
          },
        }
      : null,
    // The 🏆 meetings chip compares this period's LEAD-ENTRY meetings with
    // last month's; the page hides it under dated, and so does this — with
    // the page's own predicate.
    חריגות: d.anomalies
      .filter((a) => !dated || !isMeetingAnomaly(a))
      .map((a) => a.text),
  };
}

async function generate(
  projectName: string,
  period: string,
  company: string,
  basis: MeetingBasis,
): Promise<string> {
  const data = await getProjectReportData(
    driveFolderOwner(),
    projectName,
    period,
    company,
  );
  if (!data) return "";
  try {
    const res = await callClaude({
      system: `${SYSTEM_PROMPT}\n\n${BASIS_RULE[basis]}`,
      user: JSON.stringify(buildSummaryInput(data, basis), null, 2),
      model: "claude-haiku-4-5",
      maxTokens: 1400,
    });
    return res.text;
  } catch (e) {
    if (e instanceof ClaudeError) {
      console.warn("[reportAiSummary] Claude failed:", e.message);
      return "";
    }
    throw e;
  }
}

/** Cached 6h per (project, period, company, basis) — the summary is
 *  deterministic-ish and expensive; the legacy cached the same way. The
 *  basis is in the key because the two inputs differ in every meeting
 *  number: one cache entry per basis, so flipping the switch never serves
 *  a summary written about the other one. */
export function generateReportSummary(
  projectName: string,
  period: string,
  company: string,
  basis: MeetingBasis = DEFAULT_MEETING_BASIS,
): Promise<string> {
  const cached = unstable_cache(
    () => generate(projectName, period, company, basis),
    ["reportAiSummary", projectName, period, company, basis],
    { revalidate: 6 * 3600, tags: ["reportAiSummary"] },
  );
  return cached();
}
