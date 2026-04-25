import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { createMentionDirect } from "@/lib/commentsWriteDirect";

export const dynamic = "force-dynamic";

/**
 * Legacy "create comment with @mentions" endpoint — kept under
 * /api/tasks/create for compatibility with the existing
 * CreateTaskDrawer client component (which is actually a comment
 * creator with mention parsing, not a work-task creator).
 *
 * The new structured-task system lives under /api/worktasks/create.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  let body: {
    project?: string;
    body?: string;
    assignees?: string[];
    due?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { project, body: taskBody, assignees, due } = body;

  if (!project || !taskBody || !taskBody.trim()) {
    return NextResponse.json(
      { error: "project and non-empty body required" },
      { status: 400 },
    );
  }
  if (taskBody.length > 4000) {
    return NextResponse.json(
      { error: "Task body too long (max 4000 chars)" },
      { status: 400 },
    );
  }
  if (!Array.isArray(assignees)) {
    return NextResponse.json(
      { error: "assignees must be an array of emails" },
      { status: 400 },
    );
  }
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    return NextResponse.json(
      { error: "due must be empty or YYYY-MM-DD" },
      { status: 400 },
    );
  }

  try {
    const result = await createMentionDirect(session.user.email, {
      project,
      body: taskBody,
      assignees,
      due: due ?? "",
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
