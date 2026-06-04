/**
 * Pure stats math — extracted from portfolioBenchmarks.ts so client
 * components can reuse it when they filter the server-computed
 * distributions (e.g. /stats's period picker rebuilds the distribution
 * from a subset of samples after the user narrows the time window).
 *
 * No React / Next.js dependencies — safe to import from either side.
 */

import type {
  BenchmarkDistribution,
  BenchmarkSample,
  BenchmarkStats,
} from "@/lib/portfolioBenchmarks";

export function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(
    s.length - 1,
    Math.max(0, Math.round((p / 100) * (s.length - 1))),
  );
  return s[idx];
}

export function statsOf(arr: number[]): BenchmarkStats {
  return {
    n: arr.length,
    p25: percentile(arr, 25),
    median: percentile(arr, 50),
    p75: percentile(arr, 75),
  };
}

export function meanOf(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

export function stddevOf(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = meanOf(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length;
  return Math.sqrt(v);
}

/**
 * Two-sided p-value for a z-score, using the Abramowitz & Stegun 26.2.17
 * approximation of the standard normal CDF (max error ~7.5e-8). Good
 * enough for the typical "is this project significantly different from
 * the portfolio?" sanity check in the stats UI — we're not publishing
 * to a journal here.
 *
 * Treats the underlying distribution as approximately normal; CPL is
 * actually right-skewed, so very small p-values (< 1e-3) should be
 * read with a grain of salt. The qualitative direction (significant /
 * not significant at 0.05) is what matters for the UI.
 */
export function twoSidedPValue(z: number): number {
  const az = Math.abs(z);
  if (az === Infinity) return 0;
  const t = 1 / (1 + 0.2316419 * az);
  const d = 0.3989422804014327 * Math.exp((-az * az) / 2);
  const tail =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  // tail = P(Z > az). Two-sided: 2 * tail.
  return Math.min(1, 2 * tail);
}

/**
 * Map a p-value to a short Hebrew label and significance tier. Used by
 * the outlier cards + rankings to surface "is this difference real?"
 * at a glance.
 *
 *   p < 0.001 → "מובהק מאוד"   tier "high"
 *   p < 0.01  → "מובהק"         tier "medium"
 *   p < 0.05  → "מובהק חלש"    tier "low"
 *   else      → "לא מובהק"     tier "none"
 */
export type SignificanceTier = "none" | "low" | "medium" | "high";
export function describeSignificance(p: number): {
  tier: SignificanceTier;
  label: string;
} {
  if (p < 0.001) return { tier: "high", label: "מובהק מאוד" };
  if (p < 0.01) return { tier: "medium", label: "מובהק" };
  if (p < 0.05) return { tier: "low", label: "מובהק חלש" };
  return { tier: "none", label: "לא מובהק" };
}

/**
 * Pearson product-moment correlation coefficient between two parallel
 * numeric arrays. Returns 0 when arrays differ in length, are too
 * short, or when one of them has zero variance (division by zero).
 *
 *   r ∈ [-1, +1]
 *     +1 = perfect positive linear correlation
 *      0 = no linear relationship
 *     -1 = perfect inverse correlation
 */
export function pearsonR(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const n = xs.length;
  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const mx = sumX / n;
  const my = sumY / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return 0;
  return num / Math.sqrt(denX * denY);
}

/**
 * Approximate two-sided p-value for a Pearson correlation. Uses the
 * t-statistic `t = r * sqrt((n-2) / (1 - r²))` with df = n-2 and
 * approximates the t-distribution tail with the standard normal CDF.
 *
 * For df ≥ 30 the approximation is excellent. For smaller samples it
 * understates the p-value somewhat — i.e. claims slightly more
 * significance than a precise t-test would. Fine for UI triage,
 * NOT for publication-grade hypothesis testing.
 */
export function pearsonPValue(r: number, n: number): number {
  if (n < 3) return 1;
  const r2 = r * r;
  if (r2 >= 1) return 0;
  const t = r * Math.sqrt((n - 2) / (1 - r2));
  return twoSidedPValue(t);
}

/**
 * Linear-regression slope + intercept (ordinary least squares) for a
 * pair of parallel numeric arrays. Returns null if either array is
 * empty or x has zero variance. Used for drawing a trend line through
 * a scatter plot.
 */
export function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number } | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const n = xs.length;
  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const mx = sumX / n;
  const my = sumY / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    num += dx * (ys[i] - my);
    den += dx * dx;
  }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

/**
 * Build a fresh BenchmarkDistribution from a sample list. Samples are
 * sorted ascending by value for stable rendering.
 */
export function distributionOf(
  samples: BenchmarkSample[],
): BenchmarkDistribution {
  const values = samples.map((s) => s.value);
  return {
    stats: statsOf(values),
    samples: samples.slice().sort((a, b) => a.value - b.value),
    mean: meanOf(values),
    stddev: stddevOf(values),
  };
}
