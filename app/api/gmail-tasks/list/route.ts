import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/viewerGate";
import { listGmailOriginTasks } from "@/lib/gmailTasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Staff only: this is the caller's own Google Tasks list and the mail
  // behind it, and for an outside address lib/sa reads the owner's instead.
  const gate = await requireStaff();
  if (gate instanceof NextResponse) return gate;
  const email = gate.email;
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
