"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkTask, WorkTaskStatus } from "@/lib/appsScript";
import { fireConfetti, firePulse } from "@/lib/confetti";
import TaskTransitionModal, {
  getModalTransitionKind,
} from "./TaskTransitionModal";

// Mirror of Apps Script TASKS_ALLOWED_TRANSITIONS — kept in sync so the UI
// only offers transitions the server will accept. If they diverge the
// server will reject; the client just won't surface the button.
const TRANSITIONS: Record<WorkTaskStatus, { to: WorkTaskStatus; label: string; tone: string }[]> = {
  draft: [
    { to: "awaiting_handling", label: "ממתין לטיפול", tone: "primary" },
    { to: "cancelled", label: "בוטל", tone: "ghost" },
  ],
  awaiting_handling: [
    { to: "in_progress", label: "בעבודה", tone: "primary" },
    { to: "awaiting_clarification", label: "ממתין לבירור", tone: "warn" },
    { to: "cancelled", label: "בוטל", tone: "ghost" },
  ],
  in_progress: [
    { to: "awaiting_approval", label: "ממתין לאישור", tone: "primary" },
    { to: "awaiting_clarification", label: "ממתין לבירור", tone: "warn" },
    { to: "awaiting_handling", label: "ממתין לטיפול", tone: "ghost" },
    { to: "cancelled", label: "בוטל", tone: "ghost" },
  ],
  awaiting_clarification: [
    { to: "in_progress", label: "בעבודה", tone: "primary" },
    { to: "awaiting_handling", label: "ממתין לטיפול", tone: "ghost" },
    { to: "cancelled", label: "בוטל", tone: "ghost" },
  ],
  awaiting_approval: [
    { to: "done", label: "בוצע", tone: "primary" },
    { to: "in_progress", label: "בעבודה", tone: "warn" },
    { to: "cancelled", label: "בוטל", tone: "ghost" },
  ],
  done: [
    { to: "in_progress", label: "בעבודה", tone: "ghost" },
  ],
  // Revival paths for a cancelled task — rare but real.
  cancelled: [
    { to: "awaiting_handling", label: "ממתין לטיפול", tone: "primary" },
    { to: "in_progress", label: "בעבודה", tone: "primary" },
  ],
  // Phase 2 dependencies — `blocked` is system-managed. The user can
  // only abandon a blocked task; every other transition out of blocked
  // must come through dependencyCascade after upstream blockers
  // terminate. Mirrors TaskStatusCell.tsx TRANSITIONS override + the
  // server's TASKS_ALLOWED_TRANSITIONS.
  blocked: [
    { to: "cancelled", label: "בוטל", tone: "ghost" },
  ],
};

export default function TaskStatusActions({ task }: { task: WorkTask }) {
  const router = useRouter();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Modal target — set when the transition needs a deliverable (file
  // / link / explanation). The shared `getModalTransitionKind` helper
  // covers submission, clarification, AND the approver-bounce-back
  // case so all three call sites stay in lockstep.
  const [modalTarget, setModalTarget] = useState<WorkTaskStatus | null>(null);

  const options = TRANSITIONS[task.status] || [];
  if (options.length === 0) return null;

  async function transition(to: WorkTaskStatus, label: string) {
    // Transitions that need a deliverable go through the submission
    // modal. The kind helper handles all three cases — submit (any →
    // awaiting_approval), clarify (any → awaiting_clarification), and
    // reject (awaiting_approval → in_progress | awaiting_handling).
    if (getModalTransitionKind(task.status, to)) {
      setModalTarget(to);
      return;
    }
    const note = window.prompt(`הערה (אופציונלי) עבור "${label}":`, "");
    if (note === null) return; // user cancelled the prompt
    setSaving(to);
    setError(null);
    try {
      const res = await fetch("/api/worktasks/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: task.id,
          patch: { status: to, note: note || "" },
        }),
      });
      const data = (await res.json()) as
        | { ok: true }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        throw new Error("error" in data ? data.error : "Failed to update");
      }
      // Confetti for `done` only. Awaiting-approval used to fire a
      // pulse here too; that branch now flows through the submission
      // modal — see MODAL_TRANSITIONS above — and modalTarget !== null
      // means we don't reach this code for those transitions.
      if (to === "done") {
        fireConfetti();
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="task-actions">
      <h3>פעולות</h3>
      <div className="task-actions-row">
        {options.map((opt) => (
          <button
            key={opt.to}
            type="button"
            className={`btn-${opt.tone}`}
            disabled={saving !== null}
            onClick={() => transition(opt.to, opt.label)}
          >
            {saving === opt.to ? "…" : opt.label}
          </button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      {modalTarget && (
        <TaskTransitionModal
          taskId={task.id}
          fromStatus={task.status}
          newStatus={modalTarget}
          open={!!modalTarget}
          onClose={() => {
            const wasApproval = modalTarget === "awaiting_approval";
            setModalTarget(null);
            if (wasApproval) firePulse();
          }}
        />
      )}
    </section>
  );
}
