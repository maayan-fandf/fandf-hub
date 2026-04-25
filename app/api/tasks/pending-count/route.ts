import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { tasksList } from "@/lib/appsScript";
import { getUserPrefs } from "@/lib/userPrefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Count of "tasks on my plate that need movement" — used by the
 * topnav משימות badge. Tasks count when the user (or whoever they're
 * viewing-as) is an assignee AND the status is awaiting_handling or
 * awaiting_clarification (the two states that explicitly call for
 * the assignee to act). awaiting_approval is intentionally excluded:
 * it's the approver's plate, not the assignee's.
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

    // Two API calls — one per status — since the filter only takes a
    // single status. Cheap enough at this scale; the caller debounces
    // (refetches on pathname change, not constantly).
    const [handling, clarif] = await Promise.all([
      tasksList({ assignee: targetEmail, status: "awaiting_handling" }),
      tasksList({ assignee: targetEmail, status: "awaiting_clarification" }),
    ]);
    const handlingCount = handling.tasks?.length ?? 0;
    const clarifCount = clarif.tasks?.length ?? 0;
    return NextResponse.json({
      ok: true,
      total: handlingCount + clarifCount,
      breakdown: {
        awaiting_handling: handlingCount,
        awaiting_clarification: clarifCount,
      },
      target_email: targetEmail,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
