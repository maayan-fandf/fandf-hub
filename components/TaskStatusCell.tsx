"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkTask, WorkTaskStatus } from "@/lib/appsScript";
import { fireConfetti, firePulse } from "@/lib/confetti";

// Mirror of the Apps Script / tasksWriteDirect state machine so the
// dropdown only offers transitions that the server will accept. Any
// transition that lands out-of-sync with the server is rejected
// server-side and we surface the error inline.
//
// F&F lifecycle (2026-04-24):
//   draft → awaiting_handling → in_progress → awaiting_approval → done
//                                    ⇄
//                             awaiting_clarification
// Labels = the target state name (Hebrew). Data-Plus style: click the
// pill, pick where the task goes next. No action-phrased verbs; the
// state name alone is enough context.
export const TRANSITIONS: Record<WorkTaskStatus, { to: WorkTaskStatus; label: string }[]> = {
  draft: [
    { to: "awaiting_handling", label: "ממתין לטיפול" },
    { to: "cancelled", label: "בוטל" },
  ],
  awaiting_handling: [
    { to: "in_progress", label: "בעבודה" },
    { to: "awaiting_clarification", label: "ממתין לבירור" },
    { to: "cancelled", label: "בוטל" },
  ],
  in_progress: [
    { to: "awaiting_approval", label: "ממתין לאישור" },
    { to: "awaiting_clarification", label: "ממתין לבירור" },
    { to: "awaiting_handling", label: "ממתין לטיפול" },
    { to: "cancelled", label: "בוטל" },
  ],
  awaiting_clarification: [
    { to: "in_progress", label: "בעבודה" },
    { to: "awaiting_handling", label: "ממתין לטיפול" },
    { to: "cancelled", label: "בוטל" },
  ],
  awaiting_approval: [
    { to: "done", label: "בוצע" },
    { to: "in_progress", label: "בעבודה" },
    { to: "cancelled", label: "בוטל" },
  ],
  done: [
    { to: "in_progress", label: "בעבודה" },
  ],
  // Revival paths for a cancelled task — rare but real (user flagged
  // "there's no way to un-cancel"). Re-triage lands in awaiting_handling;
  // pick-up-where-we-left-off goes straight to in_progress.
  cancelled: [
    { to: "awaiting_handling", label: "ממתין לטיפול" },
    { to: "in_progress", label: "בעבודה" },
  ],
};

export const STATUS_LABELS: Record<WorkTaskStatus, string> = {
  draft: "טיוטה",
  awaiting_handling: "ממתין לטיפול",
  in_progress: "בעבודה",
  awaiting_clarification: "ממתין לבירור",
  awaiting_approval: "ממתין לאישור",
  done: "בוצע",
  cancelled: "בוטל",
};

/**
 * Inline status cell for the tasks queue. Click opens a floating menu
 * (via React portal to document.body) with the allowed transitions for
 * the row's current status. The menu is positioned absolutely against
 * the button's bounding rect so it escapes the table wrapper's
 * overflow-x clip — which was cutting it off and pushing the row
 * layout when rendered inline.
 *
 * The pill shows the canonical status label. `sub_status` is a legacy
 * freeform column (e.g. "אושר") that previously overrode the pill text,
 * which caused "task in בעבודה bucket with pill saying אושר" confusion.
 * Now sub_status renders as a small secondary chip alongside the pill
 * when present, so the bucket + pill always match.
 */
export default function TaskStatusCell({ task }: { task: WorkTask }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(
    null,
  );
  // `pendingTo` is the target state — rendered next to the old pill as
  // a "← <target>" chip the instant the user picks it, so there's
  // immediate feedback during the slow server fanout. Cleared only if
  // the write errors; on success we do a hard reload which re-mounts
  // the component from scratch with the new task data.
  const [pendingTo, setPendingTo] = useState<WorkTaskStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click (anywhere outside BOTH the button and the
  // portaled menu) / Escape / scroll. We recompute position on scroll
  // instead of tracking it to avoid the menu drifting away from the
  // button if the page scrolls behind it.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onScrollOrResize() {
      // Close on scroll instead of repositioning — simpler + less jitter.
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  // Position the menu against the button's rect when it opens. Layout
  // effect so the menu paints at the right place on first frame (no
  // flicker).
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setCoords({
      top: r.bottom + 4,
      // RTL layout — align menu's right edge to the button's right edge.
      right: window.innerWidth - r.right,
    });
  }, [open]);

  const options = TRANSITIONS[task.status] ?? [];
  // Always show the canonical status label — sub_status is surfaced
  // separately below so the pill never lies about which bucket the
  // row lives in.
  const displayLabel = STATUS_LABELS[task.status] || task.status;

  async function transition(to: WorkTaskStatus, label: string) {
    // INSTANT feedback: close menu + flip the pill to the target state
    // before the fetch starts. Server fanout is slow; we'll reconcile
    // when refresh() completes.
    setOpen(false);
    setPendingTo(to);
    setErr(null);
    try {
      const res = await fetch("/api/worktasks/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: task.id,
          patch: { status: to, note: `inline: ${label}` },
        }),
      });
      const data = (await res.json()) as
        | { ok: true }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error("error" in data ? data.error : "Update failed");
      }
      // Celebrate transitions to `done` — fire confetti from the pill's
      // location and hold the reload long enough for the burst to play
      // (~1.3s; respects prefers-reduced-motion via the helper). The
      // handoff to `awaiting_approval` gets a smaller "send-off" pulse
      // — same DOM trick, three amber rings, ~900ms.
      const rect = btnRef.current?.getBoundingClientRect();
      const origin = rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : undefined;
      if (to === "done") {
        fireConfetti(origin);
        await new Promise((resolve) => setTimeout(resolve, 1300));
      } else if (to === "awaiting_approval") {
        firePulse(origin);
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      // router.refresh() was leaving the spinner spinning indefinitely
      // in prod — the /tasks data wasn't actually re-fetching on refresh
      // despite `export const dynamic = "force-dynamic"`. Hard reload
      // is less elegant but guarantees the user sees the new bucket
      // placement + pill. Small page flash is the tradeoff.
      window.location.reload();
    } catch (e) {
      setPendingTo(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  // During the pending window we keep the OLD label + old pill color
  // visible — the row is still sitting in its old bucket until the
  // server re-fetch arrives, so flipping just the pill would create a
  // "task in ממתין לטיפול with בעבודה pill" visual contradiction. We
  // surface the target as a small "→ X" chip next to the pill instead.
  const pendingTargetLabel = pendingTo ? STATUS_LABELS[pendingTo] : null;

  return (
    <>
      <span className="tasks-status-cell-wrap">
        <button
          ref={btnRef}
          type="button"
          className={`tasks-status-cell-btn tasks-status-${task.status}${pendingTo ? " is-pending" : ""}`}
          onClick={() => !pendingTo && setOpen((o) => !o)}
          disabled={pendingTo !== null}
          title={pendingTo ? `מעדכן ל־${pendingTargetLabel}…` : "לחץ לשינוי סטטוס"}
        >
          {displayLabel}
          {pendingTo ? (
            <span className="tasks-status-cell-spinner" aria-hidden>
              ⏳
            </span>
          ) : (
            options.length > 0 && (
              <span className="tasks-status-cell-caret" aria-hidden>
                ▾
              </span>
            )
          )}
        </button>
        {pendingTo && (
          <span
            className={`tasks-status-cell-target tasks-status-${pendingTo}`}
            aria-hidden
          >
            ← {pendingTargetLabel}
          </span>
        )}
        {/* Legacy sub_status modifier — only rendered when set and not
            pending a transition (pending clutter is enough). Shown as a
            subordinate chip, never as a replacement for the canonical
            status label. */}
        {!pendingTo && task.sub_status && (
          <span className="tasks-substatus-pill" title="sub_status">
            {task.sub_status}
          </span>
        )}
      </span>
      {err && !pendingTo && (
        <div className="tasks-status-cell-err-inline" role="alert">
          {err}
        </div>
      )}
      {open &&
        options.length > 0 &&
        coords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            className="tasks-status-cell-menu"
            role="menu"
            style={{
              position: "fixed",
              top: `${coords.top}px`,
              right: `${coords.right}px`,
            }}
          >
            {options.map((opt) => (
              <button
                key={opt.to}
                type="button"
                role="menuitem"
                className={`tasks-status-cell-item tasks-status-${opt.to}`}
                onClick={() => transition(opt.to, opt.label)}
              >
                {opt.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
