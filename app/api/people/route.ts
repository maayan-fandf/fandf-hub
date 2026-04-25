import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { tasksPeopleList } from "@/lib/appsScript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight people list for header-level UI (gear menu's "view as"
 * picker). Mirrors `tasksPeopleList` but returns only what an
 * autocomplete needs: email + name + role.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  try {
    const data = await tasksPeopleList();
    return NextResponse.json({
      ok: true,
      people: (data?.people ?? []).map((p) => ({
        email: p.email,
        name: p.name,
        role: p.role,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
