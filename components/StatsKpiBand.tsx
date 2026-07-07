"use client";

import { useMemo } from "react";
import CountUp from "@/components/anim/CountUp";
import type { PortfolioBenchmarks } from "@/lib/portfolioBenchmarks";
import { computeKpis, monthLabel, type KpiTile } from "@/lib/statsInsights";

/**
 * KPI band — the /stats opener. Six stat tiles anchored to the latest
 * complete month: median CPL/CPS/CPM, total spend, total leads, active
 * projects. Each carries a signed MoM delta (colored by whether the
 * direction is good news for that measure) and an 8-month sparkline.
 *
 * Tile anatomy follows the stat-tile contract: label · value (semibold,
 * proportional figures — no tabular-nums at display size) · delta vs a
 * named month · sparkline in the muted hue with the current month
 * accented.
 */

const fmtIls = (n: number) => "₪" + Math.round(n).toLocaleString("he-IL");
const fmtInt = (n: number) => Math.round(n).toLocaleString("he-IL");

/** Compact ₪ for big sums: ₪1.24M / ₪382K / ₪940. */
function fmtIlsCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return "₪" + (n / 1_000_000).toFixed(2) + "M";
  if (abs >= 10_000) return "₪" + Math.round(n / 1000) + "K";
  return fmtIls(n);
}

function Sparkline({ points }: { points: number[] }) {
  const path = useMemo(() => {
    const vals = points.filter((v) => Number.isFinite(v));
    if (vals.length < 2) return null;
    const w = 88;
    const h = 26;
    const pad = 3;
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const step = (w - pad * 2) / (points.length - 1);
    const xy = points.map((v, i) => [
      pad + i * step,
      h - pad - ((v - min) / span) * (h - pad * 2),
    ]);
    return {
      line: xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" "),
      last: xy[xy.length - 1],
      w,
      h,
    };
  }, [points]);
  if (!path) return null;
  return (
    <svg
      className="kpi-spark"
      viewBox={`0 0 ${path.w} ${path.h}`}
      width={path.w}
      height={path.h}
      aria-hidden
    >
      <path
        d={path.line}
        fill="none"
        stroke="var(--muted)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.55"
      />
      <circle
        cx={path.last[0]}
        cy={path.last[1]}
        r="3"
        fill="var(--brand)"
        stroke="var(--surface)"
        strokeWidth="2"
      />
    </svg>
  );
}

function DeltaChip({ tile, prev }: { tile: KpiTile; prev: string | null }) {
  if (!tile.delta || prev == null) {
    return <span className="kpi-delta is-flat">—</span>;
  }
  const { pct, goodness } = tile.delta;
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "•";
  const cls =
    goodness === "good" ? "is-good" : goodness === "bad" ? "is-bad" : "is-flat";
  return (
    <span
      className={`kpi-delta ${cls}`}
      title={`מול ${monthLabel(prev)}`}
    >
      {arrow} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

export default function StatsKpiBand({
  benchmarks,
}: {
  benchmarks: PortfolioBenchmarks;
}) {
  const { tiles, anchor, prev } = useMemo(
    () => computeKpis(benchmarks),
    [benchmarks],
  );
  if (!anchor || tiles.length === 0) return null;

  return (
    <section className="stats-section kpi-section">
      <div className="kpi-band-head">
        <h2>תמונת מצב — {monthLabel(anchor)}</h2>
        <span className="kpi-band-note">
          החודש המלא האחרון בנתונים · שינוי מול {prev ? monthLabel(prev) : "—"}
        </span>
      </div>
      <div className="kpi-band">
        {tiles.map((t) => (
          <div key={t.key} className="kpi-card" title={t.hint}>
            <div className="kpi-label">{t.label}</div>
            <div className="kpi-value">
              {t.value == null ? (
                "—"
              ) : (
                <CountUp
                  value={t.value}
                  format={
                    t.format === "ils"
                      ? t.value >= 10_000
                        ? fmtIlsCompact
                        : fmtIls
                      : fmtInt
                  }
                />
              )}
            </div>
            <div className="kpi-foot">
              <DeltaChip tile={t} prev={prev} />
              <Sparkline points={t.spark} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
