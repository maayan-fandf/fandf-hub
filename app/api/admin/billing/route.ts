import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Billing ledger feed — admin-gated. Returns every PricingLog row so
 * the /admin/billing report can group by company × month and total
 * for month-end client invoicing. Read-only.
 *
 * GET → { ok, rows: PricingLogRow[] }  (rows: [] when the ledger tab
 *        doesn't exist yet — no priced task created since launch)
 */

function requireAdmin(email: string | null | undefined): boolean {
  return !!email && HUB_ADMIN_EMAILS.has(email.toLowerCase().trim());
}

export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? "";
  if (!requireAdmin(email)) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }
  try {
    const { readPricingLog } = await import("@/lib/pricingLog");
    const rows = await readPricingLog(email);
    return NextResponse.json({ ok: true, rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/admin/billing GET] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
