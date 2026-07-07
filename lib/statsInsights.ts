/**
 * Pure computations behind the /stats overview layer (2026-07):
 * KPI tiles, auto-generated insight cards, and the consolidated
 * project-comparison table. Everything derives from the already-loaded
 * PortfolioBenchmarks payload — no extra fetches.
 *
 * No React / Next.js imports — usable from client components (where it
 * actually runs) and unit-testable in isolation.
 */

import type {
  BenchmarkSample,
  PortfolioBenchmarks,
} from "@/lib/portfolioBenchmarks";
import {
  meanOf,
  percentile,
  stddevOf,
  twoSidedPValue,
  pearsonR,
  pearsonPValue,
} from "@/lib/statsMath";

export type Metric = "cpl" | "cps" | "cpm";

export const METRIC_LABELS: Record<Metric, string> = {
  cpl: "עלות לליד",
  cps: "עלות לתיאום",
  cpm: "עלות לביצוע",
};

const HE_MONTHS = [
  "ינואר",
  "פברואר",
  "מרץ",
  "אפריל",
  "מאי",
  "יוני",
  "יולי",
  "אוגוסט",
  "ספטמבר",
  "אוקטובר",
  "נובמבר",
  "דצמבר",
];

/** "2026-06" → "יוני 2026". Non-month strings pass through. */
export function monthLabel(period: string): string {
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m) return period;
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return period;
  return `${HE_MONTHS[idx]} ${m[1]}`;
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Share of `values` strictly below `v`, as 0–100. For cost metrics a
 *  LOW percentile means "cheaper than most of the book". */
export function percentileRank(values: number[], v: number): number {
  if (!values.length) return 0;
  let below = 0;
  for (const x of values) if (x < v) below++;
  return Math.round((below / values.length) * 100);
}

/** Sorted (asc) list of the YYYY-MM months present in the monthly
 *  samples of any metric. */
export function monthlyMonths(benchmarks: PortfolioBenchmarks): string[] {
  const set = new Set<string>();
  for (const p of benchmarks.availablePeriods) {
    if (/^\d{4}-\d{2}$/.test(p)) set.add(p);
  }
  return Array.from(set).sort();
}

/** The month the KPI band anchors on: the latest month with a usable
 *  CPL sample count (≥5 projects), falling back to the latest month.
 *  Mid-month the newest bucket is partial and thin — anchoring there
 *  would compare a 4-day month to a 31-day month. */
export function anchorMonth(benchmarks: PortfolioBenchmarks): {
  anchor: string | null;
  prev: string | null;
  months: string[];
} {
  const months = monthlyMonths(benchmarks);
  if (!months.length) return { anchor: null, prev: null, months };
  const countByMonth = new Map<string, number>();
  for (const s of benchmarks.project.cpl.samples) {
    if (!/^\d{4}-\d{2}$/.test(s.period)) continue;
    countByMonth.set(s.period, (countByMonth.get(s.period) || 0) + 1);
  }
  let anchor = months[months.length - 1];
  for (let i = months.length - 1; i >= 0; i--) {
    if ((countByMonth.get(months[i]) || 0) >= 5) {
      anchor = months[i];
      break;
    }
  }
  const ai = months.indexOf(anchor);
  const prev = ai > 0 ? months[ai - 1] : null;
  return { anchor, prev, months };
}

/* ── KPI band ───────────────────────────────────────────────────── */

export type KpiDelta = {
  /** Percent change anchor vs prev (e.g. +12.3). */
  pct: number;
  /** Is this change good news? Cost ↓ = good; leads ↑ = good; spend = neutral. */
  goodness: "good" | "bad" | "neutral";
};

export type KpiTile = {
  key: string;
  label: string;
  /** Anchor-month value. null = no data. */
  value: number | null;
  format: "ils" | "int";
  delta: KpiDelta | null;
  /** Per-month series (asc, last ≤8 months incl. anchor) for the sparkline. */
  spark: number[];
  /** One-line explanation shown as title-tooltip. */
  hint: string;
};

function deltaOf(
  curr: number | null,
  prev: number | null,
  lowerIsBetter: boolean | null,
): KpiDelta | null {
  if (curr == null || prev == null || prev <= 0) return null;
  const pct = ((curr - prev) / prev) * 100;
  if (lowerIsBetter == null) return { pct, goodness: "neutral" };
  if (Math.abs(pct) < 1) return { pct, goodness: "neutral" };
  const isGood = lowerIsBetter ? pct < 0 : pct > 0;
  return { pct, goodness: isGood ? "good" : "bad" };
}

/** Median of a metric's monthly samples for one month. null if no samples. */
function monthMedian(
  samples: BenchmarkSample[],
  month: string,
): number | null {
  const vals = samples.filter((s) => s.period === month).map((s) => s.value);
  return vals.length ? median(vals) : null;
}

export function computeKpis(benchmarks: PortfolioBenchmarks): {
  tiles: KpiTile[];
  anchor: string | null;
  prev: string | null;
} {
  const { anchor, prev, months } = anchorMonth(benchmarks);
  if (!anchor) return { tiles: [], anchor, prev };
  const sparkMonths = months.slice(-8);

  // Sum tiles come from projectPeriodRaw (no eligibility floors — sums
  // are honest without them).
  const sums = new Map<
    string,
    { spend: number; leads: number; projects: Set<string> }
  >();
  for (const r of benchmarks.projectPeriodRaw) {
    if (!/^\d{4}-\d{2}$/.test(r.period)) continue;
    const rec =
      sums.get(r.period) ||
      { spend: 0, leads: 0, projects: new Set<string>() };
    rec.spend += r.spend;
    rec.leads += r.leads;
    if (r.spend > 0) rec.projects.add(r.project);
    sums.set(r.period, rec);
  }
  const sumOf = (m: string | null, k: "spend" | "leads"): number | null =>
    m && sums.has(m) ? sums.get(m)![k] : null;
  const activeOf = (m: string | null): number | null =>
    m && sums.has(m) ? sums.get(m)!.projects.size : null;

  const tiles: KpiTile[] = [];

  (Object.keys(METRIC_LABELS) as Metric[]).forEach((metric) => {
    const samples = benchmarks.project[metric].samples;
    const curr = monthMedian(samples, anchor);
    const prv = prev ? monthMedian(samples, prev) : null;
    tiles.push({
      key: metric,
      label: `חציון ${METRIC_LABELS[metric]}`,
      value: curr,
      format: "ils",
      delta: deltaOf(curr, prv, true),
      spark: sparkMonths.map((m) => monthMedian(samples, m) ?? 0),
      hint: `חציון על פני כל הפרויקטים עם מספיק נתונים ב${monthLabel(anchor)}`,
    });
  });

  tiles.push({
    key: "spend",
    label: "השקעה חודשית",
    value: sumOf(anchor, "spend"),
    format: "ils",
    delta: deltaOf(sumOf(anchor, "spend"), sumOf(prev, "spend"), null),
    spark: sparkMonths.map((m) => sumOf(m, "spend") ?? 0),
    hint: `סך ההשקעה בכל הערוצים בכל הפרויקטים ב${monthLabel(anchor)}`,
  });
  tiles.push({
    key: "leads",
    label: "לידים חודשיים",
    value: sumOf(anchor, "leads"),
    format: "int",
    delta: deltaOf(sumOf(anchor, "leads"), sumOf(prev, "leads"), false),
    spark: sparkMonths.map((m) => sumOf(m, "leads") ?? 0),
    hint: `סך הלידים בכל הפרויקטים ב${monthLabel(anchor)}`,
  });
  tiles.push({
    key: "projects",
    label: "פרויקטים פעילים",
    value: activeOf(anchor),
    format: "int",
    delta: deltaOf(activeOf(anchor), activeOf(prev), false),
    spark: sparkMonths.map((m) => activeOf(m) ?? 0),
    hint: `פרויקטים עם השקעה כלשהי ב${monthLabel(anchor)}`,
  });

  return { tiles, anchor, prev };
}

/* ── Auto-insights ──────────────────────────────────────────────── */

export type Insight = {
  id: string;
  icon: string;
  tone: "good" | "bad" | "watch" | "info";
  /** One Hebrew sentence — the takeaway, already phrased. */
  text: string;
  action?: {
    label: string;
    kind: "tab" | "project";
    tab?: string;
    project?: string;
  };
};

const fmtIls = (n: number) => "₪" + Math.round(n).toLocaleString("he-IL");
const fmtPct0 = (n: number) => Math.abs(n).toFixed(0) + "%";

export function computeInsights(
  benchmarks: PortfolioBenchmarks,
  metric: Metric,
): Insight[] {
  const out: Insight[] = [];
  const label = METRIC_LABELS[metric];
  const { anchor, prev, months } = anchorMonth(benchmarks);
  const samples = benchmarks.project[metric].samples;

  // 1 — direction of travel over the visible span (up to 6 months back).
  if (anchor) {
    const spanStart = months[Math.max(0, months.indexOf(anchor) - 5)];
    const first = monthMedian(samples, spanStart);
    const last = monthMedian(samples, anchor);
    if (first != null && last != null && first > 0 && spanStart !== anchor) {
      const pct = ((last - first) / first) * 100;
      const nMonths = months.indexOf(anchor) - months.indexOf(spanStart);
      if (Math.abs(pct) >= 5) {
        const up = pct > 0;
        out.push({
          id: "trend",
          icon: up ? "📈" : "📉",
          tone: up ? "bad" : "good",
          text: `חציון ${label} בתיק ${up ? "עלה" : "ירד"} ב־${fmtPct0(pct)} ב־${nMonths} חודשים (${fmtIls(first)} → ${fmtIls(last)})`,
        });
      } else {
        out.push({
          id: "trend",
          icon: "➡️",
          tone: "info",
          text: `חציון ${label} בתיק יציב ב־${nMonths} החודשים האחרונים (סביב ${fmtIls(last)})`,
        });
      }
    }
  }

  // 2+3 — biggest month-over-month improver / worsener among projects
  // with a sample in both months.
  if (anchor && prev) {
    const currBy = new Map<string, number>();
    const prevBy = new Map<string, number>();
    for (const s of samples) {
      if (s.period === anchor) currBy.set(s.project, s.value);
      else if (s.period === prev) prevBy.set(s.project, s.value);
    }
    let best: { project: string; pct: number; from: number; to: number } | null =
      null;
    let worst: { project: string; pct: number; from: number; to: number } | null =
      null;
    currBy.forEach((to, project) => {
      const from = prevBy.get(project);
      if (from == null || from <= 0) return;
      const pct = ((to - from) / from) * 100;
      if (pct <= -20 && (!best || pct < best.pct))
        best = { project, pct, from, to };
      if (pct >= 20 && (!worst || pct > worst.pct))
        worst = { project, pct, from, to };
    });
    if (best) {
      const b = best as { project: string; pct: number; from: number; to: number };
      out.push({
        id: "mover-good",
        icon: "🏅",
        tone: "good",
        text: `השיפור החודשי הגדול: ${b.project} — ${label} ירדה ${fmtPct0(b.pct)} (${fmtIls(b.from)} → ${fmtIls(b.to)})`,
        action: { label: "פתח פרויקט", kind: "project", project: b.project },
      });
    }
    if (worst) {
      const w = worst as { project: string; pct: number; from: number; to: number };
      out.push({
        id: "mover-bad",
        icon: "🚩",
        tone: "bad",
        text: `ההתייקרות החודשית הגדולה: ${w.project} — ${label} עלתה ${fmtPct0(w.pct)} (${fmtIls(w.from)} → ${fmtIls(w.to)})`,
        action: { label: "פתח פרויקט", kind: "project", project: w.project },
      });
    }
  }

  // 4 — cheapest channel family at meaningful scale.
  {
    const portfolioMedian = benchmarks.project[metric].stats.median;
    let bestChan: { alias: string; med: number; n: number } | null = null;
    Object.entries(benchmarks.channels).forEach(([alias, c]) => {
      const st = c[metric].stats;
      if (st.n < 10 || st.median <= 0) return;
      if (!bestChan || st.median < bestChan.med)
        bestChan = { alias, med: st.median, n: st.n };
    });
    if (bestChan && portfolioMedian > 0) {
      const bc = bestChan as { alias: string; med: number; n: number };
      const savePct = ((portfolioMedian - bc.med) / portfolioMedian) * 100;
      if (savePct >= 10) {
        out.push({
          id: "channel-value",
          icon: "💎",
          tone: "info",
          text: `הערוץ המשתלם בתיק: ${bc.alias} — חציון ${label} ${fmtIls(bc.med)}, ${fmtPct0(savePct)} מתחת לחציון התיק (n=${bc.n})`,
          action: { label: "לערוצים", kind: "tab", tab: "channels" },
        });
      }
    }
  }

  // 5 — statistically significant outliers right now.
  {
    const current = samples.filter((s) => s.period === "current");
    const values = current.map((s) => s.value);
    const mean = meanOf(values);
    const sd = stddevOf(values);
    if (sd > 0 && current.length >= 3) {
      const sig = current
        .map((s) => ({ s, z: (s.value - mean) / sd }))
        .filter(({ z }) => Math.abs(z) >= 2 && twoSidedPValue(z) < 0.05)
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
      if (sig.length) {
        const worstOne = sig[0];
        out.push({
          id: "outliers",
          icon: "🚨",
          tone: "watch",
          text:
            sig.length === 1
              ? `פרויקט אחד חורג מובהק מהתיק ב${label}: ${worstOne.s.project} (${worstOne.z > 0 ? "+" : "−"}${Math.abs(worstOne.z).toFixed(1)}σ, ${fmtIls(worstOne.s.value)})`
              : `${sig.length} פרויקטים חורגים מובהק מהתיק ב${label}; החריג ביותר: ${worstOne.s.project} (${worstOne.z > 0 ? "+" : "−"}${Math.abs(worstOne.z).toFixed(1)}σ)`,
          action: {
            label: "פתח פרויקט",
            kind: "project",
            project: worstOne.s.project,
          },
        });
      }
    }
  }

  // 6 — does paying more per lead buy a better scheduling rate? A
  // portfolio-level truth the correlations tab proves; here as one line.
  {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of benchmarks.projectPeriodRaw) {
      if (r.period === "current") continue;
      if (r.spend <= 0 || r.leads < 5) continue;
      const rate = (r.scheduled / r.leads) * 100;
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) continue;
      xs.push(r.spend / r.leads);
      ys.push(rate);
    }
    if (xs.length >= 10) {
      const r = pearsonR(xs, ys);
      const p = pearsonPValue(r, xs.length);
      if (Math.abs(r) < 0.2 || p >= 0.05) {
        out.push({
          id: "funnel",
          icon: "⚖️",
          tone: "info",
          text: `לידים יקרים לא מתאמים לפגישות בקצב גבוה יותר — אין קשר בין עלות־לליד לאחוז התיאום (r=${r.toFixed(2)}, n=${xs.length})`,
          action: { label: "לניתוח", kind: "tab", tab: "analysis" },
        });
      } else {
        out.push({
          id: "funnel",
          icon: "⚖️",
          tone: r > 0 ? "info" : "watch",
          text: `${r > 0 ? "לידים יקרים אכן מתאמים מעט יותר" : "דווקא לידים זולים מתאמים יותר"} — r=${r.toFixed(2)} בין עלות־לליד לאחוז תיאום (n=${xs.length})`,
          action: { label: "לניתוח", kind: "tab", tab: "analysis" },
        });
      }
    }
  }

  // 7 — most volatile project (CV of monthly values, n≥4).
  {
    const byProject = new Map<string, number[]>();
    for (const s of samples) {
      if (!/^\d{4}-\d{2}$/.test(s.period)) continue;
      const list = byProject.get(s.project) || [];
      list.push(s.value);
      byProject.set(s.project, list);
    }
    let vol: { project: string; cv: number; n: number } | null = null;
    byProject.forEach((vals, project) => {
      if (vals.length < 4) return;
      const m = meanOf(vals);
      if (m <= 0) return;
      const cv = stddevOf(vals) / m;
      if (!vol || cv > vol.cv) vol = { project, cv, n: vals.length };
    });
    const v = vol as { project: string; cv: number; n: number } | null;
    if (v && v.cv >= 0.5) {
      out.push({
        id: "volatile",
        icon: "🎢",
        tone: "watch",
        text: `הכי תנודתי ב${label}: ${v.project} — סטייה של ${fmtPct0(v.cv * 100)} מהממוצע העצמי בין חודש לחודש (${v.n} חודשים)`,
        action: { label: "פתח פרויקט", kind: "project", project: v.project },
      });
    }
  }

  return out.slice(0, 6);
}

/* ── Consolidated project table ─────────────────────────────────── */

export type ProjectRow = {
  project: string;
  /** Current-period value (rowType=current). null when the project has
   *  no current sample for this metric. */
  current: number | null;
  /** Median of the project's own monthly samples. */
  ownMedian: number | null;
  /** (current − ownMedian) / ownMedian × 100. */
  deltaVsOwnPct: number | null;
  /** Months of monthly history for this metric. */
  months: number;
  /** Coefficient of variation (σ/μ) of monthly values; null under 3 months. */
  cv: number | null;
  /** 0 = הזול בתיק, 100 = היקר בתיק (among current samples). */
  percentile: number | null;
  /** z-score of current value vs the current-sample distribution. */
  z: number | null;
  status: "outlier-high" | "borderline-high" | "ok" | "efficient";
  /** Monthly values ascending by month — sparkline. */
  spark: number[];
};

export function computeProjectRows(
  benchmarks: PortfolioBenchmarks,
  metric: Metric,
): ProjectRow[] {
  const samples = benchmarks.project[metric].samples;
  const currentBy = new Map<string, number>();
  const monthlyBy = new Map<string, Array<{ month: string; value: number }>>();
  for (const s of samples) {
    if (s.period === "current") currentBy.set(s.project, s.value);
    else if (/^\d{4}-\d{2}$/.test(s.period)) {
      const list = monthlyBy.get(s.project) || [];
      list.push({ month: s.period, value: s.value });
      monthlyBy.set(s.project, list);
    }
  }
  const currentValues = Array.from(currentBy.values());
  const mean = meanOf(currentValues);
  const sd = stddevOf(currentValues);

  const projects = new Set<string>([
    ...currentBy.keys(),
    ...monthlyBy.keys(),
  ]);

  const rows: ProjectRow[] = [];
  projects.forEach((project) => {
    const current = currentBy.get(project) ?? null;
    const monthly = (monthlyBy.get(project) || []).sort((a, b) =>
      a.month.localeCompare(b.month),
    );
    const monthlyVals = monthly.map((m) => m.value);
    const ownMedian = monthlyVals.length >= 2 ? median(monthlyVals) : null;
    const deltaVsOwnPct =
      current != null && ownMedian != null && ownMedian > 0
        ? ((current - ownMedian) / ownMedian) * 100
        : null;
    const m = meanOf(monthlyVals);
    const cv =
      monthlyVals.length >= 3 && m > 0 ? stddevOf(monthlyVals) / m : null;
    const z = current != null && sd > 0 ? (current - mean) / sd : null;
    let status: ProjectRow["status"] = "ok";
    if (z != null) {
      if (z >= 2) status = "outlier-high";
      else if (z >= 1.5) status = "borderline-high";
      else if (z <= -1.5) status = "efficient";
    }
    rows.push({
      project,
      current,
      ownMedian,
      deltaVsOwnPct,
      months: monthlyVals.length,
      cv,
      percentile:
        current != null ? percentileRank(currentValues, current) : null,
      z,
      status,
      spark: monthlyVals.slice(-8),
    });
  });
  return rows;
}

/* ── Selected-project positioning (drill-down tab header) ───────── */

export type MetricPositioning = {
  metric: Metric;
  label: string;
  value: number;
  percentile: number;
  z: number | null;
  deltaVsOwnPct: number | null;
};

export function projectPositioning(
  benchmarks: PortfolioBenchmarks,
  project: string,
): MetricPositioning[] {
  const out: MetricPositioning[] = [];
  (Object.keys(METRIC_LABELS) as Metric[]).forEach((metric) => {
    const rows = computeProjectRows(benchmarks, metric);
    const row = rows.find((r) => r.project === project);
    if (!row || row.current == null || row.percentile == null) return;
    out.push({
      metric,
      label: METRIC_LABELS[metric],
      value: row.current,
      percentile: row.percentile,
      z: row.z,
      deltaVsOwnPct: row.deltaVsOwnPct,
    });
  });
  return out;
}

/** Portfolio-wide monthly median + IQR series for the trend chart. */
export type TrendPoint = {
  month: string;
  median: number;
  p25: number;
  p75: number;
  n: number;
};

export function trendSeries(
  benchmarks: PortfolioBenchmarks,
  metric: Metric,
  monthsBack = 24,
): TrendPoint[] {
  const byMonth = new Map<string, number[]>();
  for (const s of benchmarks.project[metric].samples) {
    if (!/^\d{4}-\d{2}$/.test(s.period)) continue;
    const list = byMonth.get(s.period) || [];
    list.push(s.value);
    byMonth.set(s.period, list);
  }
  const months = Array.from(byMonth.keys()).sort().slice(-monthsBack);
  return months.map((month) => {
    const vals = byMonth.get(month) || [];
    return {
      month,
      median: median(vals),
      p25: percentile(vals, 25),
      p75: percentile(vals, 75),
      n: vals.length,
    };
  });
}
