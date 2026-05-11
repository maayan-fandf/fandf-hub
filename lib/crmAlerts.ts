/**
 * CRM-funnel-aware alert generator. Reads the per-project CrmFunnel
 * (lib/crmData.ts) and emits MorningSignal entries that the project
 * page's alerts section can merge alongside the Apps-Script-backed
 * dashboard signals (getMorningFeed).
 *
 * Why these live here, not in Apps Script: the consolidated CRM data
 * (BMBY + Sehel) lives in a workbook the dashboard's Apps Script
 * doesn't read. Re-wiring the dashboard to read it would duplicate the
 * CRM library; running these alerts on the hub side reuses the
 * existing crmData.ts code path with zero extra IO (the funnel is
 * already cached for the page's CRM card).
 *
 * Signals emitted so far:
 *
 *   meeting-noshow-spike    when (scheduled − held) / scheduled ≥ 30%.
 *                           Surfaces the gap between "we got commitment"
 *                           and "they actually showed up." Either the
 *                           client's scheduling discipline broke, or
 *                           the salespeople are over-promising.
 *
 *   source-converts-poorly  when a source produces ≥10 leads in the
 *                           filtered cohort but zero scheduled meetings.
 *                           Signals dead-weight channel spend — pull
 *                           budget or change targeting.
 *
 *   stale-leads             when ≥5 leads have been sitting in an
 *                           early-funnel stage (pre-נקבעה פגישה for
 *                           BMBY, pre-לקראת פגישה for Sehel) for more
 *                           than 14 days. Surfaces sales-team
 *                           follow-up gaps that the cost-per-result
 *                           signals would never catch.
 *
 * Caveat: hub-side signals don't have a snooze/dismissal flow today
 * (the dashboard's dismissal sheet wouldn't recognize the keys). For
 * v1 they re-fire each request. Acceptable since they're cohort-based
 * and slow-moving — daily inspection is the natural cadence.
 */

import type { MorningSignal } from "@/lib/appsScript";
import type { CrmFunnel } from "@/lib/crmData";

/**
 * Generate hub-side alerts from a project's CrmFunnel snapshot. Returns
 * an empty array when no funnel data is available (project lacks a
 * Keys.CRM mapping, or the filtered cohort is empty).
 *
 * `projectSlug` should be a stable identifier — used in the alert key
 * so dismissal infrastructure (when we add it later) can match across
 * re-renders. The page already has this; threading it in keeps the
 * mapping explicit.
 */
export function computeCrmAlerts(args: {
  funnel: CrmFunnel | null;
  projectSlug: string;
}): MorningSignal[] {
  const { funnel, projectSlug } = args;
  if (!funnel) return [];
  const out: MorningSignal[] = [];

  // ── meeting-noshow-spike ────────────────────────────────────────
  // Gap between scheduled (תואמה פגישה) and held (פגישות). If a sizable
  // fraction of scheduled meetings aren't converting to held, surface
  // it. Need a meaningful base (≥5 scheduled) to avoid noise on tiny
  // numbers — one cancellation out of 3 isn't actionable.
  if (funnel.scheduledMeetings >= 5) {
    const gap = funnel.scheduledMeetings - funnel.meetings;
    const gapRatio = gap / funnel.scheduledMeetings;
    if (gapRatio >= 0.30) {
      const gapPct = (gapRatio * 100).toFixed(0);
      out.push({
        kind: "meeting-noshow-spike",
        severity: gapRatio >= 0.50 ? "severe" : "warn",
        title: "פער פגישות גבוה — תיאומים שלא התקיימו",
        detail:
          `${funnel.scheduledMeetings} תיאומים · ${funnel.meetings} פגישות התקיימו · ` +
          `פער ${gap} (${gapPct}%). בדוק ביטולים / no-shows מול הלקוח או צוות המכירות.`,
        key: `${projectSlug}|meeting-noshow-spike|${funnel.platform}|${funnel.monthFilter || "all"}`,
      });
    }
  }

  // ── source-converts-poorly ──────────────────────────────────────
  // TODO (Maayan 2026-05-11): redirect this to read from the ALL
  // CLIENTS sheet instead. The CRM workbook used here is a per-person
  // view; ALL CLIENTS aggregates status-per-media-source at the
  // project level and is more reliable for alert thresholds. Tracked
  // as a spawned task. Until that lands, keeping the per-person
  // approximation so the alert continues to fire.
  //
  // Walks the raw leadsBySource map: any source with ≥10 leads in the
  // cohort AND zero scheduled-meeting contribution is producing dead-
  // weight volume. Raw (untruncated) — no "אחר" rollup to skip.
  const leadsBySource = funnel.sourceMatrices.leadsBySource;
  const scheduledBySource = funnel.sourceMatrices.scheduledMeetingsBySource;
  for (const [source, leadCount] of Object.entries(leadsBySource)) {
    if (leadCount < 10) continue;
    const schedCount = scheduledBySource[source] || 0;
    if (schedCount > 0) continue;
    out.push({
      kind: "source-converts-poorly",
      severity: leadCount >= 30 ? "severe" : "warn",
      title: `${source} — לידים בלי תיאומים`,
      detail:
        `${leadCount} לידים מהמקור הזה · 0 תיאומי פגישה. ` +
        `סביר שזה קהל לא מתאים — שקול להוריד תקציב או לשנות מיקוד.`,
      channel: source,
      key: `${projectSlug}|source-converts-poorly|${source}|${funnel.monthFilter || "all"}`,
    });
  }

  // ── stale-leads ─────────────────────────────────────────────────
  // The CrmFunnel exposes a project-wide stale-leads tally that's
  // computed against ALL the project's rows, not the filtered cohort
  // (deliberately — a lead that hasn't moved in 60 days is stale
  // regardless of which month the user is currently viewing). Fire
  // when ≥5 leads qualify; severity climbs with the worst case
  // (`oldestDays`) AND the total count, whichever is more dramatic.
  if (funnel.staleLeads && funnel.staleLeads.count >= 5) {
    const { count, oldestDays, byStage } = funnel.staleLeads;
    const severity =
      count >= 15 || oldestDays >= 30
        ? "severe"
        : "warn";
    // Build a short stage summary — "טלפון: 8 · בטיפול: 4" — capped to
    // top 3 stages so the alert detail stays scannable.
    const stagesPart = byStage
      .slice(0, 3)
      .map((s) => `${s.stage}: ${s.count}`)
      .join(" · ");
    out.push({
      kind: "stale-leads",
      severity,
      title: `${count} לידים תקועים בשלב מוקדם מעל ${14} ימים`,
      detail:
        (stagesPart ? `${stagesPart} · ` : "") +
        `הוותיק ביותר: ${oldestDays} ימים. שווה לעבור עליהם ולקדם או לדחות.`,
      key: `${projectSlug}|stale-leads|${funnel.platform}`,
    });
  }

  return out;
}
