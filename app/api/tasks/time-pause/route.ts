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
 * subtracts paused stretches. NOT author-gated — any task participant
 * with project access may toggle it, like a status change.
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
