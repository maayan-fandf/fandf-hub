import { NextResponse } from "next/server";
import { requireTeam } from "@/lib/viewerGate";
import { createChildFolder } from "@/lib/driveFolders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  parent?: string;
  name?: string;
};

export async function POST(req: Request) {
  // Team only: the folder is created as the Shared Drive owner under
  // whatever parent is sent. The picker's "+ new folder" lives in the task
  // form, which clients never reach.
  const gate = await requireTeam();
  if (gate instanceof NextResponse) return gate;
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
  // A real folder id only — "root" is a valid Drive alias, and here it
  // would mean the owner's own My Drive.
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(parent)) {
    return NextResponse.json(
      { ok: false, error: "invalid parent" },
      { status: 400 },
    );
  }
  try {
    const folder = await createChildFolder(gate.email, parent, name);
    return NextResponse.json({ ok: true, folder });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
