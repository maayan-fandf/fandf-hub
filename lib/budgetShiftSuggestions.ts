import {
  E3_PLATFORMS,
  type BudgetProject,
  type Platform,
} from "@/lib/budgetTypes";
import type { AllClientsRow } from "@/lib/allClients";

/**
 * Budget-shift suggestions for the budget desk (/morning/budgets) —
 * "which channels should give up budget, which should receive it",
 * scored from cost-per-lead / cost-per-scheduled / conversion with
 * Bayesian shrinkage and a trailing-90-day history blend.
 *
 * This is a PORT of the dashboard iframe's reallocation engine and
 * MUST stay logic-identical to client-dashboard/Index.html:
 *   computeChannelScores   (#L8910)
 *   computeAllocation      (#L9055)
 *   computeRebalance       (#L9143)
 *   _suggestionRationale   (#L9214)
 *   costStyle              (#L6106)
 * (precedent: E3_PLATFORMS + channelAlias are kept byte-identical
 * across the two repos so both surfaces always agree). When tuning
 * weights/thresholds, change BOTH sides in the same deploy.
 *
 * Input mapping (iframe → hub):
 *   p.channels        → ALL CLIENTS "current" rows for the slug,
 *                       consolidated by lowercase channel (the same
 *                       consolidation Code.js getProjectsData runs).
 *   p.monthlyRaw      → ALL CLIENTS "חודשי" rows for the slug; month
 *                       key = startIso.slice(0,7) (Code.js#L2218
 *                       monthFromDate(row[iStart])).
 *   summary.channels  → BudgetProject.rows (the column-G side).
 *   sum.e3 / sum.delta → BudgetProject.e3 / .delta.
 *
 * Pure module — no server-only imports — so a tsx probe script can
 * load it directly (like budgetTypes.ts).
 */

export type ShiftChannelScore = {
  /** Display channel name (first-seen casing from ALL CLIENTS). */
  channel: string;
  platform: Platform | "other";
  /** Merged budget-sheet sub-rows for this channel (1 when single). */
  subRowCount: number;
  eligible: boolean;
  /** Composite: .35·cpl + .25·cps + .20·conv + .20·headroom + .10·trend. */
  score: number;
  cplScore: number;
  cpsScore: number;
  convScore: number;
  headroomRaw: number;
  trendScore: number;
  trailingLeads: number;
  /** Column-G allocation (Σ across merged sub-rows). */
  currentBudget: number;
  currentSpend: number;
  /** Current-window cost metrics (ALL CLIENTS side) for the UI chips. */
  cpl: number;
  cps: number;
  cpm: number;
  leads: number;
  sched: number;
  meetings: number;
};

export type BudgetShiftSuggestion = {
  channel: string;
  platform: Platform | "other";
  /** Signed ₪ move (positive = add budget, negative = cut). */
  delta: number;
  currentBudget: number;
  newBudget: number;
  /** Hebrew rationale (same strings as the iframe panel). */
  reason: string;
  /** Drift-mode fallback (no strongly-directional candidate). */
  fallback: boolean;
  cpl: number;
  cps: number;
  cpm: number;
};

export type ProjectBudgetShift = {
  slug: string;
  /** "drift" = corrective (closes the E3↔allocated gap);
   *  "rebalance" = advisory net-zero ROI shift on a synced budget. */
  mode: "drift" | "rebalance";
  /** Project delta (allocated − e3) at compute time — drives the
   *  headline direction (הוספה/הפחתה). */
  delta: number;
  /** Drift: Σ|delta| (one-way gap size). Rebalance: Σ positive deltas
   *  (the amount moved in either direction). Same as the iframe head. */
  totalMove: number;
  suggestions: BudgetShiftSuggestion[];
};

/* ── verbatim ports of the iframe helpers ───────────────────────── */

/** Index.html _bayesianShrunk (#L8870). */
function bayesianShrunk(
  value: number,
  baseline: number,
  n: number,
  priorN: number,
): number {
  if (!isFinite(value) || value <= 0) return baseline;
  if (!isFinite(baseline) || baseline <= 0) return value;
  const pN = priorN > 0 ? priorN : 5;
  return (value * n + baseline * pN) / (n + pN);
}

/** Index.html _projectMedian (#L8876). */
function projectMedian(values: number[]): number {
  const arr = values
    .filter((v) => isFinite(v) && v > 0)
    .slice()
    .sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

type TrailingAgg = { spend: number; leads: number; sched: number; meet: number };

/**
 * Index.html _trailingMonthsByChannel (#L8887). Aggregates the חודשי
 * rows to per-channel totals over the trailing N calendar months
 * (cutoff anchored to month start, current partial month included).
 * `todayIso` is a param (not new Date()) so the lib stays pure.
 */
function trailingMonthsByChannel(
  monthly: AllClientsRow[],
  monthsBack: number,
  todayIso: string,
): Record<string, TrailingAgg> {
  const out: Record<string, TrailingAgg> = {};
  if (!monthly.length) return out;
  const y = Number(todayIso.slice(0, 4));
  const m = Number(todayIso.slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return out;
  // new Date(y, m-1-monthsBack, 1) semantics — JS Date normalizes
  // negative months, replicated arithmetically.
  const total = y * 12 + (m - 1) - monthsBack;
  const cy = Math.floor(total / 12);
  const cm = ((total % 12) + 12) % 12;
  const cutoffKey = `${cy}-${String(cm + 1).padStart(2, "0")}`;
  for (const r of monthly) {
    const month = r.startIso.slice(0, 7);
    if (!month || month < cutoffKey) continue;
    const ch = String(r.channel || "—");
    if (!out[ch]) out[ch] = { spend: 0, leads: 0, sched: 0, meet: 0 };
    out[ch].spend += r.spend || 0;
    out[ch].leads += r.leads || 0;
    out[ch].sched += r.scheduled || 0;
    out[ch].meet += r.meetings || 0;
  }
  return out;
}

/* ── scoring (Index.html computeChannelScores #L8910) ───────────── */

type SummaryAgg = {
  channel: string;
  platform: Platform | "other";
  budget: number;
  spend: number;
  ended: boolean;
  subRowCount: number;
};

function computeChannelScores(
  project: BudgetProject,
  currentRows: AllClientsRow[],
  monthlyRows: AllClientsRow[],
  todayIso: string,
): ShiftChannelScore[] {
  // Pair each performance channel with its column-G allocation; channels
  // split across multiple merged sub-rows on the sheet sum their budgets
  // + spend so the scorer sees the full channel total. ended is true
  // only if EVERY sub-row has ended.
  const summaryByChannel: Record<string, SummaryAgg> = {};
  for (const r of project.rows) {
    const k = String(r.channel || "").toLowerCase().trim();
    if (!k) continue;
    const agg = summaryByChannel[k];
    if (!agg) {
      summaryByChannel[k] = {
        channel: r.channel,
        platform: r.platform,
        budget: r.budget || 0,
        spend: r.spend || 0,
        ended: !!r.ended,
        subRowCount: 1,
      };
    } else {
      agg.budget += r.budget || 0;
      agg.spend += r.spend || 0;
      agg.ended = agg.ended && !!r.ended;
      agg.subRowCount += 1;
    }
  }

  const trailing = trailingMonthsByChannel(monthlyRows, 3, todayIso);

  // Project-wide medians of CURRENT-period metrics — the benchmark each
  // channel is compared against (NOT portfolio benchmarks; per-project,
  // exactly like the iframe).
  const medianCPL = projectMedian(
    currentRows.map((c) => (c.leads > 0 ? c.spend / c.leads : 0)),
  );
  const medianCPS = projectMedian(
    currentRows.map((c) => (c.scheduled > 0 ? c.spend / c.scheduled : 0)),
  );
  const medianConv = projectMedian(
    currentRows.map((c) => (c.leads > 0 ? c.scheduled / c.leads : 0)),
  );

  return currentRows.map((c) => {
    const channelLc = String(c.channel || "").toLowerCase().trim();
    const sumRow = summaryByChannel[channelLc] || null;
    const leads = c.leads || 0;
    const sched = c.scheduled || 0;
    const meetings = c.meetings || 0;
    const cpl = leads > 0 ? c.spend / leads : 0;
    const cps = sched > 0 ? c.spend / sched : 0;
    const cpm = meetings > 0 ? c.spend / meetings : 0;
    const conv = leads > 0 ? sched / leads : 0;
    // Trailing-90-day metrics for the same channel (when present).
    const tr =
      trailing[c.channel] || trailing[String(c.channel || "").trim()] || null;
    const trLeads = tr ? tr.leads : 0;
    const trSched = tr ? tr.sched : 0;
    const trCpl = tr && trLeads > 0 ? tr.spend / trLeads : 0;
    const trCps = tr && trSched > 0 ? tr.spend / trSched : 0;
    const trConv = trLeads > 0 ? trSched / trLeads : 0;
    // Bayesian-shrunk CURRENT metrics — low-volume channels pulled to median.
    const cplShrunk = bayesianShrunk(cpl, medianCPL, leads, 5);
    const cpsShrunk = bayesianShrunk(cps, medianCPS, sched, 5);
    const convShrunk = bayesianShrunk(conv, medianConv, leads, 5);
    // Per-metric scores from CURRENT period (normalized vs median).
    const cplScoreCurrent = medianCPL > 0 ? (medianCPL - cplShrunk) / medianCPL : 0;
    const cpsScoreCurrent = medianCPS > 0 ? (medianCPS - cpsShrunk) / medianCPS : 0;
    const convScoreCurrent =
      medianConv > 0 ? (convShrunk - medianConv) / medianConv : 0;
    // Same scores from TRAILING-90d, confidence-scaled (caps at 10 leads).
    const trConf = Math.min(1, trLeads / 10);
    const cplScoreTrailing =
      trCpl > 0 && medianCPL > 0 ? (medianCPL - trCpl) / medianCPL : 0;
    const cpsScoreTrailing =
      trCps > 0 && medianCPS > 0 ? (medianCPS - trCps) / medianCPS : 0;
    const convScoreTrailing =
      trConv > 0 && medianConv > 0 ? (trConv - medianConv) / medianConv : 0;
    // Blend: 0.65 current + 0.35 trailing × trConf.
    const blend = (cur: number, prev: number) => 0.65 * cur + 0.35 * trConf * prev;
    const cplScore = blend(cplScoreCurrent, cplScoreTrailing);
    const cpsScore = blend(cpsScoreCurrent, cpsScoreTrailing);
    const convScore = blend(convScoreCurrent, convScoreTrailing);
    // Trend signal — current CPL vs trailing CPL (penalty for recent
    // degradation, small bonus for improvement).
    let trendScore = 0;
    if (trCpl > 0 && cpl > 0 && trLeads >= 5) {
      const trendPct = (cpl - trCpl) / trCpl;
      trendScore = Math.max(-0.3, Math.min(0.2, -trendPct));
    }
    // Headroom: room before this channel is overpacing. Gated on the
    // channel having a קצב יומי (dailyRate) — identical to the iframe.
    const budget = sumRow ? sumRow.budget : c.budget || 0;
    const spend = sumRow ? sumRow.spend : c.spend || 0;
    const dailyRate = c.dailyRate || 0;
    const headroomRaw =
      dailyRate > 0 ? Math.max(-1, 1 - spend / Math.max(budget, 1)) : 0;
    const score =
      0.35 * cplScore +
      0.25 * cpsScore +
      0.2 * convScore +
      0.2 * headroomRaw +
      0.1 * trendScore;
    // Eligibility: current ≥3 leads OR trailing ≥10 (quiet-this-month
    // channels with proven history still participate).
    const enoughVolume = leads >= 3 || trLeads >= 10;
    const isEnded = sumRow ? sumRow.ended : false;
    const eligible = enoughVolume && !isEnded && !!sumRow && budget > 0;
    const platform: Platform | "other" = sumRow ? sumRow.platform : "other";
    const subRowCount = sumRow ? sumRow.subRowCount : 1;
    return {
      channel: c.channel,
      platform,
      subRowCount,
      eligible,
      score,
      cplScore,
      cpsScore,
      convScore,
      headroomRaw,
      trendScore,
      trailingLeads: trLeads,
      currentBudget: budget,
      currentSpend: spend,
      cpl,
      cps,
      cpm,
      leads,
      sched,
      meetings,
    };
  });
}

/* ── allocation (Index.html computeAllocation #L9055) ───────────── */

type RawSuggestion = { scoreRow: ShiftChannelScore; delta: number; fallback?: boolean };

function computeAllocation(
  scored: ShiftChannelScore[],
  drift: number,
): RawSuggestion[] {
  // drift > 0 means OVER-allocated — SUBTRACT |drift|; < 0 means ADD.
  const amount = Math.abs(drift);
  if (amount < 100) return []; // ignore drifts under ₪100
  const cuts = drift > 0;
  let candidates = scored.filter((s) => {
    if (!s.eligible) return false;
    // Programmatic-only: never move budget into/out of fixed monthly lines.
    if (!(E3_PLATFORMS as string[]).includes(s.platform)) return false;
    return cuts ? s.score < 0 : s.score > 0;
  });
  // Fallback when no strongly-directional candidate exists: concentrate
  // the full drift on the single weakest/strongest eligible programmatic
  // channel (30% cap) — a gap is a gap, something has to absorb it.
  let isFallback = false;
  if (candidates.length === 0) {
    const elig = scored.filter(
      (s) => s.eligible && (E3_PLATFORMS as string[]).includes(s.platform),
    );
    if (!elig.length) return [];
    elig.sort((a, b) => (cuts ? a.score - b.score : b.score - a.score));
    candidates = [elig[0]];
    isFallback = true;
  }
  if (isFallback) {
    const s = candidates[0];
    const direction = cuts ? -1 : 1;
    const cap = s.currentBudget * 0.3;
    const raw = Math.min(amount, cap);
    const delta = Math.round((raw * direction) / 100) * 100;
    if (Math.abs(delta) < 100) return [];
    return [{ scoreRow: s, delta, fallback: true }];
  }
  // Weighting per direction:
  //   under-allocated: score × inverse_CPL × max(0.05, headroom)
  //   over-allocated:  −score × max(CPL, 100)
  const weights = candidates.map((s) => {
    if (cuts) return Math.max(0.001, -s.score) * Math.max(s.cpl, 100);
    const hr = Math.max(0.05, s.headroomRaw);
    const invCpl = s.cpl > 0 ? 1 / s.cpl : 1 / 1000;
    return Math.max(0.001, s.score) * invCpl * hr * 1000;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  // Per-channel ±30% cap; round to ₪100; drop tiny moves.
  return candidates
    .map((s, i) => {
      const share = (weights[i] / total) * amount;
      const cap = s.currentBudget * 0.3;
      const raw = Math.min(share, cap);
      const direction = cuts ? -1 : 1;
      return { scoreRow: s, delta: Math.round((raw * direction) / 100) * 100 };
    })
    .filter((sg) => Math.abs(sg.delta) >= 100);
}

/* ── rebalance (Index.html computeRebalance #L9143) ─────────────── */

function computeRebalance(scored: ShiftChannelScore[]): RawSuggestion[] {
  const elig = scored.filter(
    (s) => s.eligible && (E3_PLATFORMS as string[]).includes(s.platform),
  );
  const cuts = elig.filter((s) => s.score <= -0.2);
  const boosts = elig.filter((s) => s.score >= 0.2 && s.headroomRaw > 0);
  if (!cuts.length || !boosts.length) return [];
  const CAP_PCT = 0.15;
  const MIN_TOTAL = 500;
  // Capacity-constrained: total moved = min(side capacities).
  const cutCap = cuts.reduce((a, s) => a + s.currentBudget * CAP_PCT, 0);
  const boostCap = boosts.reduce((a, s) => a + s.currentBudget * CAP_PCT, 0);
  const amount = Math.min(cutCap, boostCap);
  if (amount < MIN_TOTAL) return [];
  const cutWeights = cuts.map(
    (s) => Math.max(0.001, -s.score) * Math.max(s.cpl, 100),
  );
  const cutTotal = cutWeights.reduce((a, b) => a + b, 0);
  const boostWeights = boosts.map((s) => {
    const hr = Math.max(0.05, s.headroomRaw);
    const invCpl = s.cpl > 0 ? 1 / s.cpl : 1 / 1000;
    return Math.max(0.001, s.score) * invCpl * hr * 1000;
  });
  const boostTotal = boostWeights.reduce((a, b) => a + b, 0);
  if (cutTotal <= 0 || boostTotal <= 0) return [];
  const sgCuts = cuts.map((s, i) => {
    const share = (cutWeights[i] / cutTotal) * amount;
    const raw = Math.min(share, s.currentBudget * CAP_PCT);
    return { scoreRow: s, rawDelta: -raw };
  });
  const sgBoosts = boosts.map((s, i) => {
    const share = (boostWeights[i] / boostTotal) * amount;
    const raw = Math.min(share, s.currentBudget * CAP_PCT);
    return { scoreRow: s, rawDelta: raw };
  });
  const all: RawSuggestion[] = sgCuts
    .concat(sgBoosts)
    .map((sg) => ({
      scoreRow: sg.scoreRow,
      delta: Math.round(sg.rawDelta / 100) * 100,
    }))
    .filter((sg) => Math.abs(sg.delta) >= 100);
  if (!all.length) return [];
  // Net-zero clamp: absorb the rounding residual onto the largest move
  // on the opposite side (residual < ₪100 is left alone).
  const net = all.reduce((a, sg) => a + sg.delta, 0);
  if (Math.abs(net) >= 100) {
    const adjustSide = net > 0 ? -1 : 1;
    let target: RawSuggestion | null = null;
    for (const sg of all) {
      if (Math.sign(sg.delta) === adjustSide) {
        if (!target || Math.abs(sg.delta) > Math.abs(target.delta)) target = sg;
      }
    }
    if (target) target.delta -= net;
  }
  return all;
}

/* ── rationale (Index.html _suggestionRationale #L9214) ─────────── */

function suggestionRationale(s: ShiftChannelScore, delta: number): string {
  const reasons: string[] = [];
  if (s.cplScore > 0.15)
    reasons.push("עלות לליד נמוכה ב-" + Math.round(s.cplScore * 100) + "% מהממוצע");
  if (s.cplScore < -0.15)
    reasons.push("עלות לליד גבוהה ב-" + Math.round(-s.cplScore * 100) + "%");
  if (s.cpsScore > 0.15)
    reasons.push("עלות לתיאום נמוכה ב-" + Math.round(s.cpsScore * 100) + "%");
  if (s.cpsScore < -0.15)
    reasons.push("עלות לתיאום גבוהה ב-" + Math.round(-s.cpsScore * 100) + "%");
  if (s.convScore > 0.15) reasons.push("המרה גבוהה לתיאומים");
  if (s.convScore < -0.15) reasons.push("המרה נמוכה לתיאומים");
  if (s.trendScore > 0.05) reasons.push("שיפור מול 90 הימים האחרונים");
  if (s.trendScore < -0.1) reasons.push("הידרדרות מול 90 הימים האחרונים");
  if (delta > 0 && s.headroomRaw > 0.1) reasons.push("יש מקום לגדול");
  if (delta < 0 && s.headroomRaw < -0.05) reasons.push("הוצאה מואצת מהתכנון");
  if (!reasons.length && s.trailingLeads >= 10)
    reasons.push("ע״פ ביצועי 90 הימים האחרונים");
  return reasons.length ? reasons.join(" · ") : "ע״פ ביצועי הערוץ";
}

/** Fallback-mode rationale (drift, single weakest/strongest channel). */
const FALLBACK_REASON_CUT =
  "הערוץ הכי פחות חזק מבין הפרוגרמטיים — להפחית כדי לסגור את הפער";
const FALLBACK_REASON_BOOST =
  "הערוץ החזק ביותר מבין הפרוגרמטיים — להגדיל כדי לסגור את הפער";

/* ── public API ──────────────────────────────────────────────────── */

/**
 * Group ALL CLIENTS rows by lowercase projectSlug, splitting into
 * consolidated "current" rows (one per channel — same numeric-sum
 * consolidation getAllClientsCurrentForProject runs) and raw חודשי
 * rows. Rows without a slug can't join the budget desk (its projects
 * key on tab == slug) and are skipped.
 */
export function groupAllClientsBySlug(
  rows: AllClientsRow[],
): Map<string, { current: AllClientsRow[]; monthly: AllClientsRow[] }> {
  const out = new Map<
    string,
    { current: AllClientsRow[]; monthly: AllClientsRow[] }
  >();
  const currentByChannel = new Map<string, Map<string, AllClientsRow>>();
  for (const r of rows) {
    const slug = r.projectSlug.toLowerCase().trim();
    if (!slug) continue;
    let g = out.get(slug);
    if (!g) {
      g = { current: [], monthly: [] };
      out.set(slug, g);
    }
    if (r.rowType === "חודשי") {
      g.monthly.push(r);
      continue;
    }
    if (r.rowType !== "current") continue;
    let byCh = currentByChannel.get(slug);
    if (!byCh) {
      byCh = new Map<string, AllClientsRow>();
      currentByChannel.set(slug, byCh);
    }
    const key = r.channel.toLowerCase();
    const existing = byCh.get(key);
    if (!existing) {
      const copy = { ...r };
      byCh.set(key, copy);
      g.current.push(copy);
    } else {
      existing.spend += r.spend;
      existing.budget += r.budget;
      existing.leads += r.leads;
      existing.scheduled += r.scheduled;
      existing.meetings += r.meetings;
      existing.dailyRate += r.dailyRate;
      if (!existing.startIso && r.startIso) existing.startIso = r.startIso;
      if (r.endIso && r.endIso > existing.endIso) existing.endIso = r.endIso;
    }
  }
  return out;
}

/**
 * Compute the budget-shift suggestion set for one project. Mirrors the
 * iframe's renderBudgetStripBody flow (#L9253): drift-driven first
 * (corrective), falling through to balanced rebalance (advisory) when
 * drift produced nothing. Null when there's nothing to suggest.
 */
export function computeBudgetShiftForProject(args: {
  project: BudgetProject;
  currentRows: AllClientsRow[];
  monthlyRows: AllClientsRow[];
  /** Asia/Jerusalem YYYY-MM-DD (the page already computes it). */
  todayIso: string;
}): ProjectBudgetShift | null {
  const { project, currentRows, monthlyRows, todayIso } = args;
  if (!(project.e3 > 0)) return null;
  if (!currentRows.length) return null;
  const scored = computeChannelScores(
    project,
    currentRows,
    monthlyRows,
    todayIso,
  );
  const driftAbs = Math.abs(project.delta || 0);
  const driftSuggestions =
    driftAbs >= 100 ? computeAllocation(scored, project.delta) : [];
  const rebalanceSuggestions = !driftSuggestions.length
    ? computeRebalance(scored)
    : [];
  const isRebalance =
    !driftSuggestions.length && rebalanceSuggestions.length > 0;
  const raw = driftSuggestions.length ? driftSuggestions : rebalanceSuggestions;
  if (!raw.length) return null;
  const suggestions: BudgetShiftSuggestion[] = raw.map((sg) => {
    const s = sg.scoreRow;
    return {
      channel: s.channel,
      platform: s.platform,
      delta: sg.delta,
      currentBudget: s.currentBudget,
      newBudget: s.currentBudget + sg.delta,
      reason: sg.fallback
        ? sg.delta < 0
          ? FALLBACK_REASON_CUT
          : FALLBACK_REASON_BOOST
        : suggestionRationale(s, sg.delta),
      fallback: !!sg.fallback,
      cpl: s.cpl,
      cps: s.cps,
      cpm: s.cpm,
    };
  });
  // Headline amount — iframe renderBudgetStripBody: rebalance reports
  // the one-way amount (cuts and boosts split the same total); drift
  // reports Σ|delta|.
  const movedOneWay = suggestions
    .filter((sg) => sg.delta > 0)
    .reduce((a, x) => a + x.delta, 0);
  const totalMove = isRebalance
    ? movedOneWay
    : suggestions.reduce((a, x) => a + Math.abs(x.delta), 0);
  return {
    slug: project.tab,
    mode: isRebalance ? "rebalance" : "drift",
    delta: project.delta,
    totalMove,
    suggestions,
  };
}

/**
 * Cost-chip coloring — port of the iframe's costStyle (#L6106): smooth
 * green→red HSL gradient over the metric's expected range. Null for
 * zero/invalid values (caller omits the chip).
 */
export function costChipStyle(
  metric: "cpl" | "cps" | "cpm",
  value: number,
): { bg: string; fg: string } | null {
  const v = Number(value) || 0;
  if (v <= 0) return null;
  let lo: number, hi: number;
  if (metric === "cpl") {
    lo = 150;
    hi = 700;
  } else if (metric === "cps") {
    lo = 1500;
    hi = 4500;
  } else {
    lo = 4000;
    hi = 12000;
  }
  let t = (v - lo) / (hi - lo);
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  const hue = Math.round(140 - t * 140);
  return { bg: `hsl(${hue},70%,88%)`, fg: `hsl(${hue},70%,26%)` };
}

/** Export the scorer for the parity probe (scripts/probe-budget-shift.ts). */
export { computeChannelScores as _computeChannelScoresForProbe };
