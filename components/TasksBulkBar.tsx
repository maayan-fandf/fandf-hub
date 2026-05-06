"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TasksPerson, WorkTaskStatus } from "@/lib/appsScript";
import PersonCombobox from "./PersonCombobox";

type Props = {
  selectedIds: Set<string>;
  people: TasksPerson[];
  /** Distinct campaign values present on the loaded set — drives the
   *  campaign datalist so users get autocomplete instead of typing
   *  free-text. Optional; the input falls back to free-text when empty. */
  campaigns?: string[];
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

const PRIORITIES: { val: string; label: string }[] = [
  { val: "", label: "דחיפות…" },
  { val: "1", label: "🔥 גבוהה" },
  { val: "2", label: "רגילה" },
  { val: "3", label: "⏬ נמוכה" },
];

/**
 * Sticky footer that appears once any tasks are checked in the
 * /tasks queue. Lets a user fan out a single change across many
 * tasks — bulk status / assignee / approver / priority / campaign /
 * cancel — without opening each one. Each action POSTs
 * /api/worktasks/update once per id (parallel via Promise.allSettled)
 * so the existing per-task validation, status-machine guards, and
 * notification fan-out all keep working.
 *
 * Selection is local to TasksQueue (in-memory Set<id>); navigation
 * away clears it. The bar itself is purely a dispatcher.
 */
export default function TasksBulkBar({
  selectedIds,
  people,
  campaigns = [],
  onClear,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // PersonCombobox is controlled — wire its state here. Same pattern
  // as FilterPersonInput; both pickers reset to empty after a
  // successful "החלף" so the bar is ready for the next batch.
  const [assigneeValue, setAssigneeValue] = useState("");
  const [approverValue, setApproverValue] = useState("");
  const [campaignValue, setCampaignValue] = useState("");

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

  function bulkPriority(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    if (!val) return;
    const label = PRIORITIES.find((p) => p.val === val)?.label || val;
    if (
      !window.confirm(
        `לעדכן ${ids.length} משימות לדחיפות "${label}"?`,
      )
    ) {
      e.target.value = "";
      return;
    }
    void applyPatch(`דחיפות → ${label}`, { priority: parseInt(val, 10) });
    e.target.value = "";
  }

  function bulkAssignee() {
    const v = assigneeValue.trim();
    if (!v) return;
    if (!window.confirm(`להחליף עובד מבצע ל-${v} בכל ${ids.length}?`)) return;
    void applyPatch(`עובד מבצע → ${v}`, { assignees: [v] });
    setAssigneeValue("");
  }

  function bulkApprover() {
    const v = approverValue.trim();
    if (!v) return;
    if (!window.confirm(`להחליף מאשר ל-${v} בכל ${ids.length}?`)) return;
    void applyPatch(`מאשר → ${v}`, { approver_email: v });
    setApproverValue("");
  }

  function bulkCampaign() {
    const v = campaignValue.trim();
    if (!v) return;
    if (!window.confirm(`לשייך ${ids.length} משימות לבריף "${v}"?`)) return;
    void applyPatch(`בריף → ${v}`, { campaign: v });
    setCampaignValue("");
  }

  function bulkSoftDelete() {
    if (
      !window.confirm(
        `לבטל ${ids.length} משימות? הסטטוס שלהן יוגדר כ"בוטל" ` +
          "וניתן לשחזר אותן בכל זמן (סטטוס → ממתין לטיפול וכו').",
      )
    ) {
      return;
    }
    void applyPatch("ביטול", { status: "cancelled" });
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

      <select
        className="tasks-bulk-action"
        onChange={bulkPriority}
        defaultValue=""
        disabled={isPending || !!busy}
        aria-label="שנה דחיפות לכל הנבחרים"
      >
        {PRIORITIES.map((p) => (
          <option key={p.val} value={p.val}>
            {p.label}
          </option>
        ))}
      </select>

      <div className="tasks-bulk-input-group tasks-bulk-input-group-people">
        <span className="tasks-bulk-input-label">עובד מבצע</span>
        <PersonCombobox
          value={assigneeValue}
          onChange={setAssigneeValue}
          options={people}
          placeholder="חפש לפי שם או מייל"
          disabled={isPending || !!busy}
        />
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={bulkAssignee}
          disabled={isPending || !!busy || !assigneeValue.trim()}
        >
          החלף
        </button>
      </div>

      <div className="tasks-bulk-input-group tasks-bulk-input-group-people">
        <span className="tasks-bulk-input-label">מאשר</span>
        <PersonCombobox
          value={approverValue}
          onChange={setApproverValue}
          options={people}
          placeholder="חפש לפי שם או מייל"
          disabled={isPending || !!busy}
        />
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={bulkApprover}
          disabled={isPending || !!busy || !approverValue.trim()}
        >
          החלף
        </button>
      </div>

      <div className="tasks-bulk-input-group">
        <span className="tasks-bulk-input-label">בריף</span>
        <input
          type="text"
          list="tasks-bulk-campaigns"
          className="tasks-bulk-input"
          placeholder="שם בריף…"
          value={campaignValue}
          onChange={(e) => setCampaignValue(e.target.value)}
          disabled={isPending || !!busy}
        />
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={bulkCampaign}
          disabled={isPending || !!busy || !campaignValue.trim()}
        >
          החלף
        </button>
      </div>

      <div className="tasks-bulk-bar-spacer" />

      {/* Soft-delete = status → cancelled. Distinct red-styled
          button so the destructive action reads as destructive even
          though the underlying call is identical to the status
          dropdown's "בוטל" option. Using a button instead of just
          relying on the dropdown gives the action a clearer affordance. */}
      <button
        type="button"
        className="btn-danger btn-sm tasks-bulk-soft-delete"
        onClick={bulkSoftDelete}
        disabled={isPending || !!busy}
        title="הסטטוס יוגדר כ'בוטל'. ניתן לשחזר בכל זמן ע״י החזרת הסטטוס למצב פעיל."
      >
        🗑️ בטל את הנבחרים
      </button>

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

      {/* Datalist for campaign autocomplete. Drawn from the same
          campaignOptions the filter form uses; missing → free-text. */}
      <datalist id="tasks-bulk-campaigns">
        {campaigns.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </div>
  );
}
