import { NextResponse } from "next/server";
import { tasksGetDirect } from "@/lib/tasksDirect";
import { tasksUpdateDirect } from "@/lib/tasksWriteDirect";
import type { GTaskKind, WorkTaskStatus } from "@/lib/appsScript";

export const dynamic = "force-dynamic";

/**
 * POST /api/worktasks/auto-transition
 *
 * Server-to-server endpoint called by the Apps Script poller
 * (`pollTaskCompletions`) when it detects a Google Task has been
 * marked complete. The poller passes the completed entry's `kind` and
 * the user who marked it; this endpoint applies the right hub
 * transition, which in turn triggers all the side effects already
 * wired in `tasksUpdateDirect` (close other GTs, spawn the next-stage
 * GT, write history, post Chat / send notifications).
 *
 * Centralizing the transition logic here keeps Apps Script as a thin
 * "detect + dispatch" layer — no need to mirror the kind-aware spawn
 * logic on the Apps Script side.
 *
 * Auth: shared `APPS_SCRIPT_API_TOKEN` matched against the body's
 * `token`. NextAuth session is NOT required because Apps Script
 * triggers run unattended.
 */
export async function POST(req: Request) {
  let body: {
    token?: unknown;
    taskId?: unknown;
    kind?: unknown;
    completedBy?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const expected = process.env.APPS_SCRIPT_API_TOKEN || "";
  if (!expected || String(body.token || "") !== expected) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
  const taskId = String(body.taskId || "").trim();
  const kind = String(body.kind || "todo") as GTaskKind;
  const completedBy = String(body.completedBy || "").trim().toLowerCase();
  if (!taskId) {
    return NextResponse.json(
      { ok: false, error: "taskId is required" },
      { status: 400 },
    );
  }
  if (kind !== "todo" && kind !== "approve" && kind !== "clarify") {
    return NextResponse.json(
      { ok: false, error: "kind must be todo / approve / clarify" },
      { status: 400 },
    );
  }

  // Pick the impersonated subject. Prefer the user who actually
  // ticked the box (their action is the trigger); fall back to the
  // canonical admin so the call still goes through if `completedBy`
  // got dropped on the way.
  const adminFallback = "maayan@fandf.co.il";
  const subject = completedBy || adminFallback;

  try {
    // Read the current task to learn its status + approver. This is
    // also a defensive check — if the row is already in a terminal
    // state, skip the transition (don't bounce a `done` task back
    // through the loop).
    const cur = await tasksGetDirect(subject, taskId);
    const task = cur.task;
    const previous: WorkTaskStatus = task.status;

    // Decide the target status from `kind`.
    let target: WorkTaskStatus | null = null;
    if (kind === "todo") {
      // No-op if the task isn't currently in a state where assignee
      // completion makes sense — protects against duplicate poller
      // hits and against a manual hub transition that already moved
      // the task forward.
      if (
        previous === "in_progress" ||
        previous === "awaiting_handling" ||
        previous === "draft"
      ) {
        target = task.approver_email ? "awaiting_approval" : "done";
      }
    } else if (kind === "approve") {
      // Approver ticked their box → done. Skip if the task left
      // awaiting_approval already.
      if (previous === "awaiting_approval") target = "done";
    } else if (kind === "clarify") {
      // Owner addressed the clarification → bounce back into
      // in_progress so the assignees can re-engage. Skip if no longer
      // in clarification.
      if (previous === "awaiting_clarification") target = "in_progress";
    }

    if (!target) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: `No transition for kind=${kind} from status=${previous}`,
        previous,
      });
    }

    // tasksUpdateDirect handles the GT cascade, spawns the next-kind
    // GT, writes status_history, posts Chat, and notifies the right
    // audience — the entire side effect set lives there. We just
    // tell it where to move.
    const result = await tasksUpdateDirect(adminFallback, taskId, {
      status: target,
      note: completedBy ? `via ${completedBy} · Google Tasks` : "via Google Tasks",
    });
    return NextResponse.json({
      ok: true,
      taskId,
      kind,
      previous,
      target,
      changed: result.changed,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
