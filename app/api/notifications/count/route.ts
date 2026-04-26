import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { countUnread } from "@/lib/notifications";
import { getUserPrefs } from "@/lib/userPrefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cheap lookup for the topnav bell badge. Returns:
 *   { count, snoozedUntil }
 * The badge component uses `count` to render the red dot and
 * `snoozedUntil` to grey it out when snooze is active. Snoozed users
 * still get rows written + emails sent — the snooze affects the
 * visual badge only, so users can opt back in by visiting the page.
 */
export async function GET() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ count: 0, snoozedUntil: "" });
  }
  const [count, prefs] = await Promise.all([
    countUnread(email),
    getUserPrefs(email).catch(() => null),
  ]);
  const snoozedUntil = prefs?.notifications_snooze_until || "";
  // Defensive: if snooze is set to a past timestamp treat it as no
  // snooze. Avoids showing a "snoozed" state forever after a one-time
  // 1h snooze the user forgot about.
  const stillSnoozed =
    snoozedUntil && new Date(snoozedUntil).getTime() > Date.now()
      ? snoozedUntil
      : "";
  return NextResponse.json({ count, snoozedUntil: stillSnoozed });
}
