import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMyProjects } from "@/lib/appsScript";
import { upsertManagementFee } from "@/lib/managementFees";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/management-fees
 *
 * Upserts a per-(project-slug, channel) management-fee override.
 * Admin-only — same gate as /morning/forecast itself.
 *
 * Body: { slug, channel, percent }
 *   - slug, channel: strings (forecast page passes them lowercased)
 *   - percent: number, 0-100 (clamped server-side)
 *
 * Response: { ok: true, fee } on success, { ok: false, error } else.
 */
export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  // Admin gate via getMyProjects().isAdmin. Same predicate the
  // /morning/forecast page checks; non-admins shouldn't be able to
  // override fees the team relies on for billing.
  const me = await getMyProjects().catch(() => null);
  if (!me?.isAdmin) {
    return NextResponse.json(
      { ok: false, error: "Admin only" },
      { status: 403 },
    );
  }

  let body: { slug?: string; channel?: string; percent?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const slug = String(body.slug || "").trim();
  const channel = String(body.channel || "").trim();
  if (!slug || !channel) {
    return NextResponse.json(
      { ok: false, error: "slug and channel are required" },
      { status: 400 },
    );
  }
  const percent = Number(body.percent);
  if (!Number.isFinite(percent)) {
    return NextResponse.json(
      { ok: false, error: "percent must be a number" },
      { status: 400 },
    );
  }

  try {
    const fee = await upsertManagementFee({
      slug,
      channel,
      percent,
      updatedBy: email,
    });
    return NextResponse.json({ ok: true, fee });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("[/api/management-fees POST] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
