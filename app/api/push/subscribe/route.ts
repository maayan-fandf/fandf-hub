import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { savePushSubscription } from "@/lib/pushSubscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Store the caller's Web Push subscription (one per browser/device) so
 * notifyOnce can send background notifications to it. Body:
 *   { subscription: PushSubscription.toJSON() }
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  let body: { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const sub = body.subscription;
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return NextResponse.json({ ok: false, error: "Invalid subscription" }, { status: 400 });
  }
  try {
    await savePushSubscription(email, {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/push/subscribe] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
