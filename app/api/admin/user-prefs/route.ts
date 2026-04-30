import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMyProjects } from "@/lib/appsScript";
import {
  listAllUserPrefs,
  setUserPrefs,
  type UserPrefs,
} from "@/lib/userPrefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only "edit anyone's prefs" endpoint backing /admin/user-prefs.
 * Mirrors the bidirectional sheet ↔ UI principle — every read is a
 * fresh sheet pull, every write goes straight to the User Preferences
 * tab via setUserPrefs.
 *
 * GET — returns the full prefs table.
 * POST { email, partial } — flips the named prefs on the target's row.
 */

async function gateAdmin(): Promise<{ adminEmail: string } | NextResponse> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  const me = await getMyProjects().catch(() => null);
  if (!me?.isAdmin) {
    return NextResponse.json(
      { ok: false, error: "Admin only" },
      { status: 403 },
    );
  }
  return { adminEmail: email };
}

export async function GET() {
  const gate = await gateAdmin();
  if (gate instanceof NextResponse) return gate;
  try {
    const list = await listAllUserPrefs(gate.adminEmail);
    return NextResponse.json({ ok: true, users: list });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const gate = await gateAdmin();
  if (gate instanceof NextResponse) return gate;
  let body: { email?: string; partial?: Partial<UserPrefs> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const target = String(body.email ?? "").toLowerCase().trim();
  if (!target) {
    return NextResponse.json(
      { ok: false, error: "email required" },
      { status: 400 },
    );
  }
  const partial = body.partial ?? {};
  if (typeof partial !== "object" || partial === null) {
    return NextResponse.json(
      { ok: false, error: "partial must be an object" },
      { status: 400 },
    );
  }
  try {
    const updated = await setUserPrefs(target, partial);
    return NextResponse.json({ ok: true, email: target, prefs: updated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
