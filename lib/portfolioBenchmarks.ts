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

export type PortfolioBenchmarks = {
  project: {
    cpl: BenchmarkStats;
    cps: BenchmarkStats;
    cpm: BenchmarkStats;
  };
  channels: Record<
    string,
    {
      cpl: BenchmarkStats;
      cps: BenchmarkStats;
      cpm: BenchmarkStats;
    }
  >;
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

/* ── Computation ────────────────────────────────────────────────── */
function compute(rows: AllClientsRow[]): PortfolioBenchmarks {
  // Filter to "current" rows (the dashboard uses live per-project
  // aggregates, which ALL CLIENTS surfaces as `rowType === "current"`).
  const current = rows.filter((r) => r.rowType === "current");
  // Group by project slug.
  const bySlug = new Map<string, AllClientsRow[]>();
  for (const r of current) {
    if (!r.projectSlug) continue;
    if (Number(r.spend) <= 0) continue;
    const list = bySlug.get(r.projectSlug) || [];
    list.push(r);
    bySlug.set(r.projectSlug, list);
  }

  const projCpls: number[] = [];
  const projCpss: number[] = [];
  const projCpms: number[] = [];
  const byChannel: Record<
    string,
    { cpls: number[]; cpss: number[]; cpms: number[] }
  > = {};

  bySlug.forEach((channels) => {
    const S = channels.reduce((s, c) => s + Number(c.spend || 0), 0);
    const L = channels.reduce((s, c) => s + Number(c.leads || 0), 0);
    const Sch = channels.reduce((s, c) => s + Number(c.scheduled || 0), 0);
    const M = channels.reduce((s, c) => s + Number(c.meetings || 0), 0);
    if (L >= 5) projCpls.push(S / L);
    if (Sch >= 3) projCpss.push(S / Sch);
    if (M >= 2) projCpms.push(S / M);

    channels.forEach((c) => {
      const alias = channelAlias(c.channel);
      const bucket =
        byChannel[alias] || { cpls: [], cpss: [], cpms: [] };
      const cs = Number(c.spend || 0);
      const cl = Number(c.leads || 0);
      const csch = Number(c.scheduled || 0);
      const cm = Number(c.meetings || 0);
      if (cl >= 3) bucket.cpls.push(cs / cl);
      if (csch >= 2) bucket.cpss.push(cs / csch);
      if (cm >= 1) bucket.cpms.push(cs / cm);
      byChannel[alias] = bucket;
    });
  });

  const channels: PortfolioBenchmarks["channels"] = {};
  Object.keys(byChannel).forEach((a) => {
    channels[a] = {
      cpl: statsOf(byChannel[a].cpls),
      cps: statsOf(byChannel[a].cpss),
      cpm: statsOf(byChannel[a].cpms),
    };
  });

  return {
    project: {
      cpl: statsOf(projCpls),
      cps: statsOf(projCpss),
      cpm: statsOf(projCpms),
    },
    channels,
  };
}

/* ── Public loader ──────────────────────────────────────────────── */
async function fetchBenchmarks(
  subjectEmail: string,
): Promise<PortfolioBenchmarks> {
  const rows = await getAllClientsAllRows(subjectEmail);
  return compute(rows);
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
