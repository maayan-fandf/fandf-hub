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
 * actually finished the work.
 *
 * Tombstone semantics (2026-07-16): the claim is NOT cleared — it is
 * kept with {dismissed:true, dismissedBy, dismissedAt}. Clearing it
 * let the very same completed GT re-mint an identical claim on the
 * next poll cycle (staleness guard passes — the completion postdates
 * the unchanged status — and the idempotency guard saw an empty
 * field), resurrecting the banner ≤1 min after dismissal AND letting
 * the reconciler respawn a duplicate GT (its heal gate reads the
 * claim field). The tombstone keeps both guards armed; the banner
 * skips dismissed claims; a real status change still clears the
 * field wholesale (tasksUpdateDirect), and a GENUINE re-tick that
 * postdates dismissedAt overwrites the tombstone with a live claim.
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
    // Preserve the original claim (kind/prev/by/at) inside the
    // tombstone — the idempotency guard matches on kind+prev.
    let tomb: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(task.pending_complete));
      if (parsed && typeof parsed === "object") tomb = parsed;
    } catch {
      /* corrupt claim — tombstone still records the dismissal */
    }
    tomb.dismissed = true;
    tomb.dismissedBy = subject;
    tomb.dismissedAt = new Date().toISOString();
    const result = await tasksUpdateDirect(subject, id, {
      pending_complete: JSON.stringify(tomb),
      note: `סומן כדחייה ע״י ${subject} — לא היה השלמה אמיתית`,
    });
    return NextResponse.json({ ok: true, changed: result.changed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
