import type { PortfolioBenchmarks, BenchmarkStats } from "@/lib/portfolioBenchmarks";

/**
 * Portfolio benchmarks table — the centerpiece of /stats.
 *
 * Renders the same distribution view as the dashboard's
 * renderBenchmarksOverview (Index.html:3767): a project-aggregate row
 * (one sample per project from current period), then per-channel-
 * family rows sorted by CPL sample size descending (most data-rich
 * first). For each row: n / P25 / חציון / P75 for עלות לליד, עלות
 * לתיאום, עלות לביצוע.
 *
 * Static server-rendered table (no client interactivity needed —
 * benchmarks don't change without a page reload).
 */

type Props = {
  benchmarks: PortfolioBenchmarks;
  /** Optional: alias → raw channel names for the hover tooltip. */
  aliasToRaw?: Record<string, string[]>;
};

const fmtIls = (n: number) =>
  n > 0 ? "₪" + Math.round(n).toLocaleString("he-IL") : "—";

const METRIC_LABELS: Array<{
  key: "cpl" | "cps" | "cpm";
  label: string;
}> = [
  { key: "cpl", label: "עלות לליד" },
  { key: "cps", label: "עלות לתיאום" },
  { key: "cpm", label: "עלות לביצוע" },
];

function StatsCells({ s }: { s: BenchmarkStats | undefined }) {
  if (!s || !s.n) {
    return (
      <td colSpan={4} className="pb-muted">
        —
      </td>
    );
  }
  return (
    <>
      <td>{s.n}</td>
      <td>{fmtIls(s.p25)}</td>
      <td>{fmtIls(s.median)}</td>
      <td>{fmtIls(s.p75)}</td>
    </>
  );
}

export default function PortfolioBenchmarksTable({
  benchmarks,
  aliasToRaw,
}: Props) {
  const aliases = Object.keys(benchmarks.channels).sort((a, b) => {
    const na = benchmarks.channels[a].cpl?.n || 0;
    const nb = benchmarks.channels[b].cpl?.n || 0;
    return nb - na;
  });

  return (
    <div className="pb-wrap">
      <div className="pb-note">
        חלון: התקופה הנוכחית של כל פרויקט · ערוצים לא־ממומנים (אתר, טלפון,
        חדשות) לא נכללים בקיבוץ אבל כן בספירת הפרויקט.
      </div>

      {/* Project-aggregate distribution */}
      <div className="pb-section">
        <div className="pb-section-title">פרויקט (אגרגציה)</div>
        <table className="pb-table">
          <thead>
            <tr>
              <th></th>
              <th>n</th>
              <th>P25</th>
              <th>חציון</th>
              <th>P75</th>
            </tr>
          </thead>
          <tbody>
            {METRIC_LABELS.map((m) => {
              const s = benchmarks.project[m.key];
              return (
                <tr key={m.key}>
                  <td>{m.label}</td>
                  {s && s.n ? (
                    <>
                      <td>{s.n}</td>
                      <td>{fmtIls(s.p25)}</td>
                      <td>{fmtIls(s.median)}</td>
                      <td>{fmtIls(s.p75)}</td>
                    </>
                  ) : (
                    <td colSpan={4} className="pb-muted">
                      —
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Per-channel distribution */}
      <div className="pb-section">
        <div className="pb-section-title">
          לפי ערוץ ({aliases.length} קבוצות)
        </div>
        <div className="pb-table-scroll">
          <table className="pb-table pb-table-channels">
            <thead>
              <tr>
                <th rowSpan={2}>ערוץ</th>
                <th colSpan={4}>עלות לליד</th>
                <th colSpan={4}>עלות לתיאום</th>
                <th colSpan={4}>עלות לביצוע</th>
              </tr>
              <tr>
                <th>n</th>
                <th>P25</th>
                <th>חציון</th>
                <th>P75</th>
                <th>n</th>
                <th>P25</th>
                <th>חציון</th>
                <th>P75</th>
                <th>n</th>
                <th>P25</th>
                <th>חציון</th>
                <th>P75</th>
              </tr>
            </thead>
            <tbody>
              {aliases.map((a) => {
                const c = benchmarks.channels[a];
                const rawList = aliasToRaw?.[a] || [];
                const tip = rawList.length
                  ? `${a} · ${rawList.length} ערוצים:\n${rawList.map((n) => "• " + n).join("\n")}`
                  : a;
                return (
                  <tr key={a}>
                    <td className="pb-alias" title={tip}>
                      {a}
                    </td>
                    <StatsCells s={c.cpl} />
                    <StatsCells s={c.cps} />
                    <StatsCells s={c.cpm} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
