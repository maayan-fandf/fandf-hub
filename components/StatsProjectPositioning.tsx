"use client";

import { useMemo } from "react";
import type { PortfolioBenchmarks } from "@/lib/portfolioBenchmarks";
import { projectPositioning } from "@/lib/statsInsights";

/**
 * Positioning strip at the top of the project drill-down tab — the
 * selected project against the whole book, one card per metric:
 * current value, portfolio percentile (0 = הזול בתיק), z-flag, and Δ
 * vs the project's own monthly median. The detailed distributions
 * live in the analysis tab; this is the one-glance answer to "איפה
 * הפרויקט הזה עומד".
 */

const fmtIls = (n: number) => "₪" + Math.round(n).toLocaleString("he-IL");

export default function StatsProjectPositioning({
  benchmarks,
  project,
}: {
  benchmarks: PortfolioBenchmarks;
  project: string;
}) {
  const items = useMemo(
    () => projectPositioning(benchmarks, project),
    [benchmarks, project],
  );
  if (items.length === 0) return null;

  return (
    <section className="stats-section pos-section">
      <div className="stats-section-head">
        <h2 style={{ margin: 0 }}>🎯 {project} מול התיק</h2>
        <span className="stats-rank-note">
          תקופת הקמפיין הנוכחית · אחוזון 0 = הזול בתיק
        </span>
      </div>
      <div className="pos-strip">
        {items.map((it) => {
          const zTone =
            it.z == null
              ? "is-flat"
              : it.z >= 2
                ? "is-bad"
                : it.z >= 1.5
                  ? "is-warn"
                  : it.z <= -1.5
                    ? "is-good"
                    : "is-flat";
          const deltaTone =
            it.deltaVsOwnPct == null
              ? "is-flat"
              : it.deltaVsOwnPct > 10
                ? "is-bad"
                : it.deltaVsOwnPct < -10
                  ? "is-good"
                  : "is-flat";
          return (
            <div key={it.metric} className="pos-card">
              <div className="pos-metric">{it.label}</div>
              <div className="pos-value">{fmtIls(it.value)}</div>
              <div className="pos-chips">
                <span
                  className="pos-chip"
                  title="0 = הזול בתיק, 100 = היקר בתיק"
                >
                  אחוזון {it.percentile}
                </span>
                {it.z != null && (
                  <span
                    className={`pos-chip ${zTone}`}
                    title="מרחק מהממוצע בסטיות תקן"
                  >
                    {it.z >= 0 ? "+" : "−"}
                    {Math.abs(it.z).toFixed(1)}σ
                  </span>
                )}
                {it.deltaVsOwnPct != null && (
                  <span
                    className={`pos-chip ${deltaTone}`}
                    title="מול החציון החודשי ההיסטורי של הפרויקט"
                  >
                    {it.deltaVsOwnPct >= 0 ? "+" : "−"}
                    {Math.abs(it.deltaVsOwnPct).toFixed(0)}% מול עצמו
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
