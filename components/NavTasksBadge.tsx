"use client";

import { useEffect, useRef, useState } from "react";
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
  const spanRef = useRef<HTMLSpanElement | null>(null);

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

  // Tooltip breaks down by status so the user sees what's behind the
  // number at a glance.
  const parts: string[] = [];
  if (counts && counts.awaiting_handling > 0) {
    parts.push(`${counts.awaiting_handling} לטיפול`);
  }
  if (counts && counts.awaiting_clarification > 0) {
    parts.push(`${counts.awaiting_clarification} לבירור`);
  }
  if (counts && counts.awaiting_approval > 0) {
    parts.push(`${counts.awaiting_approval} לאישור`);
  }
  const title = parts.join(" · ");

  // Promote the breakdown to the parent <a> so hovering anywhere on the
  // "משימות" link surfaces it — not just the small pill. Native title
  // is good-enough here; a custom tooltip would be overkill for nav
  // chrome that's hovered briefly.
  useEffect(() => {
    const el = spanRef.current;
    if (!el) return;
    const link = el.closest("a");
    if (!link) return;
    if (title) link.setAttribute("title", title);
    else link.removeAttribute("title");
    return () => {
      link.removeAttribute("title");
    };
  }, [title]);

  if (!counts || counts.total <= 0) return null;

  return (
    <span
      ref={spanRef}
      className="nav-badge nav-badge-tasks"
      aria-label={title}
      title={title}
    >
      {counts.total > 99 ? "99+" : counts.total}
    </span>
  );
}
