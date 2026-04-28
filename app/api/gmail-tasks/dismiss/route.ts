import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { auth } from "@/auth";
import { dismissGmailOriginTask } from "@/lib/gmailTasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mark one Gmail-origin Google Task complete. Called after the user
 *  converts it to a hub WorkTask (or just dismisses it). Body shape:
 *  `{ taskId: string }`. */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  let taskId = "";
  try {
    const body = await req.json();
    taskId = String(body?.taskId || "").trim();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!taskId) {
    return NextResponse.json({ ok: false, error: "taskId is required" }, { status: 400 });
  }
  try {
    await dismissGmailOriginTask(email, taskId);
    revalidateTag("gmail-origin-tasks");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
