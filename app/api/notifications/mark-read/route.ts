import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { markRead } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mark notifications read.
 *
 * Body shapes:
 *   { ids: string[] }   → mark just these
 *   { all: true }       → mark every unread row for this user
 *
 * Returns { ok, updated } so the client can decrement the badge
 * locally without re-fetching.
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  let body: { ids?: string[]; all?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Expected JSON body" },
      { status: 400 },
    );
  }
  const target =
    body.all === true
      ? "*"
      : Array.isArray(body.ids)
        ? body.ids.filter((s) => typeof s === "string" && s)
        : [];
  if (target !== "*" && target.length === 0) {
    return NextResponse.json({ ok: true, updated: 0 });
  }
  const result = await markRead(email, target);
  return NextResponse.json(result);
}
