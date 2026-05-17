import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";
import type { PricingRow } from "@/lib/pricingMatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pricing rate-card CRUD — admin-gated. Backs the /admin/pricing
 * editor so the per-company/project Pricingsetup tab is managed
 * through a real UI instead of raw Sheets. Same per-client model +
 * project→company fallback the new-task panel resolves against
 * (lib/pricingMatch).
 *
 * GET  → every row on the Pricingsetup tab
 * POST → replace the ENTIRE rate card with { rows: PricingRow[] }
 *        (the editor submits the whole table on Save)
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
    const { readPricingSetup } = await import("@/lib/pricing");
    const rows = await readPricingSetup(email);
    return NextResponse.json({ ok: true, rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/admin/pricing GET] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? "";
  if (!requireAdmin(email)) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }
  let body: { rows?: PricingRow[] };
  try {
    body = (await req.json()) as { rows?: PricingRow[] };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.rows)) {
    return NextResponse.json(
      { ok: false, error: "rows[] is required" },
      { status: 400 },
    );
  }
  try {
    const { replacePricingRows } = await import("@/lib/pricing");
    const result = await replacePricingRows(email, body.rows);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/admin/pricing POST] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
