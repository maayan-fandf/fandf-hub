import { NextRequest, NextResponse } from "next/server";
import { getCommentReplies } from "@/lib/appsScript";
import { requireViewer } from "@/lib/viewerGate";
import { canOpenProject } from "@/lib/projectAccess";

// GET /api/comments/replies?parentId=<id>&project=<name>
//
// Proxies to the Apps Script `commentReplies` action so the hub can render
// thread replies inline under a task/mention card without re-fetching the
// whole project comment feed. Read-only — none of the Chat/Task write paths
// are touched.
export async function GET(req: NextRequest) {
  // Clients open reply threads too, so any hub viewer may call this — but the
  // route itself never asked who was calling; only the reader underneath did.
  const gate = await requireViewer();
  if (gate instanceof NextResponse) return gate;

  const { searchParams } = new URL(req.url);
  const parentId = searchParams.get("parentId") ?? "";
  const project = searchParams.get("project") ?? "";

  if (!parentId || !project) {
    return NextResponse.json(
      { error: "parentId and project query params are required" },
      { status: 400 },
    );
  }
  // Same rule the direct reader applies; said here so it also holds on the
  // Apps Script fallback path and answers 403 rather than a 500.
  if (!(await canOpenProject(gate.email, project))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const result = await getCommentReplies(parentId, project);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
