"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import CountUp from "./anim/CountUp";
import { countBadge } from "@/lib/anim";

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
 * Badge next to the "משימות" topnav link — counts only tasks that are
 * actionable BY THE USER right now: per-status, where the user holds
 * the action-owning role (assignee on awaiting_handling/in_progress,
 * clarify owner on awaiting_clarification, approver on awaiting_approval).
 *
 * Deliberately EXCLUDES: blocked (חסום — waiting on a dependency, not
 * yet the user's to do; it starts counting only once the dependency
 * cascade flips it to awaiting_handling), drafts, and tasks awaiting
 * someone else's action. Those are still visible in /tasks and surface
 * in the tooltip's "במעקב" tier — they just don't inflate the number.
 *
 * The tooltip splits the picture into:
 *   - דורש פעולה ממך: the actionable items behind the badge number
 *   - במעקב: open tasks you're involved with but waiting on others
 *     (incl. awaiting-others-approval) — informational, not counted
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

  // The badge number = how many tasks are mine to act on right now.
  // Sum of the role-aware actionable breakdown (assignee on
  // handling/in_progress, clarify owner on clarification, approver on
  // approval). Blocked / drafts / awaiting-someone-else never enter
  // this sum — they live in the tooltip's "במעקב" tier and in /tasks.
  const actionableTotal = counts
    ? counts.actionable.awaiting_handling +
      counts.actionable.in_progress +
      counts.actionable.awaiting_clarification +
      counts.actionable.awaiting_approval
    : 0;

  if (!counts || actionableTotal <= 0) return null;

  return (
    <span
      ref={spanRef}
      className="nav-badge nav-badge-tasks"
      aria-label={title}
      title={title}
    >
      <CountUp value={actionableTotal} duration={500} format={countBadge} />
    </span>
  );
}
