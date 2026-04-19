import { NextRequest, NextResponse } from "next/server";
import { reassignTask } from "@/lib/appsScript";

export async function POST(req: NextRequest) {
  let body: { commentId?: string; fromEmail?: string; toEmail?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { commentId, fromEmail, toEmail } = body;
  if (!commentId || !fromEmail || !toEmail) {
    return NextResponse.json(
      { error: "commentId, fromEmail, toEmail required" },
      { status: 400 },
    );
  }

  try {
    const result = await reassignTask({ commentId, fromEmail, toEmail });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
