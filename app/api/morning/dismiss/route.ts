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
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
