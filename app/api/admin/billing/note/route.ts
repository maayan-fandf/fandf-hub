import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-entry billing note — admin only.
 *
 * Sets (or clears) the free-text `note` on a task's PricingLog row(s).
 * Pure annotation — it never touches the recorded `price`, the `billed`
 * override, the task row, or the rate card. Context for the invoice
 * (e.g. "discount agreed with client", "verify with finance").
 *
 * POST { taskId, note }            → set the note (empty string clears it)
 * → { ok, note: string, updated }   (updated = ledger rows hit)
 */

function requireAdmin(email: string | null | undefined): boolean {
  return !!email && HUB_ADMIN_EMAILS.has(email.toLowerCase().trim());
}

const MAX_NOTE = 2000; // sane ceiling

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? "";
  if (!requireAdmin(email)) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }

  let body: { taskId?: string; note?: unknown };
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

  let note = String(body.note ?? "");
  if (note.length > MAX_NOTE) note = note.slice(0, MAX_NOTE);
  note = note.trim();

  try {
    const { updatePricingLogNote } = await import("@/lib/pricingLog");
    const updated = await updatePricingLogNote(email, taskId, note);
    return NextResponse.json({ ok: true, note, updated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/admin/billing/note POST] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
