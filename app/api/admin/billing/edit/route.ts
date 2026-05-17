import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-entry month-end billing adjustment — admin only.
 *
 * Sets (or clears) the `billed` override on a task's PricingLog
 * row(s). It does NOT touch the recorded `price`, the task row, or the
 * rate card (/admin/pricing) — it's purely "invoice THIS entry for a
 * different amount this month" (e.g. bill higher/lower than the price).
 *
 * POST { taskId, billed }       → set the override to `billed`
 * POST { taskId, reset: true }  → clear it (revert to billing `price`)
 * → { ok, billed: number|null, updated }   (updated = ledger rows hit)
 */

function requireAdmin(email: string | null | undefined): boolean {
  return !!email && HUB_ADMIN_EMAILS.has(email.toLowerCase().trim());
}

const MAX_BILLED = 10_000_000; // sane ceiling — catches a fat-finger paste

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? "";
  if (!requireAdmin(email)) {
    return NextResponse.json(
      { ok: false, error: "Admin only" },
      { status: 403 },
    );
  }

  let body: { taskId?: string; billed?: unknown; reset?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const taskId = String(body.taskId || "").trim();
  if (!taskId) {
    return NextResponse.json(
      { ok: false, error: "taskId required" },
      { status: 400 },
    );
  }

  const reset = body.reset === true;
  let billed: number | null = null;
  if (!reset) {
    const n = Number(String(body.billed ?? "").replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json(
        { ok: false, error: "יש להזין סכום תקין" },
        { status: 400 },
      );
    }
    if (n > MAX_BILLED) {
      return NextResponse.json(
        { ok: false, error: "הסכום גדול מדי — בדוק/י את הקלט" },
        { status: 400 },
      );
    }
    billed = Math.round(n);
  }

  try {
    const { updatePricingLogBilled } = await import("@/lib/pricingLog");
    const updated = await updatePricingLogBilled(email, taskId, billed);
    return NextResponse.json({ ok: true, billed, updated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/admin/billing/edit POST] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
