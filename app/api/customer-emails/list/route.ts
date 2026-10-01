import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/viewerGate";
import { isStaffEmail } from "@/lib/viewerTier";
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
 * Staff-gated and pref-gated identically to the count endpoint —
 * returns { ok: true, items: [] } when the toggle is off so the
 * popover renders an empty-state hint instead of leaking a 401.
 */
export async function GET() {
  // Staff only: this reads the caller's own inbox, and for an outside
  // address lib/sa reads the owner's instead.
  const gate = await requireStaff();
  if (gate instanceof NextResponse) return gate;
  const sessionEmail = gate.email;
  try {
    const viewAs = await getEffectiveViewAs(sessionEmail).catch(() => "");
    const targetEmail = viewAs || sessionEmail;
    const prefs = await getUserPrefs(targetEmail);
    // The pref only counts on a staff row — an outside address has no
    // inbox of its own for it to refer to.
    if (!isStaffEmail(targetEmail) || !prefs.gmail_customer_poll) {
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
