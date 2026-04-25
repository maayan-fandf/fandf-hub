"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

type Counts = {
  total: number;
  awaiting_handling: number;
  awaiting_clarification: number;
  awaiting_approval: number;
};

/**
 * Badge next to the "משימות" topnav link — combined count of every
 * state where the user (or their view-as identity) needs to act:
 *   - assignee on ממתין לטיפול / ממתין לבירור (do the work, or
 *     unblock it)
 *   - approver on ממתין לאישור (review + approve / send back)
 *
 * Refreshes on pathname change so navigating to /tasks, ticking some
 * off, then leaving updates the count without a full reload. Same
 * pattern as NavMentionBadge.
 */
export default function NavTasksBadge() {
  const pathname = usePathname();
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/tasks/pending-count", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as
          | { ok: true; total: number; breakdown: Counts }
          | { ok: false; error: string };
        if (cancelled) return;
        if ("ok" in data && data.ok) {
          setCounts({
            total: data.total,
            awaiting_handling: data.breakdown.awaiting_handling ?? 0,
            awaiting_clarification: data.breakdown.awaiting_clarification ?? 0,
            awaiting_approval: data.breakdown.awaiting_approval ?? 0,
          });
        }
      } catch {
        // Silent — missing badge is better than a noisy error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  if (!counts || counts.total <= 0) return null;

  // Tooltip breaks down by status so the user sees what's behind the
  // number at a glance.
  const parts: string[] = [];
  if (counts.awaiting_handling > 0) {
    parts.push(`${counts.awaiting_handling} ממתינות לטיפול`);
  }
  if (counts.awaiting_clarification > 0) {
    parts.push(`${counts.awaiting_clarification} ממתינות לבירור`);
  }
  if (counts.awaiting_approval > 0) {
    parts.push(`${counts.awaiting_approval} ממתינות לאישורך`);
  }
  const title = parts.join(" · ");

  return (
    <span className="nav-badge nav-badge-tasks" aria-label={title} title={title}>
      {counts.total > 99 ? "99+" : counts.total}
    </span>
  );
}
