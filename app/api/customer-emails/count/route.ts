import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/viewerGate";
import { isStaffEmail } from "@/lib/viewerTier";
import { getEffectiveViewAs } from "@/lib/viewAsCookie";
import { getUserPrefs } from "@/lib/userPrefs";
import { listCustomerEmails } from "@/lib/customerEmails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cheap count endpoint backing the top-nav badge for unread customer
 * emails. Mirrors /api/gmail-tasks/count's contract: returns a single
 * integer that the badge can show / hide on. The badge polls every
 * 60s + on tab focus, so this fires often — keep it light.
 *
 * Returns 0 (and renders no badge) when:
 *   - User isn't authenticated (401-equivalent)
 *   - User isn't @fandf.co.il staff (403-equivalent)
 *   - User hasn't opted into the gmail_customer_poll pref
 *   - There are zero registered customer senders OR zero unread
 *     messages from them in the lookback window
 *
 * Implementation just delegates to listCustomerEmails (which returns
 * read+unread) and counts the unread subset. The Gmail call is the
 * same one /customer-emails uses for its main render, so polling
 * here doesn't double the cost — Gmail's per-second quota soaks it.
 */
export async function GET() {
  // Staff only: this reads the caller's own inbox, and for an outside
  // address lib/sa reads the owner's instead. Refused callers get the
  // same silent zero as a signed-out poll, so the badge just stays hidden.
  const gate = await requireStaff();
  if (gate instanceof NextResponse) {
    return NextResponse.json({ count: 0 });
  }
  const sessionEmail = gate.email;
  try {
    const viewAs = await getEffectiveViewAs(sessionEmail).catch(() => "");
    const targetEmail = viewAs || sessionEmail;
    const prefs = await getUserPrefs(targetEmail);
    // The pref only counts on a staff row — an outside address has no
    // inbox of its own for it to refer to.
    if (!isStaffEmail(targetEmail) || !prefs.gmail_customer_poll) {
      return NextResponse.json({ count: 0 });
    }
    const items = await listCustomerEmails(targetEmail);
    const count = items.filter((it) => it.isUnread).length;
    return NextResponse.json({ count });
  } catch (e) {
    console.log(
      "[customer-emails/count] failed:",
      e instanceof Error ? e.message : String(e),
    );
    return NextResponse.json({ count: 0 });
  }
}
