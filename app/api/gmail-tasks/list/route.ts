import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listGmailOriginTasks } from "@/lib/gmailTasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  try {
    const tasks = await listGmailOriginTasks(email);
    return NextResponse.json({ ok: true, tasks });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
