"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

type StatusCounts = {
  awaiting_handling: number;
  in_progress: number;
  awaiting_clarification: number;
  awaiting_approval: number;
};

type Counts = StatusCounts & {
  total: number;
  actionable: StatusCounts;
};

/**
 * Badge next to the "משימות" topnav link — total of every open task
 * the user is involved with (author / approver / PM / assignee /
 * mentioned-in-discussion). The tooltip splits that count into:
 *   - דורש פעולה ממך: per-status, only counting where the user has
 *     the action-owning role (assignee / approver / clarify owner)
 *   - במעקב: the rest — tasks they're aware of but waiting on others
 *
 * The split prevents the misread where e.g. an author of 7 tasks
 * waiting on someone else to approve sees "7 לאישור" and thinks
 * they have 7 approvals to do.
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
          | {
              ok: true;
              total: number;
              breakdown: StatusCounts;
              actionable_breakdown?: StatusCounts;
            }
          | { ok: false; error: string };
        if (cancelled) return;
        if ("ok" in data && data.ok) {
          // actionable_breakdown is a recent addition; if a stale
          // server response omits it, fall back to "everything is
          // actionable" — preserves the old visual until the API
          // catches up.
          const actionable: StatusCounts = data.actionable_breakdown ?? {
            awaiting_handling: data.breakdown.awaiting_handling ?? 0,
            in_progress: data.breakdown.in_progress ?? 0,
            awaiting_clarification: data.breakdown.awaiting_clarification ?? 0,
            awaiting_approval: data.breakdown.awaiting_approval ?? 0,
          };
          setCounts({
            total: data.total,
            awaiting_handling: data.breakdown.awaiting_handling ?? 0,
            in_progress: data.breakdown.in_progress ?? 0,
            awaiting_clarification: data.breakdown.awaiting_clarification ?? 0,
            awaiting_approval: data.breakdown.awaiting_approval ?? 0,
            actionable,
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

  // Tooltip breaks the badge total into "דורש פעולה ממך" (where the
  // user holds the action-owning role for the row's status) and
  // "במעקב" (the rest — informational presence). Each line lists only
  // its non-zero per-status counts. Newline between lines renders as
  // a line break in the native title attribute on every modern
  // browser; if a renderer flattens it, the lines fall back to one
  // long line with a separator, still readable.
  const buildTitle = (): string => {
    if (!counts) return "";
    const actionableParts: string[] = [];
    const watchingParts: string[] = [];
    const push = (
      list: string[],
      n: number,
      label: string,
      hint?: string,
    ) => {
      if (n > 0) {
        list.push(hint ? `${n} ${label} ${hint}` : `${n} ${label}`);
      }
    };
    push(actionableParts, counts.actionable.awaiting_handling, "לטיפול");
    push(actionableParts, counts.actionable.in_progress, "בעבודה");
    push(
      actionableParts,
      counts.actionable.awaiting_clarification,
      "לבירור",
    );
    push(actionableParts, counts.actionable.awaiting_approval, "לאישור");

    push(
      watchingParts,
      counts.awaiting_handling - counts.actionable.awaiting_handling,
      "לטיפול",
      "(אחרים)",
    );
    push(
      watchingParts,
      counts.in_progress - counts.actionable.in_progress,
      "בעבודה",
      "(אחרים)",
    );
    push(
      watchingParts,
      counts.awaiting_clarification - counts.actionable.awaiting_clarification,
      "לבירור",
      "(אחרים)",
    );
    push(
      watchingParts,
      counts.awaiting_approval - counts.actionable.awaiting_approval,
      "לאישור",
      "(אחרים)",
    );

    const lines: string[] = [];
    if (actionableParts.length > 0) {
      lines.push(`דורש פעולה ממך: ${actionableParts.join(" · ")}`);
    }
    if (watchingParts.length > 0) {
      lines.push(`במעקב: ${watchingParts.join(" · ")}`);
    }
    return lines.join("\n");
  };
  const title = buildTitle();

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
