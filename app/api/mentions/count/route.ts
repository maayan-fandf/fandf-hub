import { NextResponse } from "next/server";
import { getMyMentions } from "@/lib/appsScript";

/**
 * Cheap lookup for the nav badge. Reuses getMyMentions (which the inbox
 * page fetches anyway) and just returns the open count so the layout can
 * render a red-dot without pulling the whole list.
 *
 * The client component that calls this debounces naturally (it only fires
 * on mount) so we don't need additional caching here.
 */
export async function GET() {
  try {
    const data = await getMyMentions();
    const openCount = data.mentions.filter((m) => !m.resolved).length;
    return NextResponse.json({ openCount });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
