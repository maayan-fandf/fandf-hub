import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { useSATasksWrites } from "@/lib/sa";

/**
 * POST /api/worktasks/quick-note
 *
 * Self-note quick-capture endpoint. Creates a Comments-sheet task row with
 * pseudo-project `__personal__`, assignees = [session user], status =
 * `awaiting_handling`, kind = `personal_note`. The row bypasses Keys
 * lookups (see lib/tasksWriteDirect.ts isPseudoProject) and is gated to
 * the assignee/author at read time (see lib/tasksDirect.ts gate).
 *
 * Body: `{ title: string; description?: string; due?: string }`
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  let body: { title?: string; description?: string; due?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const title = String(body.title || "").trim();
  if (!title) {
    return NextResponse.json(
      { ok: false, error: "title is required" },
      { status: 400 },
    );
  }

  // Quick-note is direct-write only — the Apps Script fallback path's
  // `createTaskForUser_` enforces a Keys roster check that pseudo-projects
  // don't satisfy. If/when the Apps Script side learns about pseudo-
  // projects we can enable the fallback.
  if (!useSATasksWrites()) {
    return NextResponse.json(
      { ok: false, error: "Quick notes require the direct-SA write path" },
      { status: 503 },
    );
  }

  try {
    const { tasksCreateDirect } = await import("@/lib/tasksWriteDirect");
    const result = await tasksCreateDirect(session.user.email, {
      project: "__personal__",
      title,
      description: String(body.description || ""),
      kind: "personal_note",
      // Self-assigned by definition. The assignee gets a "📋 לבצע" GT
      // card in their personal Google Tasks list, same as any other
      // task — natural overlap with their existing daily flow.
      assignees: [session.user.email],
      requested_date: typeof body.due === "string" ? body.due : "",
      // Pseudo-projects skip approver/PM/department resolution server-side.
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
