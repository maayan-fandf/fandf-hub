"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { WorkTask, WorkTaskStatus } from "@/lib/appsScript";

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
const TRANSITIONS: Record<WorkTaskStatus, { to: WorkTaskStatus; label: string }[]> = {
  draft: [
    { to: "awaiting_handling", label: "ממתין לטיפול" },
    { to: "cancelled", label: "בוטל" },
  ],
  awaiting_handling: [
    { to: "in_progress", label: "בעבודה" },
    { to: "cancelled", label: "בוטל" },
  ],
  in_progress: [
    { to: "awaiting_approval", label: "ממתין לאישור" },
    { to: "awaiting_clarification", label: "ממתין לבירור" },
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
  cancelled: [],
};

const STATUS_LABELS: Record<WorkTaskStatus, string> = {
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
 * Uses the row's `sub_status` as the visible label when set (matches
 * Data Plus's "אושר" / "ממתין לטיפול" inside the בעבודה bucket); falls
 * back to the status label otherwise.
 */
export default function TaskStatusCell({ task }: { task: WorkTask }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(
    null,
  );
  const [busy, setBusy] = useState<WorkTaskStatus | null>(null);
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
  const displayLabel =
    task.sub_status || STATUS_LABELS[task.status] || task.status;

  async function transition(to: WorkTaskStatus, label: string) {
    setBusy(to);
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
      setOpen(false);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`tasks-status-cell-btn tasks-status-${task.status}`}
        onClick={() => setOpen((o) => !o)}
        disabled={busy !== null}
        title="לחץ לשינוי סטטוס"
      >
        {displayLabel}
        {options.length > 0 && (
          <span className="tasks-status-cell-caret" aria-hidden>
            ▾
          </span>
        )}
      </button>
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
                disabled={busy !== null}
                onClick={() => transition(opt.to, opt.label)}
              >
                {busy === opt.to ? "…" : opt.label}
              </button>
            ))}
            {err && <div className="tasks-status-cell-err">{err}</div>}
          </div>,
          document.body,
        )}
    </>
  );
}
