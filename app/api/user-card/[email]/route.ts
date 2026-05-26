/**
 * Read-only enrichment endpoint for the global <UserHoverCard>. The
 * card lazy-fetches this on first open (per-email, client-cached for
 * the session) so the popup can show Workspace title + department +
 * phone numbers without forcing a Directory API call on initial page
 * render of every roster screen.
 *
 * Gated on a signed-in Hub session — the card is never rendered for
 * anonymous visitors, but defense in depth.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getDirectoryUser } from "@/lib/userDirectory";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ email: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { email: raw } = await ctx.params;
  let email = "";
  try {
    email = decodeURIComponent(raw || "").toLowerCase().trim();
  } catch {
    return NextResponse.json({ ok: false, error: "bad email" }, { status: 400 });
  }
  if (!email || !/@/.test(email)) {
    return NextResponse.json({ ok: false, error: "bad email" }, { status: 400 });
  }
  const user = await getDirectoryUser(email);
  // Always return a 200 with `user: null` for non-fandf / not-found —
  // the card uses this as a "no enrichment" signal and just hides the
  // Workspace-only widgets.
  return NextResponse.json({ ok: true, user });
}
