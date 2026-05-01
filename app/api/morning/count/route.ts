import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMorningFeed } from "@/lib/appsScript";
import { getEffectiveViewAs } from "@/lib/viewAsCookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cheap count endpoint backing the top-nav קמפיינים badge. Returns
 * just the urgency breakdown — no project payload — so the badge can
 * render quickly on every nav render without re-fetching the whole
 * morning feed client-side.
 *
 * Quota posture: getMorningFeed is wrapped in unstable_cache with a
 * 60s TTL keyed on (email, scope, project). So this endpoint can be
 * hit 100 times per minute by the badge across users and Apps Script
 * still gets at most one call per user per minute. The badge itself
 * fetches only on mount + on tab focus (no polling interval), which
 * combined with the server cache keeps Apps Script load bounded.
 *
 * Internal-only — clients without admin/internal flag get a zero
 * count (the page itself is gated server-side; no point polling).
 */
export async function GET() {
  const session = await auth();
  const sessionEmail = session?.user?.email;
  if (!sessionEmail) {
    return NextResponse.json({ counts: zero() });
  }
  try {
    // Honor the gear-menu view_as so the count mirrors what /morning
    // would actually render for this user. Same precedence as the
    // morning page itself.
    const viewAs = await getEffectiveViewAs(sessionEmail).catch(() => "");
    const overrideEmail = viewAs && viewAs !== sessionEmail ? viewAs : undefined;
    const feed = await getMorningFeed({ scope: "mine", overrideEmail });
    if (!feed.isAdmin && !feed.isInternal) {
      return NextResponse.json({ counts: zero() });
    }
    return NextResponse.json({
      counts: {
        total: feed.counts.total,
        severe: feed.counts.severe,
        warn: feed.counts.warn,
        info: feed.counts.info,
        clear: feed.counts.clear,
      },
    });
  } catch (e) {
    console.log(
      "[morning/count] failed:",
      e instanceof Error ? e.message : String(e),
    );
    return NextResponse.json({ counts: zero() });
  }
}

function zero() {
  return { total: 0, severe: 0, warn: 0, info: 0, clear: 0 };
}
