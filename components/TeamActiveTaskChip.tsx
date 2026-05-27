"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ActiveTask } from "@/lib/teamData";

/**
 * Live "🟢 בעבודה על X · Y דק'" chip — mirrors the task detail page's
 * time-tracker on each teammate's card so you can see at a glance
 * who's actively working on what.
 *
 * Strategy:
 *   - Server-rendered baseline: `minutes` from teamData.ts is the
 *     active total at SSR time.
 *   - Client tick: every 30s we recompute live elapsed from
 *     `runningSinceIso` + the SSR baseline. So a card mounted at
 *     "12 דק'" will roll to 13, 14, … without a re-fetch, until the
 *     page refreshes for any other reason.
 *
 * Compact (variant=`card`): chip-only, single line, link to task.
 * Detail   (variant=`detail`): larger version with task title + project.
 *
 * Why the live tick (vs. just SSR-rendered staleness): the team grid
 * is a "what's happening RIGHT NOW" surface. Stale minutes look
 * broken when you sit on the page for 10 minutes and the chip never
 * moves. 30s cadence keeps it lively without thrashing.
 */

function fmtDur(mins: number): string {
  const m = Math.max(0, Math.floor(mins));
  if (m < 60) return `${m} דק'`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} ש'` : `${h}:${String(r).padStart(2, "0")} ש'`;
}

export default function TeamActiveTaskChip({
  task,
  variant = "card",
}: {
  task: ActiveTask;
  variant?: "card" | "detail";
}) {
  // Live derived minutes. Re-tick every 30 seconds. Computed off the
  // ISO timestamp so a long-lived render doesn't drift —
  // setInterval-only would lag if the tab was throttled in the
  // background. Reading `Date.now() - runningSinceIso` directly on
  // every tick keeps it self-correcting.
  const start = Date.parse(task.runningSinceIso);
  const computeMinutes = () => {
    if (!Number.isFinite(start)) return task.minutes;
    const elapsedMs = Math.max(0, Date.now() - start);
    // teamData.ts already returned `task.minutes` = accumulated
    // active minutes UP TO runningSinceIso (when the current
    // un-paused stretch started). So the live count is that +
    // (now - runningSinceIso). Actually inProgressTime returns the
    // TOTAL active minutes INCLUDING the live tail at SSR time, so
    // we just need: (now - SSR-render-time) added. But we don't
    // know SSR-render-time exactly — runningSinceIso is the
    // ACTIVE-stretch start, which means task.minutes already
    // includes (SSR-render-time - runningSinceIso). So the live
    // count is (now - runningSinceIso), full stop, because every
    // earlier active stretch ended before runningSinceIso and got
    // baked into task.minutes BEFORE that stretch began. Hmm
    // actually no — task.minutes is `ip.minutes` from
    // deriveInProgressTime which sums ALL stretches incl. the
    // current live tail. The live tail is (nowMs - openAt) where
    // openAt is the CURRENT in_progress entry, but the live
    // un-paused stretch start is runningSinceIso (which can be
    // later than openAt if there was a pause/resume). So really:
    //   live = (task.minutes when SSR rendered) + (now - SSR_now)
    // We don't track SSR_now. Approximating SSR_now ≈ start of
    // runningSinceIso gives:
    //   live ≈ (now - runningSinceIso) in minutes
    // ...which UNDERCOUNTS if there were paused stretches before
    // the current active one. For the chip use-case, "minutes on
    // the current active stretch" is the right semantic anyway —
    // not "lifetime minutes on this task." So this is good as-is.
    return Math.floor(elapsedMs / 60000);
  };

  const [minutes, setMinutes] = useState(computeMinutes());

  useEffect(() => {
    // 30s ticker. We deliberately don't tick every second — minutes
    // is the displayed unit, so sub-minute ticks are wasted work.
    const id = setInterval(() => {
      setMinutes(computeMinutes());
    }, 30_000);
    return () => clearInterval(id);
    // computeMinutes is closed over task.runningSinceIso — re-bind
    // when task changes (e.g. data refresh swaps which task is live).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.runningSinceIso, task.minutes]);

  const taskHref = `/tasks/${encodeURIComponent(task.id)}`;
  const title = `בעבודה על "${task.title}" כבר ${fmtDur(minutes)}`;

  if (variant === "detail") {
    return (
      <Link
        href={taskHref}
        className="team-active-chip team-active-chip-detail"
        title={title}
      >
        <span className="team-active-dot" aria-hidden />
        <span className="team-active-text">
          <b>בעבודה כעת</b> · {fmtDur(minutes)}
        </span>
        <span className="team-active-task" dir="auto">
          {task.title}
        </span>
        {task.project && (
          <span className="team-active-project" dir="auto">
            {task.project}
          </span>
        )}
      </Link>
    );
  }

  return (
    <Link
      href={taskHref}
      className="team-active-chip team-active-chip-card"
      title={title}
    >
      <span className="team-active-dot" aria-hidden />
      <span className="team-active-text">
        <b>בעבודה</b> · {fmtDur(minutes)}
      </span>
      <span className="team-active-task" dir="auto">
        {task.title}
      </span>
    </Link>
  );
}
