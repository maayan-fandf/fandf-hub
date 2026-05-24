import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Add a manual (not-task-backed) billing line to the ledger — admin only.
 * The "➕ הוסף חיוב ידני" action on /admin/billing: a one-off / ad-hoc
 * charge (retainer, external expense, manual adjustment) with no task.
 *
 * POST { company, project?, amount, note?, date? }
 * → { ok, row }   (row = the created PricingLogRow, for optimistic UI)
 */

function requireAdmin(email: string | null | undefined): boolean {
  return !!email && HUB_ADMIN_EMAILS.has(email.toLowerCase().trim());
}

const MAX_AMOUNT = 10_000_000;
const MAX_NOTE = 2000;

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? "";
  if (!requireAdmin(email)) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }

  let body: {
    company?: string;
    project?: string;
    amount?: unknown;
    note?: unknown;
    date?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const company = String(body.company || "").trim();
  if (!company) {
    return NextResponse.json(
      { ok: false, error: "יש לבחור/להזין חברה" },
      { status: 400 },
    );
  }

  const amount = Number(String(body.amount ?? "").replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { ok: false, error: "יש להזין סכום תקין" },
      { status: 400 },
    );
  }
  if (amount > MAX_AMOUNT) {
    return NextResponse.json(
      { ok: false, error: "הסכום גדול מדי — בדוק/י את הקלט" },
      { status: 400 },
    );
  }

  const project = String(body.project || "").trim();
  let note = String(body.note ?? "");
  if (note.length > MAX_NOTE) note = note.slice(0, MAX_NOTE);
  note = note.trim();

  const date = String(body.date || "").trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { ok: false, error: "תאריך לא תקין" },
      { status: 400 },
    );
  }

  try {
    const { addManualPricingEntry } = await import("@/lib/pricingLog");
    const row = await addManualPricingEntry({
      subjectEmail: email,
      company,
      project,
      amount,
      note,
      date,
      createdBy: email,
    });
    return NextResponse.json({ ok: true, row });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/admin/billing/add POST] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
