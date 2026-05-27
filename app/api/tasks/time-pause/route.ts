import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { useSATasksWrites } from "@/lib/sa";
import { deriveInProgressTime } from "@/lib/inProgressTime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pause / resume the in-progress time counter.
 *
 * The counter runs while the task is in status בעבודה; this lets the
 * user ⏸/▶ it WITHOUT changing status (a break, lunch, context-switch).
 * Each click appends one {at,action,by} event to the task row's
 * `time_pauses` column (atomic under the task lock); lib/inProgressTime
 * subtracts paused stretches.
 *
 * Access (tightened 2026-05-27 after Omer was observed pausing Maayan's
 * task): callers must be an ADMIN or one of the task's ASSIGNEES.
 * Project access alone isn't enough — only the people on the hook for
 * the work should be able to manipulate its time counter. The check
 * happens HERE at the API surface (so the 403 returns immediately) AND
 * the pause buttons in the UI hide for non-assignees (TaskTimeTracker,
 * TaskTimePauseQuick, TaskTimePauseIcon) so the affordance never even
 * appears to someone who can't use it. Belt-and-suspenders.
 *
 * POST body: { taskId, action: "pause" | "resume" }
 * → { ok, minutes, isRunning, isPaused }  (recomputed auto value; the
 *   manual override, if any, still supersedes this in the UI)
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: { taskId?: string; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const taskId = String(body.taskId || "").trim();
  const action = body.action === "pause" ? "pause" : body.action === "resume" ? "resume" : null;
  if (!taskId || !action) {
    return NextResponse.json(
      { ok: false, error: "taskId + action (pause|resume) required" },
      { status: 400 },
    );
  }

  if (!useSATasksWrites()) {
    return NextResponse.json(
      { ok: false, error: "Pause/resume requires the direct-SA write path" },
      { status: 503 },
    );
  }

  // Assignee/admin gate. Read the task first to check assignees; if
  // the caller can't even read the task, the read itself throws
  // "Access denied" which we convert to a 403 below.
  const lc = email.toLowerCase().trim();
  try {
    const { tasksGetDirect, HUB_ADMIN_EMAILS } = await import("@/lib/tasksDirect");
    const isAdmin = HUB_ADMIN_EMAILS.has(lc);
    if (!isAdmin) {
      const res = await tasksGetDirect(email, taskId);
      const assignees = (res.task.assignees || []).map((a) =>
        String(a).toLowerCase().trim(),
      );
      if (!assignees.includes(lc)) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "רק עובדים המשובצים על המשימה יכולים להשהות/לחדש את ספירת הזמן",
          },
          { status: 403 },
        );
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const lower = msg.toLowerCase();
    if (lower.includes("access denied")) {
      return NextResponse.json(
        { ok: false, error: "Access denied" },
        { status: 403 },
      );
    }
    if (lower.includes("not found")) {
      return NextResponse.json(
        { ok: false, error: "Task not found" },
        { status: 404 },
      );
    }
    console.log("[/api/tasks/time-pause assignee-gate] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  try {
    const { tasksUpdateDirect } = await import("@/lib/tasksWriteDirect");
    const result = await tasksUpdateDirect(email, taskId, {
      appendTimePause: { action },
    });
    const t = result.task;
    const ip = deriveInProgressTime(
      t.status_history || [],
      t.status,
      t.time_pauses || [],
    );
    return NextResponse.json({
      ok: true,
      minutes: ip.minutes,
      isRunning: ip.isRunning,
      isPaused: ip.isPaused,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/tasks/time-pause POST] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
