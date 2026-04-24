"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkTask, WorkTaskStatus } from "@/lib/appsScript";

// Mirror of the Apps Script / tasksWriteDirect state machine so the
// dropdown only offers transitions that the server will accept. Any
// transition that lands out-of-sync with the server is rejected
// server-side and we surface the error inline.
const TRANSITIONS: Record<WorkTaskStatus, { to: WorkTaskStatus; label: string }[]> = {
  draft: [
    { to: "awaiting_approval", label: "שלח לאישור" },
    { to: "cancelled", label: "בטל" },
  ],
  awaiting_approval: [
    { to: "in_progress", label: "✓ אשר — העבר לעבודה" },
    { to: "awaiting_clarification", label: "? בקש בירור" },
    { to: "cancelled", label: "דחה" },
  ],
  awaiting_clarification: [
    { to: "in_progress", label: "✓ סיום בירור — עבור לעבודה" },
    { to: "awaiting_approval", label: "→ חזרה לאישור" },
    { to: "cancelled", label: "בטל" },
  ],
  in_progress: [
    { to: "done", label: "✓ סיים — בוצע" },
    { to: "awaiting_clarification", label: "? צריך בירור" },
    { to: "cancelled", label: "בטל" },
  ],
  done: [
    { to: "in_progress", label: "פתח מחדש" },
  ],
  cancelled: [],
};

const STATUS_LABELS: Record<WorkTaskStatus, string> = {
  draft: "טיוטה",
  awaiting_approval: "ממתין לאישור",
  in_progress: "בעבודה",
  awaiting_clarification: "ממתין לבירור",
  done: "בוצע",
  cancelled: "בוטל",
};

/**
 * Inline status cell for the tasks queue. Click opens a small menu
 * showing the allowed transitions for the row's current status. Each
 * menu item POSTs to /api/worktasks/update and refreshes the list on
 * success. A short busy spinner swaps in while the request is open.
 *
 * Uses the row's `sub_status` as the visible label when set (matches
 * Data Plus's "אושר" / "ממתין לטיפול" inside the בעבודה bucket); falls
 * back to the status label otherwise. The pill's color tone always
 * comes from the canonical status so the bucket stays scannable.
 */
export default function TaskStatusCell({ task }: { task: WorkTask }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<WorkTaskStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape so the menu feels native.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const options = TRANSITIONS[task.status] ?? [];
  const displayLabel =
    task.sub_status || STATUS_LABELS[task.status] || task.status;

  async function transition(to: WorkTaskStatus, label: string) {
    setBusy(to);
    setErr(null);
    // No inline note prompt — we skip the window.prompt to keep the
    // cell interaction tight. Notes can still be added on the detail
    // page where there's room for a textarea.
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
    <div className="tasks-status-cell" ref={rootRef}>
      <button
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
      {open && options.length > 0 && (
        <div className="tasks-status-cell-menu" role="menu">
          {options.map((opt) => (
            <button
              key={opt.to}
              type="button"
              role="menuitem"
              className="tasks-status-cell-item"
              disabled={busy !== null}
              onClick={() => transition(opt.to, opt.label)}
            >
              {busy === opt.to ? "…" : opt.label}
            </button>
          ))}
        </div>
      )}
      {err && <div className="tasks-status-cell-err">{err}</div>}
    </div>
  );
}
