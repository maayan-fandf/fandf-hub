import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { tasksGet } from "@/lib/appsScript";
import { logTaskTime, readTaskTimeLog } from "@/lib/timeLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Optional per-task time tracking — the informational sibling of the
 * pricing/billing ledger (see lib/timeLog.ts).
 *
 * GET  /api/tasks/time?taskId=<id>
 *   → { ok, entries: TimeLogRow[], totalMinutes }
 *   The detail-page tracker reads this to show logged time + history.
 *
 * POST /api/tasks/time   body: { taskId, minutes, note? }
 *   Appends one row to the self-provisioning TimeLog tab. The task's
 *   company/project/departments/kind are denormalized onto the row
 *   (via tasksGet) so the /admin/time report can pivot without
 *   re-joining. Any authenticated user who can resolve the task may
 *   log time against it (tasksGet enforces project access).
 *
 * Time is informational only — it does NOT create a charge; billing
 * stays on the flat Pricingsetup price (PricingLog).
 */

// 100 hours in one entry — a generous ceiling that still catches a
// fat-fingered paste (e.g. a phone number into the minutes field).
const MAX_MINUTES = 6000;

export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  const taskId = (new URL(req.url).searchParams.get("taskId") || "").trim();
  if (!taskId) {
    return NextResponse.json(
      { ok: false, error: "taskId required" },
      { status: 400 },
    );
  }
  try {
    const entries = await readTaskTimeLog(email, taskId);
    const totalMinutes = entries.reduce((s, e) => s + (e.minutes || 0), 0);
    return NextResponse.json({ ok: true, entries, totalMinutes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/tasks/time GET] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: { taskId?: string; minutes?: unknown; note?: unknown };
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
  const minutes = Math.round(
    Number(String(body.minutes ?? "").replace(/[^\d.-]/g, "")),
  );
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return NextResponse.json(
      { ok: false, error: "יש להזין זמן חיובי" },
      { status: 400 },
    );
  }
  if (minutes > MAX_MINUTES) {
    return NextResponse.json(
      { ok: false, error: "הזמן שהוזן גדול מדי — בדוק/י את הקלט" },
      { status: 400 },
    );
  }
  const note = String(body.note ?? "").trim().slice(0, 500);

  try {
    // Resolve the task to denormalize company/project/dept/kind onto
    // the ledger row. tasksGet enforces project access for the user,
    // so this also gates "can this person log against this task".
    const res = await tasksGet(taskId).catch(() => null);
    if (!res?.task) {
      return NextResponse.json(
        { ok: false, error: "Task not found" },
        { status: 404 },
      );
    }
    const t = res.task;
    await logTaskTime({
      subjectEmail: email,
      taskId: t.id,
      company: t.company,
      project: t.project,
      departments: t.departments || [],
      kind: t.kind,
      minutes,
      note,
      loggedBy: email,
    });
    const entries = await readTaskTimeLog(email, t.id);
    const totalMinutes = entries.reduce((s, e) => s + (e.minutes || 0), 0);
    return NextResponse.json({ ok: true, entries, totalMinutes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/tasks/time POST] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
