"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fireConfetti } from "@/lib/confetti";
import type { WorkTask, WorkTaskStatus } from "@/lib/appsScript";
import TaskTransitionModal, {
  getModalTransitionKind,
} from "./TaskTransitionModal";

/**
 * Inline contextual action prompt rendered next to the status pill on
 * the task-detail page. Surfaces the single "obvious next step" so the
 * user doesn't have to know to click the status dropdown.
 *
 * Three role × status configurations get a prompt:
 *
 *   • assignee × awaiting_handling  → [התחל לעבוד]
 *   • assignee × in_progress        → [הגש לאישור]
 *   • approver × awaiting_approval  → [אשר] [החזר לטיפול] [דחה]
 *
 * Everyone else / every other status → render null (no prompt). The
 * status pill itself stays interactive for ad-hoc transitions that
 * don't match any of the above.
 *
 * Why duplicate logic that's already in TaskApprovalBanner? The banner
 * only renders when there's a matching 🔍/❓ comment in the thread —
 * great for the rejection-bounce-back loop, but it leaves the approver
 * with no inline action when the submission predates the banner UX or
 * when no comment was captured. This prompt is unconditional based on
 * role + status, so the call-to-action is always one click away.
 */

type ActionKind = "start" | "submit" | "approve" | "return" | "reject";

export default function TaskActionPrompt({
  task,
  myEmail,
}: {
  task: WorkTask;
  myEmail: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalTarget, setModalTarget] = useState<WorkTaskStatus | null>(null);

  const lc = (myEmail || "").toLowerCase();
  const isApprover =
    !!task.approver_email && task.approver_email.toLowerCase() === lc;
  const isAssignee = (task.assignees || []).some(
    (e) => (e || "").toLowerCase() === lc,
  );
  const status = task.status;

  // Decide which configuration applies. The matrix is intentionally
  // narrow — surfaces here mirror the most common single-next-step the
  // viewer has in this status. Anything else falls through to the
  // status-pill dropdown.
  const showStart = isAssignee && status === "awaiting_handling";
  const showSubmit = isAssignee && status === "in_progress";
  const showApprover = isApprover && status === "awaiting_approval";

  if (!showStart && !showSubmit && !showApprover) return null;

  async function transition(
    kind: ActionKind,
    to: PromptTargetStatus,
    note: string,
    options: { confetti?: boolean } = {},
  ) {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch("/api/worktasks/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: task.id,
          patch: { status: to, note },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as
        | { ok: true }
        | { ok: false; error: string };
      if (!res.ok || !("ok" in data) || !data.ok) {
        const msg =
          "error" in data && data.error
            ? data.error
            : `Update failed (${res.status})`;
        throw new Error(msg);
      }
      if (options.confetti) fireConfetti();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function pickTransition(
    to: PromptTargetStatus,
    kind: ActionKind,
    note: string,
  ) {
    // Transitions that need a captured deliverable / reason go through
    // the shared TaskTransitionModal — the same surface the status
    // pill + approval banner use. Everything else flips directly.
    if (getModalTransitionKind(status, to)) {
      setModalTarget(to);
      return;
    }
    void transition(kind, to, note);
  }

  return (
    <>
      <div className="task-action-prompt" role="group">
        {showStart && (
          <button
            type="button"
            className="btn-primary btn-sm task-action-prompt-btn task-action-prompt-primary"
            onClick={() =>
              pickTransition("in_progress", "start", "inline: התחל לעבוד")
            }
            disabled={busy !== null}
            title="העבר את המשימה לבעבודה"
          >
            {busy === "start" ? "מעדכן…" : "▶ התחל לעבוד"}
          </button>
        )}

        {showSubmit && (
          <button
            type="button"
            className="btn-primary btn-sm task-action-prompt-btn task-action-prompt-primary"
            onClick={() =>
              pickTransition(
                "awaiting_approval",
                "submit",
                "inline: הגש לאישור",
              )
            }
            disabled={busy !== null}
            title="שלח את המשימה לאישור הגורם המאשר"
          >
            {busy === "submit" ? "שולח…" : "↗ הגש לאישור"}
          </button>
        )}

        {showApprover && (
          <>
            <button
              type="button"
              className="btn-primary btn-sm task-action-prompt-btn task-action-prompt-approve"
              onClick={() => transition("approve", "done", "אושר", { confetti: true })}
              disabled={busy !== null}
              title="אשר את ההגשה — המשימה תיסגר"
            >
              {busy === "approve" ? "מאשר…" : "✓ אשר"}
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm task-action-prompt-btn"
              onClick={() =>
                pickTransition(
                  "awaiting_handling",
                  "return",
                  "inline: החזר לטיפול",
                )
              }
              disabled={busy !== null}
              title="החזר את המשימה לטיפול"
            >
              ↻ החזר לטיפול
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm task-action-prompt-btn task-action-prompt-reject"
              onClick={() => {
                if (
                  !window.confirm(
                    "לדחות את המשימה? סטטוס המשימה ישתנה ל-'בוטל' ולא יהיה ניתן לחזור בלי שינוי ידני.",
                  )
                )
                  return;
                void transition("reject", "cancelled", "נדחה על ידי המאשר");
              }}
              disabled={busy !== null}
              title="דחה סופית — סטטוס יעבור ל-'בוטל'"
            >
              ✕ דחה
            </button>
          </>
        )}

        {error && <span className="task-action-prompt-error">{error}</span>}
      </div>

      {modalTarget && (
        <TaskTransitionModal
          taskId={task.id}
          fromStatus={status}
          newStatus={modalTarget}
          open={!!modalTarget}
          onClose={() => setModalTarget(null)}
        />
      )}
    </>
  );
}

// Narrow type used by `transition()` + `pickTransition()`. We only
// ever land on these five statuses from this surface — any other
// target would need its own branch above.
type PromptTargetStatus =
  | "in_progress"
  | "awaiting_approval"
  | "awaiting_handling"
  | "done"
  | "cancelled";
