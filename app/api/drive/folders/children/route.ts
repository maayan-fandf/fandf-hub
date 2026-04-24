import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listFolderChildren } from "@/lib/driveFolders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  const url = new URL(req.url);
  const parent = (url.searchParams.get("parent") || "").trim();
  if (!parent) {
    return NextResponse.json(
      { ok: false, error: "parent is required" },
      { status: 400 },
    );
  }
  try {
    const children = await listFolderChildren(session.user.email, parent);
    return NextResponse.json({ ok: true, children });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
