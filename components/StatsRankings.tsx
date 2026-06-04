"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  BenchmarkSample,
  PortfolioBenchmarks,
} from "@/lib/portfolioBenchmarks";

/**
 * Top / Bottom 10 ranking tables — two side-by-side leaderboards. The
 * left lists the 10 cheapest current-period CPL/CPS/CPM projects; the
 * right lists the 10 most expensive. Each row clickable to drill into
 * that project. Delta column compares current value to that project's
 * OWN historical median (from monthly samples) so you can tell whether
 * the project is at its usual level or off the rails.
 *
 * Owner asked 2026-06-05.
 */

const METRIC_LABELS: Record<"cpl" | "cps" | "cpm", string> = {
  cpl: "עלות לליד",
  cps: "עלות לתיאום",
  cpm: "עלות לביצוע",
};
const fmtIls = (n: number) => "₪" + Math.round(n).toLocaleString("he-IL");
const fmtIlsSigned = (n: number) =>
  (n >= 0 ? "+" : "−") + "₪" + Math.round(Math.abs(n)).toLocaleString("he-IL");

type RankRow = {
  project: string;
  value: number;
  historicalMedian: number | null;
  delta: number | null;
};

function buildRanking(
  benchmarks: PortfolioBenchmarks,
  metric: "cpl" | "cps" | "cpm",
): RankRow[] {
  const samples = benchmarks.project[metric].samples;
  const currentSamples = samples.filter((s) => s.period === "current");

  // Per-project historical median computed from monthly samples (period
  // ≠ "current"). Used for the delta column so each project's "is this
  // expensive for THEM?" is independent of portfolio averages.
  const historicalByProject = new Map<string, number[]>();
  for (const s of samples) {
    if (s.period === "current") continue;
    const list = historicalByProject.get(s.project) || [];
    list.push(s.value);
    historicalByProject.set(s.project, list);
  }
  const medianOf = (arr: number[]): number => {
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  const rows: RankRow[] = currentSamples.map((s) => {
    const historical = historicalByProject.get(s.project) || [];
    const historicalMedian = historical.length >= 2 ? medianOf(historical) : null;
    return {
      project: s.project,
      value: s.value,
      historicalMedian,
      delta: historicalMedian != null ? s.value - historicalMedian : null,
    };
  });

  return rows;
}

export default function StatsRankings({
  benchmarks,
  metric,
  rowLimit = 10,
}: {
  benchmarks: PortfolioBenchmarks;
  metric: "cpl" | "cps" | "cpm";
  rowLimit?: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { cheapest, mostExpensive, total } = useMemo(() => {
    const rows = buildRanking(benchmarks, metric);
    const sorted = rows.slice().sort((a, b) => a.value - b.value);
    return {
      cheapest: sorted.slice(0, rowLimit),
      mostExpensive: sorted.slice(-rowLimit).reverse(),
      total: rows.length,
    };
  }, [benchmarks, metric, rowLimit]);

  if (total === 0) return null;

  const handleClick = (project: string) => {
    const params = new URLSearchParams(searchParams?.toString() || "");
    params.set("project", project);
    router.push(`/stats?${params.toString()}`);
  };

  const renderTable = (
    title: string,
    icon: string,
    rows: RankRow[],
    sideTone: "winner" | "expensive",
  ) => (
    <div className={`stats-rank-table is-${sideTone}`}>
      <div className="stats-rank-head">
        <span aria-hidden>{icon}</span> {title}
      </div>
      <table className="stats-rank-grid">
        <thead>
          <tr>
            <th></th>
            <th>פרויקט</th>
            <th>{METRIC_LABELS[metric]}</th>
            <th>Δ מהחציון</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const deltaCls =
              r.delta == null
                ? "is-neutral"
                : r.delta > 0
                  ? "is-up"
                  : "is-down";
            return (
              <tr
                key={r.project}
                onClick={() => handleClick(r.project)}
                tabIndex={0}
                role="button"
                title={`לחץ כדי לבחור את ${r.project}`}
              >
                <td className="stats-rank-pos">{i + 1}</td>
                <td className="stats-rank-project">{r.project}</td>
                <td className="stats-rank-value">{fmtIls(r.value)}</td>
                <td className={`stats-rank-delta ${deltaCls}`}>
                  {r.delta == null ? "—" : fmtIlsSigned(r.delta)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <section className="stats-section">
      <div className="stats-section-head">
        <h2 style={{ margin: 0 }}>
          🏆 דירוגים — {METRIC_LABELS[metric]}
        </h2>
        <span className="stats-rank-note">
          ערך נוכחי, Δ מול חציון חודשי של אותו פרויקט · לחץ על שורה כדי
          לבחור פרויקט
        </span>
      </div>
      <div className="stats-rank-grid-wrap">
        {renderTable("Top — הזולים ביותר", "🟢", cheapest, "winner")}
        {renderTable("Bottom — היקרים ביותר", "🔴", mostExpensive, "expensive")}
      </div>
    </section>
  );
}
