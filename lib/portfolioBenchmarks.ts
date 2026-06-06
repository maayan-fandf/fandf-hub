/**
 * Portfolio-wide benchmarks: project-level + per-channel-family
 * distribution. Mirrors `computePortfolioBenchmarks` from
 * client-dashboard/Index.html:3861, just sourced from the hub's
 * ALL CLIENTS read instead of the dashboard's PROJECTS global.
 *
 * Self-calibrating: P25/median/P75 are recomputed from whatever
 * is in ALL CLIENTS right now — no hardcoded thresholds.
 *
 * Built for the stats page's paid-channels diagnosis (task #59). The
 * dashboard's version computes from the same source data, so the
 * verdicts should match.
 *
 * Sample-size floors mirror the dashboard's:
 *   - project-CPL sample: 5+ leads
 *   - project-CPS sample: 3+ scheduled
 *   - project-CPM sample: 2+ meetings
 *   - channel-CPL sample: 3+ leads
 *   - channel-CPS sample: 2+ scheduled
 *   - channel-CPM sample: 1+ meetings
 * Lower than the per-card display thresholds because we're aggregating
 * across the portfolio, where any signal contributes — the per-card
 * surface still requires tier=robust before flagging.
 */

import { cache } from "react";
import { unstable_cache } from "next/cache";
import { readKeysCached } from "@/lib/keys";
import {
  getAllClientsAllRows,
  type AllClientsRow,
} from "@/lib/allClients";
import { channelAlias } from "@/lib/channelAlias";
import { driveFolderOwner } from "@/lib/sa";

export type BenchmarkStats = {
  n: number;
  p25: number;
  median: number;
  p75: number;
};

/** One project-month's contribution to a metric distribution. The label
 *  is the Hebrew project name (matches the dropdown). `period` is the
 *  bucket the sample belongs to — either YYYY-MM for a חודשי row, or
 *  the literal string "current" for the rowType=current aggregation.
 *  The Gaussian section's period picker uses this to filter samples
 *  client-side. `month` is the legacy alias retained for the hover
 *  tooltip (it's set to the same value as `period` for monthly samples
 *  and to "current" for current-row samples). */
export type BenchmarkSample = {
  project: string;
  value: number;
  period: string;
  /** @deprecated — kept so the hover panel keeps working without a
   *  prop rename. Same value as `period`. */
  month?: string;
};

export type BenchmarkDistribution = {
  stats: BenchmarkStats;
  /** Raw per-project values that went into `stats`. Sorted asc by value
   *  for cheap rendering — the strip plot doesn't need it sorted but
   *  the data export does. */
  samples: BenchmarkSample[];
  /** Sample mean (raw, not shrunk). */
  mean: number;
  /** Sample standard deviation (population, n-divisor). */
  stddev: number;
};

export type PortfolioBenchmarks = {
  project: {
    cpl: BenchmarkDistribution;
    cps: BenchmarkDistribution;
    cpm: BenchmarkDistribution;
  };
  channels: Record<
    string,
    {
      cpl: BenchmarkDistribution;
      cps: BenchmarkDistribution;
      cpm: BenchmarkDistribution;
    }
  >;
  /** Per-alias list of the raw channel labels that normalized into that
   *  bucket — sourced from the WHOLE portfolio (all projects, all rows
   *  with non-zero spend). Used to power the channel-row hover tooltip
   *  on /stats's benchmarks table so users can audit what's actually
   *  being aggregated under each alias. Sorted alphabetically. */
  aliasToRaw: Record<string, string[]>;
  /** All distinct period bucket values present in `samples` across all
   *  metrics + channels. "current" + sorted YYYY-MM months. Powers the
   *  period multi-select on /stats. */
  availablePeriods: string[];
};

const CACHE_TTL = 600; // 10 min — portfolio shape doesn't shift hourly
const CACHE_TAG = "portfolioBenchmarks";

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(
    s.length - 1,
    Math.max(0, Math.round((p / 100) * (s.length - 1))),
  );
  return s[idx];
}

function statsOf(arr: number[]): BenchmarkStats {
  return {
    n: arr.length,
    p25: pct(arr, 25),
    median: pct(arr, 50),
    p75: pct(arr, 75),
  };
}

function meanOf(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function stddevOf(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = meanOf(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length;
  return Math.sqrt(v);
}

function distributionOf(samples: BenchmarkSample[]): BenchmarkDistribution {
  const values = samples.map((s) => s.value);
  return {
    stats: statsOf(values),
    samples: samples.slice().sort((a, b) => a.value - b.value),
    mean: meanOf(values),
    stddev: stddevOf(values),
  };
}

/* ── Computation ────────────────────────────────────────────────── */

/** Sheets formula-error literals — `#N/A` from stale XLOOKUPs etc.
 *  Treat as blank when reading the project name so they don't end up
 *  as the "resolved" slug→name mapping. Same set Code.js'
 *  getProjectsData fix uses (2026-06-05). */
const FORMULA_ERR_RE =
  /^#(N\/A|REF!|ERROR!|NAME\?|VALUE!|DIV\/0!|NULL!|NUM!)$/i;

function compute(
  rows: AllClientsRow[],
  /** Authoritative slug → Hebrew name map built from Keys. Lookup here
   *  wins over whatever ALL CLIENTS holds because Keys is the
   *  curated source of truth: every project has a non-blank Hebrew
   *  name. Without this, projects whose ALL CLIENTS `project` column
   *  is blank OR `#N/A` (post-XLOOKUP-removal 2026-05-01) end up
   *  keyed by SLUG in the benchmark samples — and the stats page's
   *  `highlightProject="ג'ייד"` then fails the `d.project ===
   *  highlightProject` equality check against a dot keyed
   *  `"jade"`. */
  keysSlugToName: Map<string, string> = new Map(),
): PortfolioBenchmarks {
  // Build a slug → Hebrew-name lookup from ALL rows first. Post-XLOOKUP
  // (2026-05-01) the ALL CLIENTS `project` column is often blank for
  // current rows but populated for monthly rows of the same slug —
  // so we scan everything to recover the Hebrew name. Required for
  // the city section's name-based join with Keys (2026-06-05).
  // Keys-derived map takes precedence (seeded first); ALL CLIENTS scan
  // only fills slugs Keys didn't cover (legacy archived projects).
  const slugToName = new Map<string, string>(keysSlugToName);
  for (const r of rows) {
    if (!r.projectSlug) continue;
    if (slugToName.has(r.projectSlug)) continue; // Keys already won
    const raw = (r.project || "").trim();
    if (!raw) continue;
    if (FORMULA_ERR_RE.test(raw)) continue; // stale XLOOKUP error
    slugToName.set(r.projectSlug, raw);
  }
  // Group by (projectSlug, period). Period is YYYY-MM for "חודשי"
  // rows and the literal "current" for rowType=current rows. Including
  // BOTH (2026-06-05) gives the user a period multi-select with two
  // axes:
  //   - rowType=current: one sample per project, representing the
  //     live in-flight aggregation (the original dashboard view)
  //   - rowType=חודשי: one sample per (project, month), giving
  //     statistical power at the cost of time-period mixing
  // Default selection on /stats is all monthly months (no current)
  // to avoid double-counting since current = sum of monthlies.
  //
  // Sample label stays as the bare project name so the strip-plot
  // highlight `highlightProject="Iris"` hits ALL its samples.
  const eligible = rows.filter(
    (r) => r.rowType === "חודשי" || r.rowType === "current",
  );
  const byProjectPeriod = new Map<
    string, // composite key: slug + "::" + period
    { projectName: string; period: string; channels: AllClientsRow[] }
  >();
  for (const r of eligible) {
    if (!r.projectSlug) continue;
    if (Number(r.spend) <= 0) continue;
    let period: string;
    if (r.rowType === "current") {
      period = "current";
    } else {
      const monthKey = (r.startIso || "").slice(0, 7); // YYYY-MM
      if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) continue;
      period = monthKey;
    }
    const compositeKey = r.projectSlug + "::" + period;
    const resolvedName =
      slugToName.get(r.projectSlug) || r.project || r.projectSlug;
    const entry = byProjectPeriod.get(compositeKey) || {
      projectName: resolvedName,
      period,
      channels: [] as AllClientsRow[],
    };
    if (!entry.projectName && resolvedName) entry.projectName = resolvedName;
    entry.channels.push(r);
    byProjectPeriod.set(compositeKey, entry);
  }

  // Project-lifetime totals — sum across ALL monthly rows per project,
  // falling back to the current row when no monthly data exists. This
  // is the "one dot per project, full history" aggregate that
  // StatsCorrelations uses (period="lifetime" samples), giving a much
  // bigger n than the "current snapshot only" path that previously
  // dropped projects whose CURRENT row was stale (the עוז בלנד case:
  // current showed scheduled=2 but monthly cumulative was 111). The
  // existing per-period samples (period="current" + each YYYY-MM)
  // stay unchanged so the Gaussian strip-plots + period multi-select
  // keep their semantics.
  type LifetimeAgg = {
    projectName: string;
    monthlySpend: number; monthlyLeads: number;
    monthlyScheduled: number; monthlyMeetings: number;
    currentSpend: number; currentLeads: number;
    currentScheduled: number; currentMeetings: number;
    sawMonthly: boolean;
    sawCurrent: boolean;
  };
  const lifetimeBySlug = new Map<string, LifetimeAgg>();
  for (const r of eligible) {
    if (!r.projectSlug) continue;
    if (Number(r.spend) <= 0) continue;
    const slug = r.projectSlug;
    const name = slugToName.get(slug) || r.project || slug;
    const agg = lifetimeBySlug.get(slug) || {
      projectName: name,
      monthlySpend: 0, monthlyLeads: 0,
      monthlyScheduled: 0, monthlyMeetings: 0,
      currentSpend: 0, currentLeads: 0,
      currentScheduled: 0, currentMeetings: 0,
      sawMonthly: false,
      sawCurrent: false,
    };
    if (!agg.projectName && name) agg.projectName = name;
    if (r.rowType === "current") {
      agg.sawCurrent = true;
      agg.currentSpend += Number(r.spend) || 0;
      agg.currentLeads += Number(r.leads) || 0;
      agg.currentScheduled += Number(r.scheduled) || 0;
      agg.currentMeetings += Number(r.meetings) || 0;
    } else {
      agg.sawMonthly = true;
      agg.monthlySpend += Number(r.spend) || 0;
      agg.monthlyLeads += Number(r.leads) || 0;
      agg.monthlyScheduled += Number(r.scheduled) || 0;
      agg.monthlyMeetings += Number(r.meetings) || 0;
    }
    lifetimeBySlug.set(slug, agg);
  }

  const projCpls: BenchmarkSample[] = [];
  const projCpss: BenchmarkSample[] = [];
  const projCpms: BenchmarkSample[] = [];
  const byChannel: Record<
    string,
    { cpls: BenchmarkSample[]; cpss: BenchmarkSample[]; cpms: BenchmarkSample[] }
  > = {};
  // Per-alias raw-name set — every distinct label that classified into
  // this alias across the whole portfolio. Powers the table hover
  // tooltip on the stats page.
  const aliasRawNames: Record<string, Set<string>> = {};

  byProjectPeriod.forEach(({ projectName, period, channels }) => {
    const S = channels.reduce((s, c) => s + Number(c.spend || 0), 0);
    const L = channels.reduce((s, c) => s + Number(c.leads || 0), 0);
    const Sch = channels.reduce((s, c) => s + Number(c.scheduled || 0), 0);
    const M = channels.reduce((s, c) => s + Number(c.meetings || 0), 0);
    if (L >= 5)
      projCpls.push({ project: projectName, value: S / L, period, month: period });
    if (Sch >= 3)
      projCpss.push({ project: projectName, value: S / Sch, period, month: period });
    if (M >= 2)
      projCpms.push({ project: projectName, value: S / M, period, month: period });

    channels.forEach((c) => {
      const alias = channelAlias(c.channel);
      // Stash the raw label so the table tooltip can show what's
      // being normalized into each alias bucket. Trim and dedupe via
      // Set so case/whitespace variants collapse.
      const rawName = (c.channel || "").trim();
      if (rawName) {
        if (!aliasRawNames[alias]) aliasRawNames[alias] = new Set<string>();
        aliasRawNames[alias].add(rawName);
      }
      const bucket =
        byChannel[alias] || { cpls: [], cpss: [], cpms: [] };
      const cs = Number(c.spend || 0);
      const cl = Number(c.leads || 0);
      const csch = Number(c.scheduled || 0);
      const cm = Number(c.meetings || 0);
      if (cl >= 3)
        bucket.cpls.push({
          project: projectName,
          value: cs / cl,
          period,
          month: period,
        });
      if (csch >= 2)
        bucket.cpss.push({
          project: projectName,
          value: cs / csch,
          period,
          month: period,
        });
      if (cm >= 1)
        bucket.cpms.push({
          project: projectName,
          value: cs / cm,
          period,
          month: period,
        });
      byChannel[alias] = bucket;
    });
  });

  // Emit "lifetime" project samples — one per project, computed from
  // the full-history sums above. Prefer monthly aggregate (sees full
  // historical record); fall back to the current row when no monthly
  // data exists (new projects whose only ALL CLIENTS entry is the
  // live current row). Same eligibility floors as the per-period
  // samples (L≥5 / Sch≥3 / M≥2) so the lifetime n stays robust.
  lifetimeBySlug.forEach((agg) => {
    const useMonthly = agg.sawMonthly;
    const S = useMonthly ? agg.monthlySpend : agg.currentSpend;
    const L = useMonthly ? agg.monthlyLeads : agg.currentLeads;
    const Sch = useMonthly ? agg.monthlyScheduled : agg.currentScheduled;
    const M = useMonthly ? agg.monthlyMeetings : agg.currentMeetings;
    if (S <= 0) return;
    if (L >= 5) {
      projCpls.push({
        project: agg.projectName,
        value: S / L,
        period: "lifetime",
        month: "lifetime",
      });
    }
    if (Sch >= 3) {
      projCpss.push({
        project: agg.projectName,
        value: S / Sch,
        period: "lifetime",
        month: "lifetime",
      });
    }
    if (M >= 2) {
      projCpms.push({
        project: agg.projectName,
        value: S / M,
        period: "lifetime",
        month: "lifetime",
      });
    }
  });

  const channels: PortfolioBenchmarks["channels"] = {};
  Object.keys(byChannel).forEach((a) => {
    channels[a] = {
      cpl: distributionOf(byChannel[a].cpls),
      cps: distributionOf(byChannel[a].cpss),
      cpm: distributionOf(byChannel[a].cpms),
    };
  });

  // Convert raw-name Sets → sorted arrays for stable rendering.
  const aliasToRaw: Record<string, string[]> = {};
  Object.keys(aliasRawNames).forEach((a) => {
    aliasToRaw[a] = Array.from(aliasRawNames[a]).sort((x, y) =>
      x.localeCompare(y, "he"),
    );
  });

  // Collect all distinct period values across every sample list — that's
  // the multi-select's option list. "current" first if present, then
  // YYYY-MM months sorted descending (newest first).
  const periodsSet = new Set<string>();
  projCpls.forEach((s) => periodsSet.add(s.period));
  projCpss.forEach((s) => periodsSet.add(s.period));
  projCpms.forEach((s) => periodsSet.add(s.period));
  Object.values(byChannel).forEach((bucket) => {
    bucket.cpls.forEach((s) => periodsSet.add(s.period));
    bucket.cpss.forEach((s) => periodsSet.add(s.period));
    bucket.cpms.forEach((s) => periodsSet.add(s.period));
  });
  const allPeriods = Array.from(periodsSet);
  const monthsDesc = allPeriods
    .filter((p) => p !== "current")
    .sort((a, b) => b.localeCompare(a));
  const availablePeriods = (allPeriods.includes("current") ? ["current"] : []).concat(monthsDesc);

  return {
    project: {
      cpl: distributionOf(projCpls),
      cps: distributionOf(projCpss),
      cpm: distributionOf(projCpms),
    },
    channels,
    aliasToRaw,
    availablePeriods,
  };
}

/* ── Public loader ──────────────────────────────────────────────── */
async function fetchBenchmarks(
  subjectEmail: string,
): Promise<PortfolioBenchmarks> {
  const [rows, keysSlugToName] = await Promise.all([
    getAllClientsAllRows(subjectEmail),
    loadKeysSlugToName(subjectEmail),
  ]);
  return compute(rows, keysSlugToName);
}

/**
 * Build slug → Hebrew project-name map from Keys. The "campaign ID"
 * column is the canonical slug; "פרוייקט" is the curated Hebrew
 * display name. Both are required — projects missing either are
 * skipped (the dot couldn't be plotted with a name anyway).
 * `readKeysCached` already deduplicates the Sheets read at the
 * cross-request level, so this adds zero overhead in practice.
 */
async function loadKeysSlugToName(
  subjectEmail: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { headers, rows } = await readKeysCached(subjectEmail);
    const iSlug = headers.indexOf("campaign ID");
    const iName = headers.indexOf("פרוייקט");
    if (iSlug < 0 || iName < 0) return out;
    for (const r of rows) {
      const slug = String((r as unknown[])[iSlug] ?? "").trim();
      const name = String((r as unknown[])[iName] ?? "").trim();
      if (!slug || !name) continue;
      if (FORMULA_ERR_RE.test(name)) continue; // defensive
      out.set(slug, name);
    }
  } catch {
    // Read failure → empty map; compute() falls back to ALL CLIENTS.
  }
  return out;
}

const fetchBenchmarksCrossRequest = unstable_cache(
  fetchBenchmarks,
  ["portfolioBenchmarks"],
  { revalidate: CACHE_TTL, tags: [CACHE_TAG] },
);

export const getPortfolioBenchmarks = cache(
  (subjectEmail?: string): Promise<PortfolioBenchmarks> =>
    fetchBenchmarksCrossRequest(subjectEmail || driveFolderOwner()),
);
