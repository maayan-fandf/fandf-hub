import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { postReplyDirect } from "@/lib/commentsWriteDirect";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  let body: { parentCommentId?: string; body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { parentCommentId, body: replyBody } = body;
  if (!parentCommentId || !replyBody || !replyBody.trim()) {
    return NextResponse.json(
      { error: "parentCommentId and non-empty body required" },
      { status: 400 },
    );
  }
  if (replyBody.length > 4000) {
    return NextResponse.json(
      { error: "Reply too long (max 4000 chars)" },
      { status: 400 },
    );
  }

  try {
    const result = await postReplyDirect(
      session.user.email,
      parentCommentId,
      replyBody,
    );
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
