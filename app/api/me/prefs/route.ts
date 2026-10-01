import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getUserPrefs, setUserPrefs, type UserPrefs } from "@/lib/userPrefs";
import { isStaffEmail } from "@/lib/viewerTier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * This route is for every viewer — a client mutes notifications here too.
 * The one pref that is not is `gmail_customer_poll`: it means "show mail
 * from MY inbox", and only @fandf.co.il has an inbox the hub can open as
 * the viewer (for anyone else lib/sa opens the owner's). So an outside
 * address can neither switch it on (POST) nor be told it is on (here) —
 * a row that already carries it reads as off.
 */
function prefsFor(email: string, prefs: UserPrefs): UserPrefs {
  return isStaffEmail(email) ? prefs : { ...prefs, gmail_customer_poll: false };
}

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
    const prefs = prefsFor(email, await getUserPrefs(email));
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
  // Refused rather than silently dropped, and before anything is written:
  // the toggle in the gear menu then shows why it flipped back. Switching
  // it OFF stays allowed, so an outside row that has it can be cleared.
  if (body.gmail_customer_poll && !isStaffEmail(email)) {
    return NextResponse.json(
      {
        ok: false,
        error: "מיילים מלקוחות זמין רק לכתובות @fandf.co.il",
      },
      { status: 403 },
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
    const prefs = prefsFor(email, await setUserPrefs(email, partial));
    return NextResponse.json({ ok: true, prefs });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
