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
  // Allow-list every field on UserPrefs. Earlier this branch listed
  // only the original four prefs (email_notifications / gtasks_sync /
  // view_as_email / gmail_customer_poll) because those were the only
  // fields when the route was written. Newer prefs (tasks_sort,
  // hide_archived, agenda_collapsed, etc.) were added to the type +
  // read path but never to this allow-list — so client POSTs for
  // them succeeded with `{ok:true}` while the sheet never changed.
  // Reported by Maayan 2026-05-07 specifically for `agenda_collapsed`,
  // but the same silent-drop trap applied to FIVE other fields.
  const partial: Partial<UserPrefs> = {};
  if ("email_notifications" in body) partial.email_notifications = !!body.email_notifications;
  if ("gtasks_sync" in body) partial.gtasks_sync = !!body.gtasks_sync;
  if ("view_as_email" in body) {
    partial.view_as_email = String(body.view_as_email || "").toLowerCase().trim();
  }
  if ("notifications_snooze_until" in body) {
    partial.notifications_snooze_until = String(
      body.notifications_snooze_until || "",
    ).trim();
  }
  if ("tasks_sort" in body) {
    partial.tasks_sort = String(body.tasks_sort || "").trim();
  }
  if ("tasks_sort_order" in body) {
    partial.tasks_sort_order = String(body.tasks_sort_order || "").trim();
  }
  if ("hide_archived" in body) partial.hide_archived = !!body.hide_archived;
  if ("archive_after_days" in body) {
    partial.archive_after_days = String(body.archive_after_days || "").trim();
  }
  if ("gmail_customer_poll" in body) {
    partial.gmail_customer_poll = !!body.gmail_customer_poll;
  }
  if ("agenda_collapsed" in body) partial.agenda_collapsed = !!body.agenda_collapsed;
  try {
    const prefs = await setUserPrefs(email, partial);
    return NextResponse.json({ ok: true, prefs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
