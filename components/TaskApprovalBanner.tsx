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

type Props = {
  task: WorkTask;
  /** Latest comments on the task (oldest-first as returned by
   *  `getTaskComments`). Used to find the most recent submission /
   *  clarification-request / rejection so the banner can preview the
   *  content the recipient needs to act on. */
  comments: CommentItem[];
  /** Current viewer's email. Combined with the task's
   *  approver_email / author_email to gate the action buttons. */
  myEmail: string;
  /** Hub admins can act on any task regardless of approver/author
   *  role. Mirrors the access pattern elsewhere in the app. */
  isAdmin: boolean;
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
  isAdmin,
  people,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Modal action (reject / clarify) — opens TaskTransitionModal with
  // the matching target status. Approve doesn't need the modal (it's
  // just a status flip with no deliverable required).
  const [modalTarget, setModalTarget] = useState<
    "in_progress" | "awaiting_clarification" | null
  >(null);

  const lc = myEmail.toLowerCase();
  const isApprover =
    !!task.approver_email &&
    task.approver_email.toLowerCase() === lc;
  const isAuthor =
    !!task.author_email && task.author_email.toLowerCase() === lc;

  const status = task.status;
  if (status !== "awaiting_approval" && status !== "awaiting_clarification") {
    return null;
  }

  // Pick the matching prefix for this status, then find the latest
  // comment whose body opens with it. Comments are oldest-first so we
  // iterate in reverse to grab the most recent match cheaply.
  const wantedPrefix =
    status === "awaiting_approval" ? SUBMIT_PREFIX : CLARIFY_PREFIX;
  let latest: CommentItem | null = null;
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body || "";
    if (body.startsWith(wantedPrefix)) {
      latest = comments[i];
      break;
    }
  }
  if (!latest) return null;

  const showActions =
    status === "awaiting_approval"
      ? isApprover || isAdmin
      : isAuthor || isAdmin;

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
    status === "awaiting_approval" ? "ממתין לאישורך" : "מחכים לתשובתך";
  const intro =
    status === "awaiting_approval"
      ? "הוגש לאישור — סקור/י את התוכן למטה ובחר/י אישור או החזרה לתיקון"
      : "בקשת בירור — סקור/י את השאלה למטה וענה/י כדי להמשיך";

  return (
    <>
      <section
        className={`task-approval-banner task-approval-banner-${status}`}
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
        {showActions && (
          <div className="task-approval-banner-actions">
            {status === "awaiting_approval" ? (
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
                  onClick={() => setModalTarget("in_progress")}
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
            ) : (
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => setModalTarget("in_progress")}
                disabled={busy !== null}
              >
                💬 ענה והחזר לעבודה
              </button>
            )}
          </div>
        )}
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

// Imported but unused at the top to keep the prefix-table readable;
// reject prefix only matters when status flips OUT of awaiting_approval
// — that comment is informational on the assignee's discussion view,
// not surfaced as a banner. Keep the constant exported-like for
// callers that may want to filter on it later.
void REJECT_PREFIX;
