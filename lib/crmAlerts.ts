/**
 * CRM-funnel-aware alert generator. Emits MorningSignal entries that
 * the project page's alerts section merges alongside the Apps-Script-
 * backed dashboard signals (getMorningFeed).
 *
 * Signals emitted:
 *
 *   meeting-noshow-spike    Project totals from ALL CLIENTS: when
 *                           (scheduled − held) / scheduled ≥ 30%,
 *                           surface the gap between "we got
 *                           commitment" and "they actually showed up."
 *                           Sources from ALL CLIENTS rather than the
 *                           per-person CRM workbook because the
 *                           workbook is a per-person view; ALL CLIENTS
 *                           aggregates status per project at the
 *                           channel level.
 *
 *   source-converts-poorly  Per-channel from ALL CLIENTS: when a
 *                           channel produces ≥10 leads in the project
 *                           window but zero scheduled meetings.
 *                           Signals dead-weight channel spend — pull
 *                           budget or change targeting. Same data
 *                           source rationale as meeting-noshow-spike.
 *
 *   stale-leads             From the per-person CRM funnel: when ≥5
 *                           leads have been sitting in an early-funnel
 *                           stage (pre-נקבעה פגישה for BMBY,
 *                           pre-לקראת פגישה for Sehel) for more than
 *                           14 days. This one legitimately needs the
 *                           per-person view because staleness is a
 *                           per-lead property — ALL CLIENTS doesn't
 *                           expose per-lead status timing.
 *
 * Caveat: hub-side signals don't have a snooze/dismissal flow today.
 * For v1 they re-fire each request. Acceptable since they're slow-
 * moving — daily inspection is the natural cadence.
 */

import type { MorningSignal } from "@/lib/appsScript";
import type { CrmFunnel } from "@/lib/crmData";
import type { AllClientsRow } from "@/lib/allClients";

/**
 * Generate hub-side CRM alerts. Caller pre-fetches both inputs so the
 * function stays synchronous + side-effect-free (mirrors the existing
 * compute pattern in the dashboard's morning-feed builder).
 *
 *   funnel       per-person CRM workbook funnel — used for stale-leads
 *                only. Pass `null` when the project has no Keys.CRM
 *                mapping; the stale-leads branch is skipped.
 *   allClients   "current" rowType rows for this project from ALL
 *                CLIENTS — used for source-converts-poorly +
 *                meeting-noshow-spike. Empty array → those branches
 *                skip cleanly.
 *   projectSlug  Stable identifier for alert dismissal keys.
 */
export function computeCrmAlerts(args: {
  funnel: CrmFunnel | null;
  allClients: AllClientsRow[];
  projectSlug: string;
}): MorningSignal[] {
  const { funnel, allClients, projectSlug } = args;
  const out: MorningSignal[] = [];

  // ── meeting-noshow-spike ────────────────────────────────────────
  // Sum scheduled + meetings across the project's current channel
  // rows. Need a meaningful base (≥5 scheduled) to avoid noise on
  // tiny numbers — one cancellation out of 3 isn't actionable.
  const totalScheduled = allClients.reduce((n, r) => n + r.scheduled, 0);
  const totalMeetings = allClients.reduce((n, r) => n + r.meetings, 0);
  if (totalScheduled >= 5) {
    const gap = totalScheduled - totalMeetings;
    const gapRatio = gap / totalScheduled;
    if (gapRatio >= 0.30) {
      const gapPct = (gapRatio * 100).toFixed(0);
      out.push({
        kind: "meeting-noshow-spike",
        severity: gapRatio >= 0.50 ? "severe" : "warn",
        title: "פער פגישות גבוה — תיאומים שלא התקיימו",
        detail:
          `${totalScheduled} תיאומים · ${totalMeetings} פגישות התקיימו · ` +
          `פער ${gap} (${gapPct}%). בדוק ביטולים / no-shows מול הלקוח או צוות המכירות.`,
        key: `${projectSlug}|meeting-noshow-spike`,
      });
    }
  }

  // ── source-converts-poorly ──────────────────────────────────────
  // Per-channel walk of ALL CLIENTS' current rows. Any channel with
  // ≥10 leads AND zero scheduled meetings is producing dead-weight
  // volume. ALL CLIENTS rows are already pre-aggregated per channel,
  // so this is a flat scan — no rollup needed.
  for (const row of allClients) {
    if (row.leads < 10) continue;
    if (row.scheduled > 0) continue;
    if (!row.channel) continue;
    out.push({
      kind: "source-converts-poorly",
      severity: row.leads >= 30 ? "severe" : "warn",
      title: `${row.channel} — לידים בלי תיאומים`,
      detail:
        `${row.leads} לידים מהמקור הזה · 0 תיאומי פגישה. ` +
        `סביר שזה קהל לא מתאים — שקול להוריד תקציב או לשנות מיקוד.`,
      channel: row.channel,
      key: `${projectSlug}|source-converts-poorly|${row.channel}`,
    });
  }

  // ── stale-leads ─────────────────────────────────────────────────
  // The CrmFunnel exposes a project-wide stale-leads tally that's
  // computed against ALL the project's rows, not the filtered cohort
  // (deliberately — a lead that hasn't moved in 60 days is stale
  // regardless of which month the user is currently viewing). Fire
  // when ≥5 leads qualify; severity climbs with the worst case
  // (`oldestDays`) AND the total count, whichever is more dramatic.
  if (funnel && funnel.staleLeads && funnel.staleLeads.count >= 5) {
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
