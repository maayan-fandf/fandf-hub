import { NextRequest, NextResponse } from "next/server";
import { dismissMorningSignal } from "@/lib/appsScript";

export async function POST(req: NextRequest) {
  let body: { signalKey?: string; snoozeUntil?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { signalKey, snoozeUntil, reason } = body;
  if (!signalKey) {
    return NextResponse.json({ error: "signalKey required" }, { status: 400 });
  }
  try {
    const result = await dismissMorningSignal({ signalKey, snoozeUntil, reason });
    // Drop the precomputed portfolio feed so the dismissed signal stops
    // showing on the next render. This route busts nothing today, which
    // was survivable while the feed lapsed on a 5-minute TTL; the
    // snapshot lives for hours, so without this a dismissal would appear
    // to do nothing until the next cron run.
    try {
      const { invalidateMorningSnapshot } = await import("@/lib/morningSnapshot");
      await invalidateMorningSnapshot();
    } catch {
      /* best-effort — the dismissal itself already succeeded */
    }
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
