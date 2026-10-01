import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/viewerGate";
import { countGmailOriginTasks } from "@/lib/gmailTasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Staff only: this is the caller's own Google Tasks list, and for an
  // outside address lib/sa reads the owner's instead. Refused callers get
  // the same silent zero as a signed-out poll, so the badge stays hidden.
  const gate = await requireStaff();
  if (gate instanceof NextResponse) return NextResponse.json({ count: 0 });
  const email = gate.email;
  try {
    const count = await countGmailOriginTasks(email);
    return NextResponse.json({ count });
  } catch {
    // Permission gaps shouldn't surface as a 500 to the nav bar — quietly
    // return 0 so the badge just stays hidden.
    return NextResponse.json({ count: 0 });
  }
}
