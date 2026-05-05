/**
 * Apply the right hub-side status transition when a Google Task is
 * marked complete. Shared between:
 *   - /api/worktasks/auto-transition (HTTP entry point — kept for
 *     backward compat with anything calling it directly)
 *   - lib/pollTasks (in-process call from the cron poller)
 *
 * Logic mirrors the original Apps Script `pollTaskCompletions` →
 * `_hubAutoTransition_` chain:
 *   - kind=todo done    → awaiting_approval (if approver) else done
 *   - kind=approve done → done
 *   - kind=clarify done → in_progress
 *
 * Each branch refuses to fire if the task isn't in a status where
 * that transition makes sense — prevents bounces when a hub-side
 * action already moved the task past the GT's stage.
 */

import { tasksGetDirect } from "@/lib/tasksDirect";
import { tasksUpdateDirect } from "@/lib/tasksWriteDirect";
import { isQuietHours } from "@/lib/quietHours";
import type { GTaskKind, WorkTaskStatus } from "@/lib/appsScript";

export type AutoTransitionInput = {
  taskId: string;
  kind: GTaskKind;
  /** Email of the user who ticked the GT — used for the audit trail
   *  + as the impersonation subject when reading the task. Empty
   *  falls back to the admin identity so the call still goes through
   *  if the recipient identity got lost upstream. */
  completedBy: string;
};

export type AutoTransitionResult =
  | { ok: true; skipped: false; taskId: string; kind: GTaskKind; previous: WorkTaskStatus; target: WorkTaskStatus; changed: boolean }
  | { ok: true; skipped: true; taskId: string; kind: GTaskKind; previous: WorkTaskStatus; reason: string }
  | { ok: false; taskId: string; kind: GTaskKind; error: string };

const ADMIN_FALLBACK = "maayan@fandf.co.il";

/** Decide the target status from `kind` + the task's current status.
 *  Returns null when no transition applies (caller should record a
 *  skip rather than treating it as an error). */
export function autoTransitionTarget(
  kind: GTaskKind,
  previous: WorkTaskStatus,
  approverEmail: string,
): WorkTaskStatus | null {
  if (kind === "todo") {
    if (
      previous === "in_progress" ||
      previous === "awaiting_handling" ||
      previous === "draft"
    ) {
      return approverEmail ? "awaiting_approval" : "done";
    }
    return null;
  }
  if (kind === "approve") {
    return previous === "awaiting_approval" ? "done" : null;
  }
  if (kind === "clarify") {
    return previous === "awaiting_clarification" ? "in_progress" : null;
  }
  return null;
}

export async function applyAutoTransition(
  input: AutoTransitionInput,
): Promise<AutoTransitionResult> {
  const { taskId, kind, completedBy } = input;
  const subject = completedBy || ADMIN_FALLBACK;

  try {
    const cur = await tasksGetDirect(subject, taskId);
    const task = cur.task;
    const previous: WorkTaskStatus = task.status;

    const target = autoTransitionTarget(kind, previous, task.approver_email);
    if (!target) {
      return {
        ok: true,
        skipped: true,
        taskId,
        kind,
        previous,
        reason: `No transition for kind=${kind} from status=${previous}`,
      };
    }

    // Quiet-hours guard — outside Israel work hours, a GT completion
    // is much more likely to be a "dismiss this notification" than a
    // genuine "I finished the work" signal. Defer the transition to
    // the next pollTaskCompletions cycle that lands in the work
    // window. The poller fires every few minutes via Cloud Scheduler,
    // so this is bounded — at worst the transition lands a few
    // minutes after 9am the next workday. The 2026-05-05 incident
    // (sapir's 9pm dismissal flipping the task to ממתין לאישור) is
    // exactly the case this prevents.
    if (isQuietHours()) {
      return {
        ok: true,
        skipped: true,
        taskId,
        kind,
        previous,
        reason: `deferred — quiet hours (target=${target})`,
      };
    }

    const result = await tasksUpdateDirect(ADMIN_FALLBACK, taskId, {
      status: target,
      note: completedBy ? `via ${completedBy} · Google Tasks` : "via Google Tasks",
    });
    return {
      ok: true,
      skipped: false,
      taskId,
      kind,
      previous,
      target,
      changed: result.changed,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, taskId, kind, error: msg };
  }
}
