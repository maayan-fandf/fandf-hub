"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TasksPerson, WorkTaskStatus } from "@/lib/appsScript";
import PersonCombobox from "./PersonCombobox";
import PeopleMultiCombobox from "./PeopleMultiCombobox";

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
  // Success-toast state — when a bulk action succeeds we keep the
  // bar open for ~5s with a result banner ("✅ N משימות עודכנו") so
  // the user sees feedback before rows disappear into a hidden bucket
  // (cancelled → archive fold being the most confusing case). Auto-
  // dismiss timer resets if the user dismisses early.
  type LastResult = {
    label: string;
    successCount: number;
    failCount: number;
    /** True for the soft-delete action — we add a "show in archive"
     *  CTA that flips the user's hide_archived pref so the just-
     *  cancelled rows actually become visible. */
    isCancellation: boolean;
  };
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear the timer on unmount so a stale tick doesn't fire after
  // navigation.
  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, []);

  if (selectedIds.size === 0 && !lastResult) return null;
  const ids = Array.from(selectedIds);

  async function applyPatch(
    label: string,
    patch: Record<string, unknown>,
    opts: { isCancellation?: boolean } = {},
  ): Promise<void> {
    setError(null);
    setLastResult(null);
    setBusy(label);
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
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
      const successCount = ids.length - failed.length;
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
      // Refresh server data so successful changes show up.
      startTransition(() => {
        router.refresh();
      });
      // Show the success banner + clear selection. The bar stays
      // visible (because lastResult is set) so the user sees the
      // confirmation before it auto-dismisses. Selection clears
      // immediately so a follow-up action doesn't accidentally
      // re-affect the same rows.
      if (successCount > 0) {
        setLastResult({
          label,
          successCount,
          failCount: failed.length,
          isCancellation: !!opts.isCancellation,
        });
      }
      onClear();
      // Auto-dismiss the success banner after 6s. The user can also
      // dismiss early via the "סגור" button on the banner.
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = setTimeout(() => {
        setLastResult(null);
        dismissTimerRef.current = null;
      }, 6000);
    } finally {
      setBusy(null);
    }
  }

  /** Click handler for the "הצג בארכיון" CTA shown after a bulk
   *  cancellation. Flips the user's `hide_archived` pref to false so
   *  the just-cancelled rows actually become visible in the queue,
   *  then refreshes server data. Mirrors what TasksArchiveToggle
   *  does — but pre-targeted to the "show" direction. */
  async function showArchive() {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    try {
      await fetch("/api/me/prefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hide_archived: false }),
      });
    } catch {
      /* refresh anyway — the worst case is the user clicks the
       * archive toggle manually */
    }
    setLastResult(null);
    startTransition(() => {
      router.refresh();
    });
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
    // assigneeValue holds a CSV of emails — PeopleMultiCombobox's store
    // format. Parse, dedupe (case-insensitive), and apply as the new
    // assignees array for every selected task. Empty after a single
    // backspace also counts as "no change requested" — bail.
    const list = assigneeValue
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0) return;
    const labelList = list.length === 1 ? list[0] : `${list.length} עובדים`;
    if (
      !window.confirm(
        `להחליף את העובדים ל-${labelList} בכל ${ids.length}?`,
      )
    ) {
      return;
    }
    void applyPatch(`עובדים → ${labelList}`, { assignees: list });
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
    void applyPatch("ביטול", { status: "cancelled" }, { isCancellation: true });
  }

  function dismissResult() {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    setLastResult(null);
  }

  // Success banner — rendered IN PLACE OF the action controls when
  // a bulk action just succeeded. Bar stays visible long enough for
  // the user to register the change and (for cancellations) jump to
  // the archive view to see the rows that just disappeared.
  if (lastResult && selectedIds.size === 0) {
    return (
      <div
        className="tasks-bulk-bar tasks-bulk-bar-success"
        role="region"
        aria-label="תוצאת הפעולה שזה עתה הסתיימה"
      >
        <div
          className="tasks-bulk-success-message"
          aria-live="polite"
        >
          <span className="tasks-bulk-success-icon" aria-hidden>
            ✅
          </span>
          <span>
            {lastResult.successCount === 1
              ? "משימה אחת"
              : `${lastResult.successCount} משימות`}
            {" — "}
            <b>{lastResult.label}</b>
            {lastResult.failCount > 0 && (
              <span className="tasks-bulk-success-fail">
                {" "}
                ({lastResult.failCount} נכשלו)
              </span>
            )}
          </span>
        </div>
        {lastResult.isCancellation && (
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={showArchive}
            disabled={isPending}
            title="הצג את המשימות שעברו לארכיון"
          >
            📦 הצג בארכיון
          </button>
        )}
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={dismissResult}
          disabled={isPending}
        >
          סגור
        </button>
      </div>
    );
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
        <span className="tasks-bulk-input-label">עובדים</span>
        <PeopleMultiCombobox
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
