import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveCommentDirect } from "@/lib/commentsWriteDirect";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  let body: { commentId?: string; resolved?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { commentId, resolved } = body;
  if (!commentId || typeof resolved !== "boolean") {
    return NextResponse.json(
      { error: "commentId and resolved (boolean) required" },
      { status: 400 },
    );
  }

  try {
    const result = await resolveCommentDirect(
      session.user.email,
      commentId,
      resolved,
    );
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
