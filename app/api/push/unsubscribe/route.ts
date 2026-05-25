import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { deletePushSubscriptionByEndpoint } from "@/lib/pushSubscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Remove a Web Push subscription (the user turned off background
 * notifications on this device). Body: { endpoint }.
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  let body: { endpoint?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const endpoint = String(body.endpoint || "").trim();
  if (!endpoint) {
    return NextResponse.json({ ok: false, error: "endpoint required" }, { status: 400 });
  }
  try {
    await deletePushSubscriptionByEndpoint(endpoint);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
