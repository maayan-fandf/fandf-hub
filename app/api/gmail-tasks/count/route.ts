import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { countGmailOriginTasks } from "@/lib/gmailTasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ count: 0 });
  try {
    const count = await countGmailOriginTasks(email);
    return NextResponse.json({ count });
  } catch {
    // Permission gaps shouldn't surface as a 500 to the nav bar — quietly
    // return 0 so the badge just stays hidden.
    return NextResponse.json({ count: 0 });
  }
}
