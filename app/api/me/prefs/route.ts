import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getUserPrefs, setUserPrefs, type UserPrefs } from "@/lib/userPrefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  try {
    const prefs = await getUserPrefs(email);
    return NextResponse.json({ ok: true, prefs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

type Body = Partial<UserPrefs>;

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const partial: Partial<UserPrefs> = {};
  if ("email_notifications" in body) partial.email_notifications = !!body.email_notifications;
  if ("gtasks_sync" in body) partial.gtasks_sync = !!body.gtasks_sync;
  if ("view_as_email" in body) {
    partial.view_as_email = String(body.view_as_email || "").toLowerCase().trim();
  }
  try {
    const prefs = await setUserPrefs(email, partial);
    return NextResponse.json({ ok: true, prefs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
