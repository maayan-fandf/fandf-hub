import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { useSATasksWrites } from "@/lib/sa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Editable status-derived time counter.
 *
 * The displayed in-progress time is normally AUTO — derived live from
 * status_history (lib/inProgressTime: sum of every interval the task
 * spent in status בעבודה). This endpoint persists a manual OVERRIDE on
 * the task row (`inprogress_minutes` column) so a task left in_progress
 * over the weekend can be corrected, and lets the user clear it back to
 * auto.
 *
 * POST body:
 *   { taskId, minutes }       → set the override to `minutes`
 *   { taskId, reset: true }   → clear the override (revert to auto)
 *
 * Access: NOT author-gated (mirrors a status change) — any task
 * participant with project access may correct it. tasksUpdateDirect
 * enforces the project-access check itself.
 */

// One year in minutes — a manual correction is a real elapsed figure
// (can legitimately span days), but this still catches a bad paste.
const MAX_MINUTES = 525600;

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: { taskId?: string; minutes?: unknown; reset?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const taskId = String(body.taskId || "").trim();
  if (!taskId) {
    return NextResponse.json(
      { ok: false, error: "taskId required" },
      { status: 400 },
    );
  }

  const reset = body.reset === true;
  let minutes = 0;
  if (!reset) {
    minutes = Math.round(
      Number(String(body.minutes ?? "").replace(/[^\d.-]/g, "")),
    );
    if (!Number.isFinite(minutes) || minutes < 0) {
      return NextResponse.json(
        { ok: false, error: "יש להזין מספר דקות תקין" },
        { status: 400 },
      );
    }
    if (minutes > MAX_MINUTES) {
      return NextResponse.json(
        { ok: false, error: "הערך גדול מדי — בדוק/י את הקלט" },
        { status: 400 },
      );
    }
  }

  // Single-cell task-row write goes through the direct-SA path; the
  // Apps Script fallback has no patch action for this graceful column.
  if (!useSATasksWrites()) {
    return NextResponse.json(
      { ok: false, error: "Tracked-time editing requires the direct-SA write path" },
      { status: 503 },
    );
  }

  try {
    const { tasksUpdateDirect } = await import("@/lib/tasksWriteDirect");
    const result = await tasksUpdateDirect(email, taskId, {
      // "" clears the override (graceful column → blank cell → UI falls
      // back to the status_history-derived value).
      inprogress_minutes: reset ? "" : minutes,
    });
    return NextResponse.json({
      ok: true,
      inprogress_minutes:
        result.task.inprogress_minutes == null
          ? null
          : result.task.inprogress_minutes,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/tasks/tracked-time POST] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
