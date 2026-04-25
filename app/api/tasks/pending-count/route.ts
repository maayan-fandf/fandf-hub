import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { tasksList } from "@/lib/appsScript";
import { getUserPrefs } from "@/lib/userPrefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Count of "tasks needing my action" — used by the topnav משימות
 * badge. Three buckets:
 *
 *   - awaiting_handling   — I'm the assignee, work hasn't started.
 *   - awaiting_clarification — I'm the assignee, blocked on info.
 *   - awaiting_approval   — I'm the approver, finished work to review.
 *
 * Total combines all three. Tooltip on the badge breaks them out so
 * the user sees what's behind the number at a glance.
 */
export async function GET() {
  const session = await auth();
  const sessionEmail = session?.user?.email;
  if (!sessionEmail) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  try {
    // Respect the gear-menu view_as so the badge mirrors what /tasks
    // would actually show as the user's pending queue.
    const prefs = await getUserPrefs(sessionEmail).catch(() => null);
    const targetEmail = prefs?.view_as_email || sessionEmail;

    // One tasksList call per status; the filter takes a single status.
    // Three round-trips total — cheap at this scale, and the caller
    // debounces (re-fetches on pathname change, not constantly).
    const [handling, clarif, approval] = await Promise.all([
      tasksList({ assignee: targetEmail, status: "awaiting_handling" }),
      tasksList({ assignee: targetEmail, status: "awaiting_clarification" }),
      tasksList({ approver: targetEmail, status: "awaiting_approval" }),
    ]);
    const handlingCount = handling.tasks?.length ?? 0;
    const clarifCount = clarif.tasks?.length ?? 0;
    const approvalCount = approval.tasks?.length ?? 0;
    return NextResponse.json({
      ok: true,
      total: handlingCount + clarifCount + approvalCount,
      breakdown: {
        awaiting_handling: handlingCount,
        awaiting_clarification: clarifCount,
        awaiting_approval: approvalCount,
      },
      target_email: targetEmail,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
