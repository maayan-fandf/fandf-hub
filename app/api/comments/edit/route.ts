import { NextRequest, NextResponse } from "next/server";
import { editComment } from "@/lib/appsScript";

export async function POST(req: NextRequest) {
  let body: { commentId?: string; body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { commentId, body: newBody } = body;
  if (!commentId || !newBody || !newBody.trim()) {
    return NextResponse.json(
      { error: "commentId and non-empty body required" },
      { status: 400 },
    );
  }
  if (newBody.length > 4000) {
    return NextResponse.json(
      { error: "Body too long (max 4000 chars)" },
      { status: 400 },
    );
  }

  try {
    const result = await editComment({ commentId, body: newBody });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
