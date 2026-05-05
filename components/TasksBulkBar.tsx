"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TasksPerson, WorkTaskStatus } from "@/lib/appsScript";
import { displayNameOf } from "@/lib/personDisplay";

type Props = {
  selectedIds: Set<string>;
  people: TasksPerson[];
  onClear: () => void;
};

const STATUSES: { val: WorkTaskStatus | ""; label: string }[] = [
  { val: "", label: "סטטוס…" },
  { val: "awaiting_handling", label: "ממתין לטיפול" },
  { val: "in_progress", label: "בעבודה" },
  { val: "awaiting_clarification", label: "ממתין לבירור" },
  { val: "awaiting_approval", label: "ממתין לאישור" },
  { val: "done", label: "בוצע" },
  { val: "cancelled", label: "בוטל" },
];

/**
 * Sticky footer that appears once any tasks are checked in the
 * /tasks queue. Lets a user fan out a single change across many
 * tasks — bulk reassign / approver / status — without opening each
 * one. Each action POSTs /api/worktasks/update once per id (parallel
 * via Promise.all) so the existing per-task validation, status-
 * machine guards, and notification fan-out all keep working.
 *
 * Selection is local to TasksQueue (in-memory Set<id>); navigation
 * away clears it. The bar itself is purely a dispatcher.
 */
export default function TasksBulkBar({
  selectedIds,
  people,
  onClear,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const assigneeRef = useRef<HTMLInputElement>(null);
  const approverRef = useRef<HTMLInputElement>(null);

  if (selectedIds.size === 0) return null;
  const ids = Array.from(selectedIds);

  async function applyPatch(
    label: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    setError(null);
    setBusy(label);
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch("/api/worktasks/update", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id,
              patch: { ...patch, note: `bulk: ${label}` },
            }),
          }).then(async (r) => {
            const data = (await r.json().catch(() => ({}))) as {
              ok?: boolean;
              error?: string;
            };
            if (!r.ok || !data.ok) {
              throw new Error(data.error || `${id}: HTTP ${r.status}`);
            }
          }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        const reasons = failed
          .map((r) =>
            r.status === "rejected"
              ? r.reason instanceof Error
                ? r.reason.message
                : String(r.reason)
              : "",
          )
          .filter(Boolean)
          .slice(0, 3)
          .join(" · ");
        setError(`נכשלו ${failed.length} מתוך ${ids.length}: ${reasons}`);
      }
      // Refresh server data so successful changes show up. Clear
      // selection only after the route has the new data.
      startTransition(() => {
        router.refresh();
        onClear();
      });
    } finally {
      setBusy(null);
    }
  }

  function bulkStatus(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value as WorkTaskStatus | "";
    if (!val) return;
    const label = STATUSES.find((s) => s.val === val)?.label || val;
    if (
      !window.confirm(
        `לעדכן ${ids.length} משימות לסטטוס "${label}"?`,
      )
    ) {
      e.target.value = "";
      return;
    }
    void applyPatch(`סטטוס → ${label}`, { status: val });
    e.target.value = "";
  }

  function bulkAssignee() {
    const el = assigneeRef.current;
    if (!el) return;
    const v = el.value.trim();
    if (!v) return;
    if (!window.confirm(`להחליף עובד מבצע ל-${v} בכל ${ids.length}?`)) return;
    void applyPatch(`עובד מבצע → ${v}`, { assignees: [v] });
    el.value = "";
  }

  function bulkApprover() {
    const el = approverRef.current;
    if (!el) return;
    const v = el.value.trim();
    if (!v) return;
    if (!window.confirm(`להחליף מאשר ל-${v} בכל ${ids.length}?`)) return;
    void applyPatch(`מאשר → ${v}`, { approver_email: v });
    el.value = "";
  }

  return (
    <div
      className="tasks-bulk-bar"
      role="region"
      aria-label="פעולות מרובות על המשימות שנבחרו"
    >
      <div className="tasks-bulk-bar-info">
        <b>{ids.length}</b> משימות נבחרו
      </div>

      <select
        className="tasks-bulk-action"
        onChange={bulkStatus}
        defaultValue=""
        disabled={isPending || !!busy}
        aria-label="שנה סטטוס לכל הנבחרים"
      >
        {STATUSES.map((s) => (
          <option key={s.val} value={s.val}>
            {s.label}
          </option>
        ))}
      </select>

      <div className="tasks-bulk-input-group">
        <input
          ref={assigneeRef}
          type="text"
          list="tasks-people"
          placeholder="עובד מבצע…"
          className="tasks-bulk-input"
          dir="ltr"
          disabled={isPending || !!busy}
        />
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={bulkAssignee}
          disabled={isPending || !!busy}
        >
          החלף
        </button>
      </div>

      <div className="tasks-bulk-input-group">
        <input
          ref={approverRef}
          type="text"
          list="tasks-people"
          placeholder="מאשר…"
          className="tasks-bulk-input"
          dir="ltr"
          disabled={isPending || !!busy}
        />
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={bulkApprover}
          disabled={isPending || !!busy}
        >
          החלף
        </button>
      </div>

      <div className="tasks-bulk-bar-spacer" />

      <button
        type="button"
        className="btn-ghost btn-sm"
        onClick={onClear}
        disabled={isPending || !!busy}
      >
        בטל בחירה
      </button>

      {(busy || isPending) && (
        <span className="tasks-bulk-status" aria-live="polite">
          ⏳ {busy || "מעדכן…"}
        </span>
      )}
      {error && (
        <div className="tasks-bulk-error" role="alert">
          {error}
        </div>
      )}
      {/* People datalist is shared with the filter bar above; we rely
          on its #tasks-people id being mounted on the same page. If
          this component renders without that, the autocomplete falls
          back to free-text — still works, just no suggestions. */}
      <datalist id="tasks-bulk-people-fallback">
        {people.map((p) => (
          <option key={p.email} value={p.email}>
            {displayNameOf(p)} · {p.role}
          </option>
        ))}
      </datalist>
    </div>
  );
}
