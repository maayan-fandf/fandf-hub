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
  /** RFC3339 timestamp of when the Google Task was marked complete
   *  (Tasks API `completed` field). Used to skip STALE completions: a
   *  GT closed BEFORE the task entered its current status already drove
   *  an earlier transition — or was closed by the hub's own cascade on
   *  submit/approve — so re-reading it after the task bounced back to an
   *  active status would fire a phantom pending_complete. Optional; when
   *  absent (legacy HTTP callers) the staleness guard is skipped. */
  completedAt?: string;
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

/** Epoch ms when the task most recently ENTERED `status`, read from its
 *  status_history (the latest entry whose `to` === status). Returns 0
 *  when the history is missing or has no matching entry — callers treat
 *  0 as "unknown" and skip the staleness comparison. */
function statusEnteredAt(
  history: ReadonlyArray<{ at?: string; to?: string }> | undefined,
  status: string,
): number {
  if (!Array.isArray(history)) return 0;
  let best = 0;
  for (const h of history) {
    if (!h || h.to !== status) continue;
    const ms = Date.parse(h.at || "");
    if (Number.isFinite(ms) && ms > best) best = ms;
  }
  return best;
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

    // Stale-completion guard (prod bug 2026-06-18, task T-mqj7bqgv-dwxo):
    // a kind=todo GT closed at first submit (08:28) re-fired after the
    // task was returned for fixes and re-entered awaiting_handling
    // (08:56), spawning a phantom pending_complete the assignee never
    // triggered. A completion that predates the task's CURRENT status is
    // historical — it already drove a prior transition, or was closed by
    // the hub's own cascade on submit/approve — so it must not be
    // re-consumed. We only skip when both timestamps are known; absent
    // completedAt (legacy HTTP callers) keeps the prior behaviour.
    if (input.completedAt) {
      const since = statusEnteredAt(task.status_history, previous);
      const completedMs = Date.parse(input.completedAt);
      if (since > 0 && Number.isFinite(completedMs) && completedMs < since) {
        return {
          ok: true,
          skipped: true,
          taskId,
          kind,
          previous,
          reason: `stale GT completion (${input.completedAt}) predates current status "${previous}" entered ${new Date(since).toISOString()}`,
        };
      }
    }

    // Quiet-hours guard — outside Israel work hours, a GT completion
    // is overwhelmingly more likely to be a "dismiss this notification"
    // than a genuine "I finished the work" signal. Defer to the next
    // pollTaskCompletions cycle that lands in the work window. The
    // poller fires every few minutes via Cloud Scheduler, so the worst
    // case lands a few minutes after 09:00 the next workday.
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

    // Banner-based confirmation flow (replaces the old auto-flip
    // behaviour that bit us 2026-05-05). Instead of immediately
    // transitioning the hub status, we record a pending-completion
    // claim on the task. The detail page renders a confirm/revert
    // banner; the approver decides if the GT click was a real
    // completion or a noise dismissal.
    const claim = JSON.stringify({
      by: completedBy || "",
      kind,
      at: new Date().toISOString(),
      prev: previous,
    });
    const result = await tasksUpdateDirect(ADMIN_FALLBACK, taskId, {
      pending_complete: claim,
      note: completedBy
        ? `סומן כמשלמת ע״י ${completedBy} (Google Tasks) — ממתין לאישור באב`
        : "סומן כמשלמת (Google Tasks) — ממתין לאישור באב",
    });
    return {
      ok: true,
      skipped: false,
      taskId,
      kind,
      previous,
      // Target stays in the response so the caller can log/audit what
      // WOULD have happened, but the actual hub status hasn't moved.
      target,
      changed: result.changed,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, taskId, kind, error: msg };
  }
}
