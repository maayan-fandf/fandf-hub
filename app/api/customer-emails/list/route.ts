import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getEffectiveViewAs } from "@/lib/viewAsCookie";
import { getUserPrefs } from "@/lib/userPrefs";
import { listCustomerEmails } from "@/lib/customerEmails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Full-detail endpoint backing the top-nav popover. Same data as the
 * /customer-emails page but in JSON form so the popover can render
 * client-side without a full navigation.
 *
 * Auth-gated and pref-gated identically to the count endpoint —
 * returns { ok: true, items: [] } when the toggle is off so the
 * popover renders an empty-state hint instead of leaking a 401.
 */
export async function GET() {
  const session = await auth();
  const sessionEmail = session?.user?.email;
  if (!sessionEmail) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  try {
    const viewAs = await getEffectiveViewAs(sessionEmail).catch(() => "");
    const targetEmail = viewAs || sessionEmail;
    const prefs = await getUserPrefs(targetEmail);
    if (!prefs.gmail_customer_poll) {
      return NextResponse.json({ ok: true, items: [], optedIn: false });
    }
    const items = await listCustomerEmails(targetEmail);
    return NextResponse.json({ ok: true, items, optedIn: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[customer-emails/list] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
