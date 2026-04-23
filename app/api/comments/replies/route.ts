import { NextRequest, NextResponse } from "next/server";
import { getCommentReplies } from "@/lib/appsScript";

// GET /api/comments/replies?parentId=<id>&project=<name>
//
// Proxies to the Apps Script `commentReplies` action so the hub can render
// thread replies inline under a task/mention card without re-fetching the
// whole project comment feed. Read-only — none of the Chat/Task write paths
// are touched.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const parentId = searchParams.get("parentId") ?? "";
  const project = searchParams.get("project") ?? "";

  if (!parentId || !project) {
    return NextResponse.json(
      { error: "parentId and project query params are required" },
      { status: 400 },
    );
  }

  try {
    const result = await getCommentReplies(parentId, project);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
