import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listNotifications } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns the recent notifications for the signed-in user, newest
 * first. Default limit 100, hard-cap 200 (enforced inside lib).
 *
 * Query: ?unread=1 to filter to unread only.
 */
export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const limit = Number(url.searchParams.get("limit") || "100");
  const items = await listNotifications(email, { limit, unreadOnly });
  return NextResponse.json({ ok: true, items });
}
