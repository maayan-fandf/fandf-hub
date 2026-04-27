import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { tasksList } from "@/lib/appsScript";
import { getUserPrefs } from "@/lib/userPrefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Count of "open tasks involving me" — used by the topnav משימות
 * badge. Aligns with the home page's "משימות פתוחות" tile so a user
 * who sees "2 open tasks" on home sees the same 2 on the badge.
 *
 * Definition: any non-terminal task (status != done && != cancelled)
 * where I'm involved — author OR approver OR project_manager OR
 * assignee OR mentioned in the task's discussion. The breakdown
 * tooltip surfaces what's behind the number so action items
 * (awaiting_handling / awaiting_clarification for assignees,
 * awaiting_approval for approvers) still stand out at a glance.
 *
 * Previous version only counted action-needed tasks (assignee on
 * handling/clarification + approver on approval) — that didn't
 * match home tile semantics, so users with open tasks where they
 * were author or PM saw "no badge" even though the tile read 2.
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
    // would actually show as the user's open queue.
    const prefs = await getUserPrefs(sessionEmail).catch(() => null);
    const targetEmail = prefs?.view_as_email || sessionEmail;

    // Single tasksList call: every task this user is involved with
    // (matches the new /tasks "מעורב במשימה" filter — author OR
    // approver OR PM OR assignee OR mentioned in discussion).
    // Then we filter out terminal states and bucket the open ones
    // by status for the tooltip breakdown.
    const result = await tasksList({ involved_with: targetEmail });
    const open = (result.tasks || []).filter(
      (t) => t.status !== "done" && t.status !== "cancelled",
    );
    // Bucket all open involved-with tasks by status — no role filter,
    // since the badge total is involvement-broad. Earlier the breakdown
    // was action-narrow (assignee-only / approver-only) which produced
    // an empty tooltip when the user's open tasks were all e.g.
    // in_progress or things they authored. Buckets now sum to `total`
    // by construction so the tooltip always explains the badge.
    const byStatus = (s: string) =>
      open.filter((t) => t.status === s).length;
    return NextResponse.json({
      ok: true,
      total: open.length,
      breakdown: {
        awaiting_handling: byStatus("awaiting_handling"),
        in_progress: byStatus("in_progress"),
        awaiting_clarification: byStatus("awaiting_clarification"),
        awaiting_approval: byStatus("awaiting_approval"),
      },
      target_email: targetEmail,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
