import { NextRequest, NextResponse } from "next/server";
import { deleteComment } from "@/lib/appsScript";

export async function POST(req: NextRequest) {
  let body: { commentId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { commentId } = body;
  if (!commentId) {
    return NextResponse.json({ error: "commentId required" }, { status: 400 });
  }

  try {
    const result = await deleteComment(commentId);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
