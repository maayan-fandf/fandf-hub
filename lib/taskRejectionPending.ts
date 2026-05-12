import type { WorkTask } from "@/lib/appsScript";

/**
 * Detect whether a task is currently in the "rejected, waiting to be
 * picked up again" state — i.e. an approver bounced it back via the
 * TaskTransitionModal's reject flow, and no fresher status change has
 * superseded that signal.
 *
 * Logic: look at the MOST RECENT status_history entry. If
 *   • its `to` matches the task's current status (so it really IS the
 *     latest transition; status_history isn't being out-of-sync), AND
 *   • the note starts with "החזרה לתיקון" (the prefix the rejection
 *     submission modal writes — see lib/components/TaskTransitionModal),
 *   • AND the current status is awaiting_handling OR in_progress (the
 *     two reject-target statuses defined in
 *     `getModalTransitionKind`),
 * then the task is rejection-pending.
 *
 * Auto-clears the moment any later status change happens (assignee
 * resubmits → moves to awaiting_approval → new history entry whose
 * note is "הוגש לאישור"; assignee makes any other status flip → new
 * entry overrides). No write-time field maintenance needed.
 *
 * Reported by Maayan 2026-05-12: she wanted a visible bullet on the
 * row in ממתין לטיפול showing "הוחזר לתיקון" so the queue + kanban
 * surfaces the rejection state at a glance without opening the task.
 */
export function isRejectionPending(task: WorkTask): boolean {
  const status = task.status;
  if (status !== "awaiting_handling" && status !== "in_progress") {
    return false;
  }
  const hist = task.status_history || [];
  if (hist.length === 0) return false;
  const last = hist[hist.length - 1];
  if (!last) return false;
  if (last.to !== status) return false;
  const note = String(last.note || "").trim();
  return note.startsWith("החזרה לתיקון");
}
