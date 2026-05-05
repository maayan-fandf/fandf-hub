"use client";

/**
 * Renders on a task whose `pending_complete` flag is set — meaning a
 * Google Task completion was detected (during work hours) but the hub
 * status hasn't auto-flipped yet. The approver / reporter clicks
 * confirm or revert; the task page reloads with the resolution.
 *
 * Background — the auto-flip behaviour bit us 2026-05-05 when a 9pm
 * GT spawn pinged sapir's phone and her dismissal (the only "remove
 * from list" affordance) was indistinguishable from "I finished the
 * work." We now distinguish: GT completion sets a claim, the hub
 * status only changes after explicit confirm.
 *
 * Quiet-hours guard (lib/quietHours.ts) is the second line of defense
 * — outside Israel work hours `applyAutoTransition` skips entirely,
 * so the banner only ever appears for completions registered within
 * 09:00–18:59 Sun–Thu.
 */

import { useState } from "react";
import type { TasksPerson } from "@/lib/appsScript";
import { personDisplayName } from "@/lib/personDisplay";

type Claim = {
  by: string;
  kind: "todo" | "approve" | "clarify";
  at: string;
  prev: string;
};

type Props = {
  taskId: string;
  /** Raw JSON string from `task.pending_complete`. Empty string means
   *  no banner — caller should not render the component. We still
   *  guard inside in case a stale prop sneaks through. */
  claimJson: string;
  /** People list for resolving the claim's `by` email to a Hebrew
   *  name. Optional; falls back to email-prefix on miss. */
  people?: TasksPerson[];
};

const KIND_LABELS: Record<Claim["kind"], string> = {
  todo: "סימן/ה כמשלמת",
  approve: "אישר/ה",
  clarify: "סיים/ה הבהרה",
};

export default function TaskApprovalConfirmBanner({
  taskId,
  claimJson,
  people,
}: Props) {
  const [busy, setBusy] = useState<"confirm" | "revert" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const claim = parseClaim(claimJson);
  if (!claim) return null;

  const actor =
    personDisplayName(claim.by, people) || claim.by || "מישהו";
  const verb = KIND_LABELS[claim.kind] || "פעל/ה";
  const ago = formatAgo(claim.at);

  async function call(path: string, action: "confirm" | "revert") {
    setBusy(action);
    setErr(null);
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: taskId }),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) {
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      // Hard reload picks up the new status / cleared flag and avoids
      // any router cache issues — same pattern TaskInlineEditors uses.
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <section className="task-approval-banner" role="status">
      <div className="task-approval-banner-icon" aria-hidden>
        ⚠️
      </div>
      <div className="task-approval-banner-body">
        <div className="task-approval-banner-text">
          <strong>{actor}</strong> {verb} ב-Google Tasks
          {ago && <span className="task-approval-banner-time"> · {ago}</span>}
          .
          <br />
          האם זו השלמה אמיתית, או שזו הייתה דחייה של ההתראה?
        </div>
        <div className="task-approval-banner-actions">
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={busy !== null}
            onClick={() =>
              call("/api/worktasks/confirm-pending", "confirm")
            }
          >
            {busy === "confirm" ? "מאשר…" : "✓ כן, השלמה אמיתית"}
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            disabled={busy !== null}
            onClick={() =>
              call("/api/worktasks/revert-pending", "revert")
            }
          >
            {busy === "revert" ? "מנקה…" : "✗ לא, הייתה דחייה"}
          </button>
        </div>
        {err && (
          <div className="task-approval-banner-err" role="alert">
            {err}
          </div>
        )}
      </div>
    </section>
  );
}

function parseClaim(raw: string): Claim | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    if (typeof c !== "object" || c === null) return null;
    return c as Claim;
  } catch {
    return null;
  }
}

function formatAgo(iso: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "עכשיו";
  if (min < 60) return `לפני ${min} דקות`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `לפני ${hr} שעות`;
  const day = Math.floor(hr / 24);
  return `לפני ${day} ימים`;
}
