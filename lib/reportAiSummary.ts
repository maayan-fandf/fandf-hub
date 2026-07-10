import { unstable_cache } from "next/cache";
import { callClaude, ClaudeError } from "@/lib/claude";
import { driveFolderOwner } from "@/lib/sa";
import { getProjectReportData } from "@/lib/reportData";
import {
  sumAdPlatform,
  adLeadsOf,
  type ProjectReportData,
} from "@/lib/reportShared";

/**
 * On-demand AI performance summary for the native report — the in-hub
 * rebuild of the legacy generateAiSummary (Code.js:8200). Feeds Claude
 * the project's window totals + funnel + top-funnel + channel + creative
 * numbers and asks for a structured Hebrew analyst summary. Cached 6h
 * per (project, period) — same TTL as the Apps Script CacheService copy.
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

function compactData(d: ProjectReportData): unknown {
  const sm = sumAdPlatform(d.adPlatform);
  const t = d.totals;
  return {
    פרויקט: d.project,
    חברה: d.company,
    תקופה: `${d.window.startIso} — ${d.window.endIso}`,
    מצב: d.mode,
    קצב: d.pacing
      ? { label: d.pacing.label, ניצול_תקציב_אחוז: Math.round(d.pacing.spendPct), ימים_אחוז: Math.round(d.pacing.dayPct) }
      : null,
    תקציב_וניצול: t
      ? { תקציב: Math.round(t.budget), הוצאה: Math.round(t.spend) }
      : null,
    משפך: t
      ? {
          לידים: t.leads,
          תיאומים: t.scheduled,
          פגישות: t.meetings,
          עלות_לליד: t.leads > 0 ? Math.round(t.spend / t.leads) : 0,
          עלות_לתיאום: t.scheduled > 0 ? Math.round(t.spend / t.scheduled) : 0,
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
    ערוצים: d.channels.map((c) => ({
      ערוץ: c.channel,
      הוצאה: Math.round(c.spend),
      לידים: c.leads,
      תיאומים: c.scheduled,
      פגישות: c.meetings,
      עלות_לליד: Math.round(c.costPerLead),
      קצב_יומי_נדרש: Math.round(c.dailyRate),
      תקציב_מוגדר: c.configuredDaily,
    })),
    קריאייטיב: d.creatives
      ? {
          פייסבוק: {
            מודעות_פעילות: d.creatives.fb.adCount,
            עלות: Math.round(d.creatives.fb.cost),
            לידים: d.creatives.fb.leads,
            עלות_לליד: Math.round(d.creatives.fb.cpl),
            מנצחת: d.creatives.fb.topAds.find((a) => a.isWinner)?.ad ?? null,
            מודעות: d.creatives.fb.topAds.slice(0, 8).map((a) => ({
              שם: a.ad,
              עלות_לליד: Math.round(a.cpl),
              CTR_אחוז: +(a.ctr * 100).toFixed(2),
              לידים: a.leads,
              עייפה: a.fatigued ? a.fatigueReason : false,
            })),
            קהלים: d.creatives.fb.topAdSets.slice(0, 5).map((s) => ({
              קהל: s.name,
              עלות_לליד: Math.round(s.cpl),
              לידים: s.leads,
            })),
          },
          גוגל: {
            מילות_מפתח: d.creatives.google.topKeywords.slice(0, 8).map((k) => ({
              מילה: k.keyword,
              קליקים: k.clicks,
              המרות: k.conversions,
              תיאומים: k.scheduled,
            })),
          },
        }
      : null,
    חריגות: d.anomalies.map((a) => a.text),
  };
}

async function generate(
  projectName: string,
  period: string,
  company: string,
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
      system: SYSTEM_PROMPT,
      user: JSON.stringify(compactData(data), null, 2),
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

/** Cached 6h per (project, period) — the summary is deterministic-ish
 *  and expensive; the legacy cached the same way. */
export function generateReportSummary(
  projectName: string,
  period: string,
  company: string,
): Promise<string> {
  const cached = unstable_cache(
    () => generate(projectName, period, company),
    ["reportAiSummary", projectName, period, company],
    { revalidate: 6 * 3600, tags: ["reportAiSummary"] },
  );
  return cached();
}
