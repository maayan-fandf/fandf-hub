import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createChildFolder } from "@/lib/driveFolders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  parent?: string;
  name?: string;
};

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const parent = String(body.parent || "").trim();
  const name = String(body.name || "").trim();
  if (!parent || !name) {
    return NextResponse.json(
      { ok: false, error: "parent and name are required" },
      { status: 400 },
    );
  }
  try {
    const folder = await createChildFolder(session.user.email, parent, name);
    return NextResponse.json({ ok: true, folder });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
