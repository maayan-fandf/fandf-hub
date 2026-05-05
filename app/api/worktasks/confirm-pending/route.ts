import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { tasksGetDirect } from "@/lib/tasksDirect";
import { tasksUpdateDirect } from "@/lib/tasksWriteDirect";
import { autoTransitionTarget } from "@/lib/autoTransition";
import type { WorkTaskStatus, GTaskKind } from "@/lib/appsScript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/worktasks/confirm-pending
 * Body: { id: string }
 *
 * Resolves a pending-completion claim into an actual status transition.
 * The claim was set by `applyAutoTransition` when a Google Task
 * completion was detected; this endpoint flips the hub status to the
 * computed target and clears the flag.
 *
 * Auth: any authenticated hub user. The status_history entry records
 * the confirmer + the original claim's `by` so the audit trail shows
 * both who marked the GT complete AND who confirmed it.
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
    const claimRaw = task.pending_complete || "";
    if (!claimRaw) {
      return NextResponse.json(
        { ok: false, error: "אין סימון השלמה ממתין על משימה זו" },
        { status: 400 },
      );
    }
    let claim: { by?: string; kind?: GTaskKind; prev?: WorkTaskStatus };
    try {
      claim = JSON.parse(claimRaw);
    } catch {
      // Corrupt JSON — treat as missing and clear it.
      await tasksUpdateDirect(subject, id, { pending_complete: "" });
      return NextResponse.json(
        { ok: false, error: "סימון פגום — נוקה" },
        { status: 400 },
      );
    }
    const kind = (claim.kind || "todo") as GTaskKind;
    const prev = (claim.prev || task.status) as WorkTaskStatus;
    const target = autoTransitionTarget(kind, prev, task.approver_email);
    if (!target) {
      // Edge case — claim came from a status that no longer makes sense
      // for the kind. Clear the claim and report as a no-op.
      await tasksUpdateDirect(subject, id, { pending_complete: "" });
      return NextResponse.json(
        { ok: true, changed: false, cleared: true },
      );
    }
    const result = await tasksUpdateDirect(subject, id, {
      status: target,
      pending_complete: "",
      note: claim.by
        ? `אושר ע״י ${subject} (סומן ע״י ${claim.by} ב-Google Tasks)`
        : `אושר ע״י ${subject}`,
    });
    return NextResponse.json({
      ok: true,
      changed: result.changed,
      newStatus: target,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
