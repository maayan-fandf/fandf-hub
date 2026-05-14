import type { WorkTask, MentionItem } from "@/lib/appsScript";

/**
 * Per-task "this row wants something from YOU" classification.
 *
 * Used to elevate matching rows on /tasks (list + kanban) so the user
 * can scan the queue and instantly spot the ones they personally need
 * to act on. The same row may carry multiple signals (e.g. you're the
 * approver AND someone tagged you in a comment) — we collapse to a
 * single state in this priority order, picking the one that's most
 * actionable to acknowledge:
 *
 *   1. awaiting_approval     (someone is blocked on your approve/reject)
 *   2. awaiting_clarification (the approver bounced it back to you)
 *   3. tagged                (an open @-mention waiting in the thread)
 *
 * Null means the row is neither — render with no special treatment.
 */
export type TaskUserState =
  | "tagged"
  | "awaiting_approval"
  | "awaiting_clarification"
  | null;

export const TASK_USER_STATE_LABELS: Record<
  Exclude<TaskUserState, null>,
  string
> = {
  tagged: "תויגת",
  awaiting_approval: "ממתין לאישורך",
  awaiting_clarification: "ממתין לבירורך",
};

/** Build a {taskId → unresolved mention count} map from the user's
 *  mentions list. Mentions store `parent_id` as the task id, so this
 *  is a single pass with no joins. Resolved threads are excluded —
 *  they no longer want action. */
export function buildMentionsByTask(
  mentions: Pick<MentionItem, "parent_id" | "resolved">[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of mentions) {
    if (m.resolved) continue;
    if (!m.parent_id) continue;
    map.set(m.parent_id, (map.get(m.parent_id) ?? 0) + 1);
  }
  return map;
}

/** Classify a single task against the current user. Email matching is
 *  case-insensitive (Workspace can hand back mixed casing).
 *  Clarification target = the task AUTHOR: the approver bounced the
 *  submission back with questions, and the original submitter is the
 *  one who needs to respond. See TaskApprovalBanner for the same
 *  rule applied to the in-task banner. */
export function userStateForTask(
  task: Pick<WorkTask, "id" | "status" | "approver_email" | "author_email">,
  myEmail: string | null | undefined,
  mentionsByTask: ReadonlyMap<string, number>,
): TaskUserState {
  if (!myEmail) return null;
  const lc = myEmail.toLowerCase();
  if (
    task.status === "awaiting_approval" &&
    (task.approver_email || "").toLowerCase() === lc
  ) {
    return "awaiting_approval";
  }
  if (
    task.status === "awaiting_clarification" &&
    (task.author_email || "").toLowerCase() === lc
  ) {
    return "awaiting_clarification";
  }
  if ((mentionsByTask.get(task.id) ?? 0) > 0) {
    return "tagged";
  }
  return null;
}

/** Convenience: build the full {taskId → TaskUserState} map for a
 *  given user, given the tasks list + their mentions. Returned map
 *  only contains entries where the state is non-null, to keep prop
 *  payloads tight when serializing through to client components. */
export function buildUserStateByTaskId(
  tasks: Pick<WorkTask, "id" | "status" | "approver_email" | "author_email">[],
  myEmail: string | null | undefined,
  mentions: Pick<MentionItem, "parent_id" | "resolved">[],
): Map<string, Exclude<TaskUserState, null>> {
  const mentionsByTask = buildMentionsByTask(mentions);
  const out = new Map<string, Exclude<TaskUserState, null>>();
  for (const t of tasks) {
    const s = userStateForTask(t, myEmail, mentionsByTask);
    if (s !== null) out.set(t.id, s);
  }
  return out;
}
