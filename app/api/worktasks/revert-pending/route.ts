import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { tasksGetDirect } from "@/lib/tasksDirect";
import { tasksUpdateDirect } from "@/lib/tasksWriteDirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/worktasks/revert-pending
 * Body: { id: string }
 *
 * Dismisses a pending-completion claim without flipping the hub
 * status. Used when the assignee marked the GT complete to clear a
 * notification (the 9pm-dismissal case) rather than because they
 * actually finished the work. Clears the flag; the hub task stays
 * in its current status and the next pollTaskCompletions cycle is a
 * no-op (the GT is already completed in Google's storage so the
 * 2026-05-04 fetch-first guard short-circuits any re-patch).
 *
 * Note: the GT itself is left as completed in the assignee's list.
 * Re-spawning isn't done automatically — if the task creator wants
 * the assignee to re-engage, they reassign via the edit panel which
 * spawns a fresh todo GT through the existing reassignment path.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  const subject = session.user.email;
  let body: { id?: string } = {};
  try {
    body = (await req.json()) as { id?: string };
  } catch {
    /* empty body — falls through to validation */
  }
  const id = String(body.id || "").trim();
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "id is required" },
      { status: 400 },
    );
  }
  try {
    const { task } = await tasksGetDirect(subject, id);
    if (!task.pending_complete) {
      return NextResponse.json(
        { ok: true, changed: false, alreadyEmpty: true },
      );
    }
    const result = await tasksUpdateDirect(subject, id, {
      pending_complete: "",
      note: `סומן כדחייה ע״י ${subject} — לא היה השלמה אמיתית`,
    });
    return NextResponse.json({ ok: true, changed: result.changed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
