import { NextRequest, NextResponse } from "next/server";
import { setTaskDue } from "@/lib/appsScript";

export async function POST(req: NextRequest) {
  let body: { commentId?: string; assigneeEmail?: string; due?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { commentId, assigneeEmail, due } = body;
  if (!commentId || !assigneeEmail) {
    return NextResponse.json(
      { error: "commentId and assigneeEmail required" },
      { status: 400 },
    );
  }

  try {
    const result = await setTaskDue({
      commentId,
      assigneeEmail,
      due: due ?? "",
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
