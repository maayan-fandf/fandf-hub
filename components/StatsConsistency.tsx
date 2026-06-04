"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { PortfolioBenchmarks } from "@/lib/portfolioBenchmarks";

/**
 * Project consistency leaderboard. Coefficient of variation (CV = σ/μ)
 * for each project's monthly CPL/CPS/CPM values — a unit-less measure
 * of volatility. Two side-by-side lists:
 *   - 🪨 Most stable — low CV, "consistent producers"
 *   - 🎢 Most volatile — high CV, performance swings month to month
 *
 * Why CV instead of raw σ: a high-CPL channel naturally has a higher
 * absolute σ. Normalizing by mean lets us compare volatility across
 * very different cost levels.
 *
 * Tiers (used for the color badge):
 *   CV < 0.20 — stable
 *   0.20 ≤ CV < 0.50 — moderate
 *   CV ≥ 0.50 — volatile
 *
 * Owner asked 2026-06-05.
 */

const METRIC_LABELS: Record<"cpl" | "cps" | "cpm", string> = {
  cpl: "עלות לליד",
  cps: "עלות לתיאום",
  cpm: "עלות לביצוע",
};

const MIN_MONTHLY_SAMPLES = 3;
const TOP_N = 8;

type Row = {
  project: string;
  cv: number;
  mean: number;
  stddev: number;
  n: number;
};

function computeCv(values: number[]): { mean: number; stddev: number; cv: number } | null {
  if (values.length < MIN_MONTHLY_SAMPLES) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean <= 0) return null;
  const variance =
    values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
  const stddev = Math.sqrt(variance);
  return { mean, stddev, cv: stddev / mean };
}

function cvTier(cv: number): "stable" | "moderate" | "volatile" {
  if (cv < 0.2) return "stable";
  if (cv < 0.5) return "moderate";
  return "volatile";
}

const TIER_LABEL: Record<ReturnType<typeof cvTier>, string> = {
  stable: "יציב",
  moderate: "בינוני",
  volatile: "תנודתי",
};

const fmtIls = (n: number) => "₪" + Math.round(n).toLocaleString("he-IL");
const fmtPct = (n: number) => (n * 100).toFixed(0) + "%";

export default function StatsConsistency({
  benchmarks,
  metric,
}: {
  benchmarks: PortfolioBenchmarks;
  metric: "cpl" | "cps" | "cpm";
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { stable, volatile } = useMemo(() => {
    const samples = benchmarks.project[metric].samples;
    // Group monthly samples per project (drop "current" — that's an
    // aggregation, not a monthly observation).
    const byProject = new Map<string, number[]>();
    for (const s of samples) {
      if (s.period === "current") continue;
      const list = byProject.get(s.project) || [];
      list.push(s.value);
      byProject.set(s.project, list);
    }
    const rows: Row[] = [];
    byProject.forEach((values, project) => {
      const r = computeCv(values);
      if (!r) return;
      rows.push({ project, cv: r.cv, mean: r.mean, stddev: r.stddev, n: values.length });
    });
    return {
      stable: rows.slice().sort((a, b) => a.cv - b.cv).slice(0, TOP_N),
      volatile: rows.slice().sort((a, b) => b.cv - a.cv).slice(0, TOP_N),
    };
  }, [benchmarks.project, metric]);

  if (stable.length === 0 && volatile.length === 0) return null;

  const handleClick = (project: string) => {
    const params = new URLSearchParams(searchParams?.toString() || "");
    params.set("project", project);
    router.push(`/stats?${params.toString()}`);
  };

  const renderTable = (
    title: string,
    icon: string,
    rows: Row[],
    side: "stable" | "volatile",
  ) => (
    <div className={`stats-consistency-table is-${side}`}>
      <div className="stats-rank-head">
        <span aria-hidden>{icon}</span> {title}
      </div>
      <table className="stats-rank-grid">
        <thead>
          <tr>
            <th></th>
            <th>פרויקט</th>
            <th>CV</th>
            <th>μ</th>
            <th>σ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const tier = cvTier(r.cv);
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
                <td>
                  <span className={`stats-cv-badge is-${tier}`}>
                    {fmtPct(r.cv)}
                  </span>
                  <span className="stats-cv-tier">{TIER_LABEL[tier]}</span>
                </td>
                <td className="stats-rank-value">{fmtIls(r.mean)}</td>
                <td className="stats-rank-value">{fmtIls(r.stddev)}</td>
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
          🎢 עקביות פרויקטים — {METRIC_LABELS[metric]}
        </h2>
        <span className="stats-rank-note">
          CV = σ/μ (יחס תנודתיות חודשי) · נכלל פרויקט עם ≥{" "}
          {MIN_MONTHLY_SAMPLES} חודשים
        </span>
      </div>
      <div className="stats-rank-grid-wrap">
        {renderTable("Most stable — היציבים ביותר", "🪨", stable, "stable")}
        {renderTable(
          "Most volatile — התנודתיים ביותר",
          "🎢",
          volatile,
          "volatile",
        )}
      </div>
    </section>
  );
}
