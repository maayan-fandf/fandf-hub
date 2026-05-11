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
 *   creative-mismatch       Cross-source: when a paid-media channel
 *                           has a low scheduled rate (<10%) AND one
 *                           objection dominates (≥35% of its
 *                           objection-attributed leads) AND the
 *                           objection points to a creative-fixable
 *                           dimension (price / location / size /
 *                           handover / deal-type / availability), fire
 *                           with a concrete action prompt. The
 *                           dominant objection is read from the CRM
 *                           funnel's objectionBySource (per-person
 *                           view — distributions are trustworthy even
 *                           if absolute counts aren't); the threshold
 *                           checks use ALL CLIENTS counts.
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

  // ── creative-mismatch ───────────────────────────────────────────
  // Cross-reference ALL CLIENTS (channel × leads × scheduled) with
  // the CRM funnel's per-source objection breakdown. Fire when a
  // paid-media channel under-converts AND a creative-fixable
  // objection (price / location / size / handover / etc.) dominates
  // that channel's objection-attributed leads. The action prompt
  // points the user at the specific dimension to review.
  //
  // Channel-name matching is fuzzy by design: ALL CLIENTS uses
  // "facebook" / "yad2" / "google-discovery" / "פייסבוק" / "כתבה"
  // in any mix, while the CRM workbook normalizes its own way.
  // `canonicalChannel` collapses both sides to a small set of stable
  // keys (facebook, google, yad2, ...) and the per-canonical
  // objection counts are summed across all matching CRM sources.
  if (funnel) {
    // Build {canonicalChannel → {objection → totalCount}} from the
    // CRM funnel's full objection × source matrix. Sources that don't
    // canonicalize to a paid-media key (e.g. "פניה טלפונית", "אתר
    // חברה") are dropped — those have no creative to review.
    const objectionsByCanonical = new Map<string, Map<string, number>>();
    for (const [objection, srcMap] of Object.entries(funnel.sourceMatrices.objectionBySource)) {
      for (const [source, count] of Object.entries(srcMap)) {
        const can = canonicalChannel(source);
        if (!can) continue;
        let m = objectionsByCanonical.get(can);
        if (!m) { m = new Map(); objectionsByCanonical.set(can, m); }
        m.set(objection, (m.get(objection) || 0) + count);
      }
    }
    for (const row of allClients) {
      if (row.leads < 10) continue;
      const can = canonicalChannel(row.channel);
      if (!can) continue; // skip non-paid channels (phone / website / etc.)
      const schedRate = row.leads > 0 ? row.scheduled / row.leads : 0;
      if (schedRate >= 0.10) continue; // not under-converting
      const objMap = objectionsByCanonical.get(can);
      if (!objMap || objMap.size === 0) continue;
      const total = [...objMap.values()].reduce((a, b) => a + b, 0);
      // Min 10 total objection-attributed leads guards against small-
      // sample noise: a single objection in a 3-lead bucket isn't a
      // signal even if it's 100% of the sample.
      if (total < 10) continue;
      const sorted = [...objMap.entries()].sort((a, b) => b[1] - a[1]);
      const [topObj, topCount] = sorted[0];
      const topShare = topCount / total;
      // 25% dominance threshold — calibrated against live data
      // (probe-creative-mismatch-firing.mjs, 2026-05-11). Real
      // objection distributions tend to be long-tailed; the top
      // objection rarely clears 30% even when it's clearly the
      // creative-fixable culprit. Tune up if alerts feel noisy.
      if (topShare < 0.25) continue;
      const action = objectionActionPrompt(topObj, row.channel);
      if (!action) continue; // dominant objection doesn't map to a creative fix
      out.push({
        kind: "creative-mismatch",
        severity: row.leads >= 30 ? "severe" : "warn",
        title: `${row.channel} — ${topObj} דומיננטי, יחס תיאום נמוך`,
        detail:
          `${row.leads} לידים · ${row.scheduled} תיאומים (${(schedRate * 100).toFixed(0)}%) · ` +
          `${topCount} מתוך ${total} התנגדויות (${(topShare * 100).toFixed(0)}%) הן "${topObj}". ` +
          action,
        channel: row.channel,
        key: `${projectSlug}|creative-mismatch|${row.channel}|${topObj}`,
      });
    }
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

/**
 * Collapse a free-form channel / source name (ALL CLIENTS' `מזהה BMBY`
 * OR a CRM workbook source like "facebook-teaser" / "יד 2") to a small
 * set of canonical paid-media keys. Returns null for non-paid sources
 * (phone, own website, billboard, personal contact) — those have no
 * creative to fix and shouldn't trigger the creative-mismatch alert.
 *
 * Patterns intentionally generous on the matching side (lots of Hebrew
 * + English variants for each channel) but conservative on the
 * canonical side (10-ish keys total). Adding a new paid channel here
 * is the only edit needed to surface it in the alert.
 */
function canonicalChannel(name: string): string | null {
  const n = String(name || "").toLowerCase().trim();
  if (!n) return null;
  if (/(?:^|[-_\s])(?:google|גוגל)[\s\-_].*(?:discover|דיסקובר|דיסקאברי)/.test(n)) return "google-discovery";
  if (/(?:^|[-_\s])(?:google|גוגל).*(?:search|חיפוש|seach)/.test(n)) return "google-search";
  if (/(?:^|[-_\s])(?:google|גוגל|goolge|pmax|dv360|gs)(?:$|[-_\s])/.test(n)) return "google";
  if (/(?:^|[-_\s])(?:google|גוגל)/.test(n)) return "google";
  if (/(?:^|[-_\s])(?:facebook|פייסבוק|fb|meta|מטא)(?:$|[-_\s])/.test(n)) return "facebook";
  if (/(?:^|[-_\s])(?:instagram|אינסטגרם|ig)(?:$|[-_\s])/.test(n)) return "instagram";
  if (/(?:^|[-_\s])(?:tiktok|טיקטוק)/.test(n)) return "tiktok";
  if (/(?:^|[-_\s])(?:youtube|יוטיוב|yt)(?:$|[-_\s])/.test(n)) return "youtube";
  if (/(?:^|[-_\s])(?:yad\s?2|יד\s?2)(?:$|[-_\s])/.test(n)) return "yad2";
  if (/(?:^|[-_\s])(?:madlan|מדלן)|(?:^|[-_\s])(?:נדלן)(?:$|[-_\s])/.test(n)) return "madlan";
  if (/(?:^|[-_\s])(?:onmap|אונמפ)(?:$|[-_\s])/.test(n)) return "onmap";
  if (/(?:^|[-_\s])(?:outbrain|אאוטבריין)/.test(n)) return "outbrain";
  if (/(?:^|[-_\s])(?:taboola|טאבולה)/.test(n)) return "taboola";
  // Press/article placements — paid PR is creative-reviewable.
  if (/(?:^|[-_\s])(?:כתבה|article|ynet|walla|mako|jerusalempost|haaretz|הארץ|globes|גלובס)/.test(n)) return "article";
  if (/(?:^|[-_\s])(?:landing|lp)(?:$|[-_\s])|(?:דף|עמוד)\s?נחיתה/.test(n)) return "landing";
  return null;
}

/**
 * Map a dominant objection string to a concrete creative-review
 * action prompt. Returns null when the objection doesn't map to
 * something the creative team can actually fix (e.g. "לא רציני" /
 * "טוענים שלא התעניינו" — those are sales-process classifications,
 * not creative misrepresentations).
 *
 * Patterns are positive-list only — silence is the right behavior
 * when the objection is sales-side noise rather than creative
 * mismatch. Add patterns over time as new recurring objections
 * surface in the data.
 */
function objectionActionPrompt(objection: string, channel: string): string | null {
  const o = String(objection || "").toLowerCase();
  if (!o) return null;
  if (/תקציב|יקר|מחיר|עולה|expensive|price/.test(o)) {
    return `בדוק את המחיר המפורסם ב-${channel}.`;
  }
  if (/שטח|חדרים|גודל|מ"ר|מטר/.test(o)) {
    return `בדוק את מספר החדרים / השטח המופיע ב-${channel}.`;
  }
  if (/מסירה|מועד|תאריך\s?מסירה/.test(o)) {
    return `בדוק את מועד המסירה המפורסם ב-${channel}.`;
  }
  if (/אין\s?במלאי|מלאי|זמינות|אזל/.test(o)) {
    return `בדוק את הזמינות / היצע הדירות המוצג ב-${channel}.`;
  }
  if (/מיקום|רחוק|קרבה(?!\s?אישי)/.test(o)) {
    return `בדוק את המיקום המוצג ב-${channel}.`;
  }
  if (/להשכרה|לרכישה|מכירה(?!\s?ל)|השכרה/.test(o)) {
    return `בדוק את סוג העסקה המפורסם ב-${channel}.`;
  }
  // Generic fallback — flagged when an objection is dominant but
  // doesn't match any specific creative-fix pattern. Stays quiet for
  // sales-process objections ("לא רציני" etc.) per the early-return
  // checks below.
  if (/לא\s?רציני|לא\s?התעניין|לא\s?ציין|השהיית|דחיית|תקופת/.test(o)) {
    return null;
  }
  return `בדוק את המודעות ב-${channel} — לידים מתלוננים על: "${objection}".`;
}
