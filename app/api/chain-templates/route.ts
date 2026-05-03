import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";
import type { ChainTemplate } from "@/lib/chainTemplates";

export const dynamic = "force-dynamic";

/**
 * Chain templates CRUD — admin-gated. The /admin/chain-templates UI
 * uses these endpoints to manage the sheet-backed template store.
 *
 * GET    → list every template stored on the ChainTemplates tab
 * POST   → upsert (create or update by id)
 * DELETE → remove by id (request body: { id })
 *
 * Phase 10 of dependencies feature, 2026-05-03.
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
    const { listChainTemplates } = await import("@/lib/chainTemplatesStore");
    const templates = await listChainTemplates(email);
    return NextResponse.json({ ok: true, templates });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/chain-templates GET] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? "";
  if (!requireAdmin(email)) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }
  let body: ChainTemplate;
  try {
    body = (await req.json()) as ChainTemplate;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.id?.trim() || !body.label?.trim()) {
    return NextResponse.json(
      { ok: false, error: "id and label are required" },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.steps) || body.steps.length === 0) {
    return NextResponse.json(
      { ok: false, error: "at least one step is required" },
      { status: 400 },
    );
  }
  try {
    const { upsertChainTemplate } = await import("@/lib/chainTemplatesStore");
    const result = await upsertChainTemplate(email, body);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/chain-templates POST] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? "";
  if (!requireAdmin(email)) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }
  let body: { id?: string };
  try {
    body = (await req.json()) as { id?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.id) {
    return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
  }
  try {
    const { deleteChainTemplate } = await import("@/lib/chainTemplatesStore");
    const result = await deleteChainTemplate(email, body.id);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/chain-templates DELETE] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
