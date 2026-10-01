/**
 * Read-only enrichment endpoint for the global <UserHoverCard>. The
 * card lazy-fetches this on first open (per-email, client-cached for
 * the session) so the popup can show Workspace title + department +
 * phone numbers without forcing a Directory API call on initial page
 * render of every roster screen.
 *
 * Gated on a signed-in Hub session — the card is never rendered for
 * anonymous visitors, but defense in depth.
 *
 * Phone numbers go to the team only. The directory is read as the owner
 * identity and getDirectoryUser checks the TARGET's domain, never the
 * viewer — so this route is the only place that can. Clients do call it
 * (the hover card is mounted for every viewer in app/layout.tsx), and
 * for them it answers with name + title and blank phones: the card then
 * simply hides its WhatsApp / call buttons.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getDirectoryUser } from "@/lib/userDirectory";
import { viewerTier } from "@/lib/viewerTier";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ email: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tier = await viewerTier(session.user.email);
  const teamViewer = tier === "staff" || tier === "team";
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
  return NextResponse.json({
    ok: true,
    user:
      user && !teamViewer
        ? { ...user, mobilePhone: "", mobilePhoneE164: "", workPhone: "" }
        : user,
  });
}
