/**
 * Paid-channels diagnosis — TypeScript port of `diagnosePaidChannels`
 * from client-dashboard/Index.html:3918 (2026-06-04).
 *
 * Surfaces actionable insights about a project's paid media: budget
 * waste (high spend, 0 leads), CPL outliers (>2× paid avg), lead-
 * quality leaks (low conversion to scheduled), winners (CPL ≤ 70%
 * of avg), and portfolio-relative pricing (top quartile of your own
 * book of business).
 *
 * Cards are returned ranked by priority. Each carries a tone for
 * styling, a short head, an HTML body (we control escape, so the
 * fragments here are safe), an optional sample-size note, and a
 * tip with action guidance.
 *
 * Used by /projects/[project]/stats — the dedicated stats page that
 * mirrors the bottom-of-dashboard sections at full height.
 */

import { channelAlias } from "@/lib/channelAlias";
import type { ProjectMetricsChannel } from "@/lib/appsScript";
import type { PortfolioBenchmarks } from "@/lib/portfolioBenchmarks";

/* ── Thresholds ─────────────────────────────────────────────────── */
/* Mirrors client-dashboard/Index.html:3725-3733 so both surfaces
 * surface the same channels as winners / outliers / waste. */
const PD_MIN_SPEND = 500; // ₪ to count as "paid"
const PD_MIN_WASTE_SPEND = 500; // ₪ threshold for waste alarm
const PD_WASTE_SHARE = 0.1; // OR ≥10% of total spend
const PD_ROBUST_LEADS = 10;
const PD_ROBUST_SCHEDULED = 5;
const PD_DIR_LEADS = 3; // directional tier: 3–9 leads
const PD_CPL_OUTLIER_MULT = 2.0; // CPL > 2× paid avg → outlier
const PD_QUALITY_RATIO = 0.5; // conv ≤ 50% of avg → quality leak
const PD_WINNER_MULT = 0.7; // CPL ≤ 70% of paid avg → winner

export type DiagnosisTone = "good" | "warn" | "bad" | "watch";

export type DiagnosisCard = {
  priority: number;
  tone: DiagnosisTone;
  icon: string;
  head: string;
  /** HTML-safe body. Builder uses esc() on user-supplied strings; static
   *  fragments (`<b>`, `<br>`) are inserted by trusted code paths only. */
  body: string;
  sample?: string;
  tip: string;
};

/* ── Helpers ────────────────────────────────────────────────────── */
const fmtIls = (n: number) => "₪" + Math.round(n).toLocaleString("he-IL");
const fmtPct = (n: number) => (n * 100).toFixed(1) + "%";
const esc = (s: string) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

type Tier = "robust" | "robust-cpl" | "directional" | "early";

function tierOf(c: ProjectMetricsChannel): Tier {
  const L = Number(c.leads) || 0;
  const S = Number(c.scheduled) || 0;
  if (L >= PD_ROBUST_LEADS && S >= PD_ROBUST_SCHEDULED) return "robust";
  if (L >= PD_ROBUST_LEADS) return "robust-cpl"; // robust CPL, few scheduled yet
  if (L >= PD_DIR_LEADS) return "directional";
  return "early";
}

function sampleText(c: ProjectMetricsChannel): string {
  const L = Number(c.leads) || 0;
  const S = Number(c.scheduled) || 0;
  const tier = tierOf(c);
  if (tier === "robust") return `N=${L} לידים · ${S} תיאומים — אות מהימן`;
  if (tier === "robust-cpl")
    return `N=${L} לידים — אות מהימן ל-CPL, מוקדם מדי לתיאומים`;
  if (tier === "directional")
    return `N=${L} לידים — אות ראשוני, לא מספיק להסקה`;
  return `N=${L} לידים — מוקדם מדי להסקה`;
}

/* ── Main entry ─────────────────────────────────────────────────── */
export function diagnosePaidChannels(
  channels: ProjectMetricsChannel[],
  benchmarks: PortfolioBenchmarks | null,
): DiagnosisCard[] {
  const all = (channels || []).filter((c) => Number(c.spend) > 0);
  if (!all.length) return [];
  const paid = all.filter(
    (c) => Number(c.spend) >= PD_MIN_SPEND || Number(c.leads) > 0,
  );
  if (!paid.length) return [];

  const totalSpend = all.reduce((s, c) => s + Number(c.spend || 0), 0);
  const totalLeads = all.reduce((s, c) => s + Number(c.leads || 0), 0);
  const totalSched = all.reduce((s, c) => s + Number(c.scheduled || 0), 0);
  const paidLeads = paid.reduce((s, c) => s + Number(c.leads || 0), 0);
  const paidSpend = paid.reduce((s, c) => s + Number(c.spend || 0), 0);
  const paidAvgCpl = paidLeads > 0 ? paidSpend / paidLeads : 0;
  const projAvgConv = totalLeads > 0 ? totalSched / totalLeads : 0;

  const cards: DiagnosisCard[] = [];
  const projStats = benchmarks?.project;

  /* 0.5 — Project-level expensive: aggregate CPL/CPS/CPM exceeds
   *      portfolio P75. Self-calibrating against your own book. */
  if (projStats && projStats.cpl.stats.p75 > 0 && paidLeads >= PD_ROBUST_LEADS) {
    const paidScheduled = paid.reduce(
      (s, c) => s + Number(c.scheduled || 0),
      0,
    );
    const paidMeetings = paid.reduce((s, c) => s + Number(c.meetings || 0), 0);
    const projCpl = paidAvgCpl;
    const projCps =
      paidScheduled >= PD_ROBUST_SCHEDULED ? paidSpend / paidScheduled : 0;
    const projCpm = paidMeetings >= 3 ? paidSpend / paidMeetings : 0;
    const exceeds: Array<{
      label: string;
      proj: number;
      p75: number;
      median: number;
    }> = [];
    if (projCpl > projStats.cpl.stats.p75)
      exceeds.push({
        label: "עלות לליד",
        proj: projCpl,
        p75: projStats.cpl.stats.p75,
        median: projStats.cpl.stats.median,
      });
    if (projCps > 0 && projStats.cps.stats.p75 > 0 && projCps > projStats.cps.stats.p75)
      exceeds.push({
        label: "עלות לתיאום",
        proj: projCps,
        p75: projStats.cps.stats.p75,
        median: projStats.cps.stats.median,
      });
    if (projCpm > 0 && projStats.cpm.stats.p75 > 0 && projCpm > projStats.cpm.stats.p75)
      exceeds.push({
        label: "עלות לביצוע",
        proj: projCpm,
        p75: projStats.cpm.stats.p75,
        median: projStats.cpm.stats.median,
      });
    if (exceeds.length) {
      const lines = exceeds
        .map(
          (e) =>
            `<b>${esc(e.label)}:</b> ${fmtIls(e.proj)} — מעל P75 של התיק (${fmtIls(e.p75)}, חציון ${fmtIls(e.median)})`,
        )
        .join("<br>");
      cards.push({
        priority: 0.5,
        tone: "warn",
        icon: "💸",
        head: "פרויקט יקר — ברבעון העליון של התיק",
        body:
          lines +
          `<br><span style="opacity:.7">כלומר יותר מ-75% מהפרויקטים שלך זולים יותר במטריקות האלה.</span>`,
        sample: `נמדד מול ${projStats.cpl.stats.n} פרויקטים בתיק`,
        tip: "הפרויקט יקר ברמת-תיק — לא רק ביחס לערוץ זה או אחר. שאלות לבדיקה: (1) האם מגיעים לידים לא רלוונטיים? (2) האם הקריאייטיב בולט מול התחרות? (3) האם זהו איזור/פלח יקר שמחייב תקציב גבוה יותר? (4) האם משך הפרויקט קצר מידי והאלגוריתמים בלמידה?",
      });
    }
  }

  /* 0.7 — Per-channel expensive: each channel's CPL vs its own family's
   *       portfolio P75. Catches channel-specific overpricing even when
   *       the project aggregate is fine. */
  if (benchmarks?.channels) {
    const channelBad: Array<{
      channel: string;
      cpl: number;
      p75: number;
      median: number;
      n: number;
    }> = [];
    paid.forEach((c) => {
      const tier = tierOf(c);
      if (tier !== "robust" && tier !== "robust-cpl") return;
      const alias = channelAlias(c.channel);
      const s = benchmarks.channels[alias];
      if (!s || !s.cpl || s.cpl.stats.n < 3 || s.cpl.stats.p75 <= 0) return;
      const cpl = Number(c.costPerLead) || 0;
      if (cpl > s.cpl.stats.p75) {
        channelBad.push({
          channel: c.channel,
          cpl,
          p75: s.cpl.stats.p75,
          median: s.cpl.stats.median,
          n: s.cpl.stats.n,
        });
      }
    });
    if (channelBad.length) {
      channelBad.sort((a, b) => b.cpl / b.p75 - a.cpl / a.p75);
      const lines = channelBad
        .slice(0, 3)
        .map(
          (b) =>
            `<b>${esc(b.channel)}:</b> ${fmtIls(b.cpl)} — מעל P75 של ערוצים דומים בתיק (${fmtIls(b.p75)}, חציון ${fmtIls(b.median)}, n=${b.n})`,
        )
        .join("<br>");
      const more =
        channelBad.length > 3
          ? `<br><span style="opacity:.7">+${channelBad.length - 3} ערוצים נוספים</span>`
          : "";
      cards.push({
        priority: 0.7,
        tone: "warn",
        icon: "🎯",
        head:
          channelBad.length === 1
            ? `ערוץ יקר ביחס לתיק: ${channelBad[0].channel}`
            : "ערוצים יקרים ביחס לתיק",
        body: lines + more,
        sample: "השוואה לערוצים דומים (אותה פלטפורמה) על פני כל הפרויקטים",
        tip: "זה לא בזבוז מוחלט — אבל בערוצים האלה היית מצפה ל-CPL נמוך יותר על בסיס הביצועים ההיסטוריים שלך. בדוק קריאייטיב/טירגוט, ואם נמשך — שקול להזיז תקציב לערוצים שעובדים יותר טוב בפרויקט הזה.",
      });
    }
  }

  /* 1 — Waste alarm: significant spend, zero leads */
  all.forEach((c) => {
    const sp = Number(c.spend) || 0;
    const leads = Number(c.leads) || 0;
    if (
      leads === 0 &&
      (sp >= PD_MIN_WASTE_SPEND || sp >= totalSpend * PD_WASTE_SHARE)
    ) {
      cards.push({
        priority: 1,
        tone: "bad",
        icon: "🔴",
        head: `בזבוז תקציב: ${c.channel}`,
        body: `הוצאת <b>${fmtIls(sp)}</b> על ${esc(c.channel)} וקיבלת <b>0 לידים</b> בתקופה זו.`,
        sample:
          sp >= totalSpend * PD_WASTE_SHARE
            ? `${fmtPct(sp / totalSpend)} מסך ההוצאה על מדיה בתשלום`
            : undefined,
        tip: "השבת/הורד תקציב, בדוק פיקסל ומעקב המרות, ושקול לחזור לטירגוט/קריאייטיב שעבד בעבר.",
      });
    }
  });

  /* 2 — CPL outlier: robust channel with CPL > 2× paid avg */
  paid.forEach((c) => {
    const tier = tierOf(c);
    if (tier !== "robust" && tier !== "robust-cpl") return;
    const cpl = Number(c.costPerLead) || 0;
    if (paidAvgCpl > 0 && cpl > paidAvgCpl * PD_CPL_OUTLIER_MULT) {
      cards.push({
        priority: 2,
        tone: "warn",
        icon: "🟠",
        head: `עלות לליד גבוהה חריג: ${c.channel}`,
        body: `CPL של ${esc(c.channel)}: <b>${fmtIls(cpl)}</b> — <b>${(cpl / paidAvgCpl).toFixed(1)}×</b> מהממוצע של המדיה בתשלום (${fmtIls(paidAvgCpl)}).`,
        sample: sampleText(c),
        tip: "בדוק קריאייטיב, טירגוט, והתאמת הודעה לדף נחיתה. שקול להעביר חלק מהתקציב לערוצים יעילים יותר עד שה-CPL ישתפר.",
      });
    }
  });

  /* 3 — Quality leak: robust channel with conv < 50% of project avg */
  paid.forEach((c) => {
    if (tierOf(c) !== "robust") return;
    const L = Number(c.leads) || 0;
    const S = Number(c.scheduled) || 0;
    const conv = L > 0 ? S / L : 0;
    if (projAvgConv > 0 && conv > 0 && conv < projAvgConv * PD_QUALITY_RATIO) {
      cards.push({
        priority: 3,
        tone: "warn",
        icon: "📉",
        head: `איכות לידים נמוכה: ${c.channel}`,
        body: `${esc(c.channel)} מייצר לידים, אבל רק <b>${fmtPct(conv)}</b> מתואמים לפגישה — לעומת ${fmtPct(projAvgConv)} ממוצע הפרויקט.`,
        sample: sampleText(c),
        tip: "הלידים ככל הנראה בעלי כוונה נמוכה. חדד טירגוט (קהל, מילות מפתח), הוסף שאלות סינון לטופס, או הקטן תקציב עד שתמצא קהל איכותי יותר.",
      });
    }
  });

  /* 4 — Winner: robust channel with CPL ≤ 70% of avg */
  paid.forEach((c) => {
    if (tierOf(c) !== "robust") return;
    const cpl = Number(c.costPerLead) || 0;
    if (paidAvgCpl > 0 && cpl > 0 && cpl <= paidAvgCpl * PD_WINNER_MULT) {
      const cps = Number(c.costPerScheduled) || 0;
      const cpm = Number(c.costPerMeeting) || 0;
      const extras: string[] = [];
      if (cps > 0) extras.push(`עלות לתיאום ${fmtIls(cps)}`);
      if (cpm > 0) extras.push(`עלות לפגישה ${fmtIls(cpm)}`);
      cards.push({
        priority: 4,
        tone: "good",
        icon: "⭐",
        head: `ערוץ מוביל: ${c.channel}`,
        body: `${esc(c.channel)}: <b>${fmtIls(cpl)}</b> לליד${extras.length ? " · " + extras.join(" · ") : ""}. יעיל פי <b>${(paidAvgCpl / cpl).toFixed(1)}</b> מממוצע המדיה בתשלום.`,
        sample: sampleText(c),
        tip: "זהו ערוץ מוכח — שקול להגדיל את התקציב בהדרגה (30-50% בבת אחת) ולבדוק אם היעילות נשמרת בסקייל.",
      });
    }
  });

  /* 4.5 — Early-warning project: high CPL vs portfolio P75 on small sample */
  if (
    projStats &&
    projStats.cpl.stats.p75 > 0 &&
    paidLeads >= PD_DIR_LEADS &&
    paidLeads < PD_ROBUST_LEADS &&
    paidAvgCpl > projStats.cpl.stats.p75
  ) {
    const chBits = paid
      .filter((c) => tierOf(c) === "directional" && Number(c.costPerLead) > 0)
      .sort((a, b) => Number(b.costPerLead) - Number(a.costPerLead))
      .slice(0, 2)
      .map(
        (c) =>
          `<b>${esc(c.channel)}:</b> ${fmtIls(Number(c.costPerLead))} (N=${Number(c.leads) || 0})`,
      );
    cards.push({
      priority: 4.5,
      tone: "watch",
      icon: "⚠️",
      head: "עלות לליד גבוהה — סימן מוקדם",
      body:
        `CPL נוכחי של המדיה בתשלום: <b>${fmtIls(paidAvgCpl)}</b> — מעל P75 של התיק (${fmtIls(projStats.cpl.stats.p75)}, חציון ${fmtIls(projStats.cpl.stats.median)}).` +
        (chBits.length ? `<br>${chBits.join("<br>")}` : ""),
      sample: `מדגם קטן: ${paidLeads} לידים בתשלום (פחות מ-${PD_ROBUST_LEADS}) — האות לא יציב, אך גבוה מספיק כדי לבחון.`,
      tip: `לא לסגור מסקנה עדיין, אבל כדאי להציץ עכשיו: (1) האם הלידים רלוונטיים? (2) האם הקריאייטיב/טירגוט דורש רענון? (3) האם הפרויקט בתקופת למידה של האלגוריתמים? אם התמונה נשארת אחרי ${PD_ROBUST_LEADS}+ לידים — נראה כאן התראה חמורה יותר.`,
    });
  }

  /* 5 — Early signal: directional tier with competitive CPL */
  paid.forEach((c) => {
    if (tierOf(c) !== "directional") return;
    const cpl = Number(c.costPerLead) || 0;
    if (paidAvgCpl > 0 && cpl > 0 && cpl <= paidAvgCpl * PD_WINNER_MULT) {
      cards.push({
        priority: 5,
        tone: "watch",
        icon: "👀",
        head: `אות מוקדם: ${c.channel}`,
        body: `${esc(c.channel)}: <b>${fmtIls(cpl)}</b> לליד — נראה טוב, אבל על בסיס מעט מדי דאטה.`,
        sample: sampleText(c),
        tip: `<b>אל תגדיל תקציב עדיין.</b> המשך לאסוף דאטה עוד 1-2 שבועות. רק אחרי ${PD_ROBUST_LEADS}+ לידים + ${PD_ROBUST_SCHEDULED}+ תיאומים ניתן להחליט בביטחון אם להרחיב.`,
      });
    }
  });

  /* Empty-state — owner asked for a "all clear" green card when nothing
   * fires (otherwise the section just disappears and looks like a bug). */
  if (cards.length === 0 && paidLeads >= PD_DIR_LEADS) {
    cards.push({
      priority: 100,
      tone: "good",
      icon: "✅",
      head: "מדיה בתשלום נראית מאוזנת",
      body: "אין אזהרות פעילות — אין ערוץ מבוזבז תקציב, אין חריג CPL, ואין ריכוז-יתר בערוץ אחד.",
      tip: "המשך לנטר. לתובנות איכותיות על קריאייטיב/טירגוט — הסתכל בסיכום ה-AI למטה.",
    });
  }

  cards.sort((a, b) => a.priority - b.priority);
  return cards;
}
