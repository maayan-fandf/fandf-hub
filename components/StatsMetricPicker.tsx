"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/**
 * Three-pill metric picker for /stats's sticky context bar. URL-driven
 * via `?metric=cpl|cps|cpm` so selections are shareable + survive
 * reload, and the Gaussian section is a pure renderer (no internal
 * state).
 */

const METRICS: Array<{ key: "cpl" | "cps" | "cpm"; label: string }> = [
  { key: "cpl", label: "עלות לליד" },
  { key: "cps", label: "עלות לתיאום" },
  { key: "cpm", label: "עלות לביצוע" },
];

export default function StatsMetricPicker({
  selected,
}: {
  selected: "cpl" | "cps" | "cpm";
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const setMetric = (m: "cpl" | "cps" | "cpm") => {
    const params = new URLSearchParams(searchParams?.toString() || "");
    if (m === "cpl") params.delete("metric"); // CPL is the default — keep URL clean
    else params.set("metric", m);
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `/stats?${qs}` : "/stats");
    });
  };

  return (
    <div
      className="stats-metric-picker"
      role="radiogroup"
      aria-label="בחירת מטריקה"
    >
      {METRICS.map((m) => (
        <button
          key={m.key}
          type="button"
          role="radio"
          aria-checked={selected === m.key}
          className={"stats-pill" + (selected === m.key ? " is-active" : "")}
          onClick={() => setMetric(m.key)}
          disabled={isPending}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
