import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Time-tracking ledger feed — admin-gated. Returns every TimeLog row so
 * the /admin/time report can group by company × month and sum the time
 * spent. Read-only; informational (does not drive billing).
 *
 * GET → { ok, rows: TimeLogRow[] }  (rows: [] when the ledger tab
 *        doesn't exist yet — no time logged since launch)
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
    const { readTimeLog } = await import("@/lib/timeLog");
    const rows = await readTimeLog(email);
    return NextResponse.json({ ok: true, rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/admin/time GET] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
