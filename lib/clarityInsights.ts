import { cache } from "react";
import { getProjectLandingUrl } from "@/lib/projectsDirect";
import {
  fetchClarityInsights,
  clarityDashboardUrlForUrl,
  type ClarityInsights,
} from "@/lib/clarity";
import { callClaude, ClaudeError } from "@/lib/claude";

/**
 * Per-project, per-render orchestrator for the landing-page insights
 * section. Single entry point for the component:
 *
 *   1. Look up the project's landing URL on the Keys sheet.
 *   2. Fetch Clarity data for that URL (trailing 3 days, free tier).
 *   3. Hand the numbers + project context to Claude for a 2-3
 *      sentence Hebrew narrative.
 *   4. Return the aggregate, or `null` if anything failed (the UI
 *      drops the section silently — the project page never breaks
 *      because of this).
 *
 * Wrapped in React's `cache()` so multiple references in the same
 * render share work — no need to plumb the result through props.
 */

export type ClaritySectionData = {
  landingUrl: string;
  insights: ClarityInsights;
  hebrewSummary: string;
  clarityDashboardUrl: string;
};

const CLAUDE_SYSTEM_PROMPT = `אתה אנליסט שיווק דיגיטלי בכיר ב־F&F. תפקידך לכתוב סיכום קצר של 2-3 משפטים עבור מנהל פרויקט שמסתכל על נתוני ההתנהגות של גולשים בדף נחיתה במהלך 3 הימים האחרונים.

הסבר את הממצא המשמעותי ביותר במספרים — מה דורש תשומת לב מיידית? התמקד ב:
- חיכוך בחוויית המשתמש (לחיצות זעם, לחיצות מתות, חזרות מהירות)
- מעורבות (זמן ממוצע באתר, עומק גלילה)
- הבדלים בין מובייל לדסקטופ
- נפח תנועה חריג (גבוה/נמוך מהצפוי)

כללים:
1. כתוב בעברית, לשון הווה, מקצועית אך לא יבשה
2. 2-3 משפטים בלבד
3. אם כל המספרים נראים תקינים, כתוב "אין שינוי משמעותי בשבוע האחרון" ושום דבר אחר
4. סיים במשפט אקשן אחד קצר ("שווה לבדוק את ה־CTA העליון", "כדאי לבחון את גרסת המובייל")
5. אל תזכיר את עצמך, אל תפתח ב"שלום" או "סיכום:" — קפוץ ישר לתובנה
6. אל תשתמש באמוג'ים`;

function buildClaudeUserMessage(
  projectName: string,
  landingUrl: string,
  insights: ClarityInsights,
): string {
  // Volatile content goes in the user turn so the system-block cache
  // stays valid across all projects/renders.
  const data = {
    project: projectName,
    landingUrl,
    window: "3 ימים אחרונים",
    metrics: {
      sessions: insights.sessions,
      engagementSecondsAvg: round(insights.engagementSecondsAvg),
      scrollDepthPctAvg: round(insights.scrollDepthPctAvg),
      rageClicks: insights.rageClicks,
      deadClicks: insights.deadClicks,
      quickbacks: insights.quickbacks,
      excessiveScroll: insights.excessiveScroll,
      deviceSplit: insights.deviceSplit,
    },
  };
  return JSON.stringify(data, null, 2);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export const summarizeClarityForProject = cache(
  async (args: {
    subjectEmail: string;
    project: string;
  }): Promise<ClaritySectionData | null> => {
    const landingUrl = await getProjectLandingUrl(
      args.subjectEmail,
      args.project,
    );
    if (!landingUrl) return null;

    const insights = await fetchClarityInsights(landingUrl);
    if (!insights) return null;

    let hebrewSummary = "";
    try {
      const result = await callClaude({
        system: CLAUDE_SYSTEM_PROMPT,
        user: buildClaudeUserMessage(args.project, landingUrl, insights),
        maxTokens: 350,
      });
      hebrewSummary = result.text;
    } catch (e) {
      // Claude failure is non-fatal — KPI grid still renders, the
      // narrative card is just omitted. Logged so we can spot real
      // outages vs occasional 5xx blips.
      if (e instanceof ClaudeError) {
        console.warn(
          `[clarityInsights] Claude failed for ${args.project} (status=${e.status}): ${e.message}`,
        );
      } else {
        console.warn(
          `[clarityInsights] Claude failed for ${args.project}:`,
          e,
        );
      }
    }

    return {
      landingUrl,
      insights,
      hebrewSummary,
      clarityDashboardUrl: clarityDashboardUrlForUrl(landingUrl),
    };
  },
);
