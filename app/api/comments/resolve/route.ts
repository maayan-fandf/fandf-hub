import { NextRequest, NextResponse } from "next/server";
import { resolveComment } from "@/lib/appsScript";

export async function POST(req: NextRequest) {
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
    const result = await resolveComment({ commentId, resolved });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
