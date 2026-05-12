"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CommentItem, TasksPerson, WorkTask } from "@/lib/appsScript";
import CommentBody from "./CommentBody";
import Avatar from "./Avatar";
import { fireConfetti } from "@/lib/confetti";
import { personDisplayName } from "@/lib/personDisplay";
import { formatDateIso } from "@/lib/dateFormat";
import TaskTransitionModal from "./TaskTransitionModal";

const SUBMIT_PREFIX = "🔍 הוגש לאישור";
const CLARIFY_PREFIX = "❓ ממתין לבירור";
const REJECT_PREFIX = "🔄 הוחזר לתיקון";

type BannerMode = "approval" | "clarification" | "rejection";

type Props = {
  task: WorkTask;
  /** Latest comments on the task (oldest-first as returned by
   *  `getTaskComments`). Used to find the most recent submission /
   *  clarification-request / rejection so the banner can preview the
   *  content the recipient needs to act on. */
  comments: CommentItem[];
  /** Current viewer's email. The banner renders only when this email
   *  matches the mode's primary recipient (approver / author /
   *  assignee) so the wrong person doesn't get nagged. */
  myEmail: string;
  /** People roster for resolving comment-author emails to Hebrew
   *  display names. */
  people: TasksPerson[];
};

/**
 * Prominent banner that surfaces a task's latest pending submission so
 * the approver / author doesn't have to scroll through the discussion
 * to find what they need to act on. Three banner shapes:
 *
 *   awaiting_approval → "🔍 הוגש לאישור" — surfaces the submission to
 *                       the approver with inline ✅ אישור / 🔄 החזרה
 *                       לתיקון / ❓ בקש בירור buttons. The non-approver
 *                       (author / assignees) sees the preview without
 *                       action buttons.
 *
 *   awaiting_clarification → "❓ ממתין לבירור" — surfaces the question
 *                       to the author with inline "ענה ועדכן לבעבודה"
 *                       button that flips status back to in_progress.
 *                       Anyone else sees the preview without buttons.
 *
 *   (Anything else) → renders null.
 *
 * The latest matching comment is found by scanning the comments
 * oldest-first; the LAST match wins so a fresh re-submission overrides
 * the previous one. Renders null when status matches but no qualifying
 * comment exists (legacy tasks or tasks where status was flipped via
 * the pre-modal flow).
 *
 * Reported by Maayan 2026-05-12: as the approver opening a task, the
 * submission was buried in the discussion section below the tabs. The
 * banner pulls it above so the action you need to take is the first
 * thing you see.
 */
export default function TaskApprovalBanner({
  task,
  comments,
  myEmail,
  people,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Modal action target. Each banner mode triggers different targets:
  //   approval mode:    in_progress (reject) / awaiting_clarification (clarify)
  //   clarification:    in_progress (answer + back to work)
  //   rejection:        awaiting_approval (resubmit after fixing)
  // Approve is the only path that doesn't use the modal — it's a clean
  // status flip with no deliverable required.
  const [modalTarget, setModalTarget] = useState<
    | "in_progress"
    | "awaiting_handling"
    | "awaiting_clarification"
    | "awaiting_approval"
    | null
  >(null);

  const lc = myEmail.toLowerCase();
  const isApprover =
    !!task.approver_email &&
    task.approver_email.toLowerCase() === lc;
  const isAuthor =
    !!task.author_email && task.author_email.toLowerCase() === lc;

  const status = task.status;

  // Decide which banner mode (if any) applies to the current status.
  // - awaiting_approval        → "approval"     (find latest 🔍 הוגש לאישור)
  // - awaiting_clarification   → "clarification" (find latest ❓ ממתין לבירור)
  // - in_progress / awaiting_handling — only show a banner when the
  //   LATEST status-changing comment is a rejection that has NOT been
  //   superseded by a fresh submission. This keeps the "fix what was
  //   rejected" banner visible right after Itay bounces work back, but
  //   it disappears once Maayan submits again (the new 🔍 comment
  //   wins). Tasks that landed in in_progress through normal flow
  //   (assignee picks up new work) see no banner — they're not in a
  //   rejection-response state.
  let mode: BannerMode | null = null;
  let wantedPrefix = "";
  if (status === "awaiting_approval") {
    mode = "approval";
    wantedPrefix = SUBMIT_PREFIX;
  } else if (status === "awaiting_clarification") {
    mode = "clarification";
    wantedPrefix = CLARIFY_PREFIX;
  } else if (status === "in_progress" || status === "awaiting_handling") {
    let latestSubmitIdx = -1;
    let latestRejectIdx = -1;
    for (let i = 0; i < comments.length; i++) {
      const body = comments[i].body || "";
      if (body.startsWith(SUBMIT_PREFIX)) latestSubmitIdx = i;
      else if (body.startsWith(REJECT_PREFIX)) latestRejectIdx = i;
    }
    if (latestRejectIdx >= 0 && latestRejectIdx > latestSubmitIdx) {
      mode = "rejection";
      wantedPrefix = REJECT_PREFIX;
    }
  }
  if (!mode) return null;

  // Find the latest comment whose body opens with the chosen prefix.
  // Comments are oldest-first so iterate in reverse — first hit wins.
  let latest: CommentItem | null = null;
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body || "";
    if (body.startsWith(wantedPrefix)) {
      latest = comments[i];
      break;
    }
  }
  if (!latest) return null;

  // Banner visibility — show ONLY to the person who can act on it,
  // not to every viewer. Maayan reported 2026-05-12: after she
  // reassigned the approver to Itay, she still saw "ממתין לאישורך"
  // because the banner rendered for everyone (only the buttons were
  // gated). Hiding for non-actionable viewers prevents the wrong
  // person thinking the task is waiting on them.
  //
  //   approval     → the approver (only Itay should see "ממתין לאישורך")
  //   clarification → the author (only the person who can answer)
  //   rejection    → the author + assignees (whoever owes the resubmit)
  //
  // No admin shortcut on this surface: an admin who isn't the
  // approver/author/assignee can still act via the status pill if
  // they need to. The banner is for the primary recipient, not a
  // catch-all "admins can see everything" view.
  const lcAssignees = (task.assignees || []).map((e) => e.toLowerCase());
  const isAssignee = lcAssignees.includes(lc);
  const isPrimaryRecipient =
    mode === "approval"
      ? isApprover
      : mode === "clarification"
        ? isAuthor
        : isAuthor || isAssignee;
  if (!isPrimaryRecipient) return null;

  const authorDisplay =
    personDisplayName(latest.author_email, people) || latest.author_email;
  const role = people.find(
    (p) => p.email.toLowerCase() === latest!.author_email.toLowerCase(),
  )?.role;

  async function approve() {
    setBusy("approve");
    setError(null);
    try {
      const res = await fetch("/api/worktasks/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: task.id,
          patch: { status: "done", note: "אושר" },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as
        | { ok: true }
        | { ok: false; error: string };
      if (!res.ok || !("ok" in data) || !data.ok) {
        const msg =
          "error" in data && data.error ? data.error : `Update failed (${res.status})`;
        throw new Error(msg);
      }
      fireConfetti();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const label =
    mode === "approval"
      ? "ממתין לאישורך"
      : mode === "clarification"
        ? "מחכים לתשובתך"
        : "המשימה הוחזרה לתיקון";

  return (
    <>
      <section
        className={`task-approval-banner task-approval-banner-${mode}`}
        aria-label={label}
      >
        <div className="task-approval-banner-head">
          <span className="task-approval-banner-chip">{label}</span>
          <Avatar
            name={latest.author_email}
            title={authorDisplay}
            role={role}
            size={22}
          />
          <span className="task-approval-banner-author">{authorDisplay}</span>
          <span className="task-approval-banner-time" title={latest.timestamp}>
            {formatRelative(latest.timestamp)}
          </span>
        </div>
        <CommentBody
          body={latest.body}
          className="task-approval-banner-body"
          people={people}
        />
        <div className="task-approval-banner-actions">
          {mode === "approval" && (
              <>
                <button
                  type="button"
                  className="btn-primary btn-sm task-approval-banner-approve"
                  onClick={approve}
                  disabled={busy !== null}
                >
                  {busy === "approve" ? "מאשר…" : "✅ אשר"}
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => setModalTarget("awaiting_handling")}
                  disabled={busy !== null}
                >
                  🔄 החזר לתיקון
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => setModalTarget("awaiting_clarification")}
                  disabled={busy !== null}
                >
                  ❓ בקש בירור
                </button>
              </>
            )}
            {mode === "clarification" && (
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => setModalTarget("in_progress")}
                disabled={busy !== null}
              >
                💬 ענה והחזר לעבודה
              </button>
            )}
            {mode === "rejection" && (
              <button
                type="button"
                className="btn-primary btn-sm task-approval-banner-approve"
                onClick={() => setModalTarget("awaiting_approval")}
                disabled={busy !== null}
              >
                ↗️ הגש שוב לאישור
              </button>
            )}
        </div>
        {error && <div className="task-approval-banner-error">{error}</div>}
      </section>
      {modalTarget && (
        <TaskTransitionModal
          taskId={task.id}
          fromStatus={task.status}
          newStatus={modalTarget}
          open={!!modalTarget}
          onClose={() => setModalTarget(null)}
        />
      )}
    </>
  );
}

/**
 * Compact relative-time formatter shared with TaskCommentRow style.
 * Stays in this file (not in dateFormat.ts) because it's small + the
 * Hebrew copy is banner-specific. Falls back to the ISO date string
 * when the input isn't parseable.
 */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return "עכשיו";
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `לפני ${mins} ד׳`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `לפני ${hrs} ש׳`;
  const days = Math.round(hrs / 24);
  if (days < 14) return `לפני ${days} י׳`;
  return formatDateIso(iso);
}

