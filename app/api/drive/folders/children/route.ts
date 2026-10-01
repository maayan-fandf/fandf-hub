import { NextResponse } from "next/server";
import { requireTeam } from "@/lib/viewerGate";
import { listFolderChildren } from "@/lib/driveFolders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Team only: the folder tree is read as the Shared Drive owner, and the
  // one caller (DriveFolderPicker in the task form) sits on pages that
  // bounce clients — so a client asking is browsing other clients' folders.
  const gate = await requireTeam();
  if (gate instanceof NextResponse) return gate;
  const url = new URL(req.url);
  const parent = (url.searchParams.get("parent") || "").trim();
  if (!parent) {
    return NextResponse.json(
      { ok: false, error: "parent is required" },
      { status: 400 },
    );
  }
  // `parent` is spliced into the Drive query (`'<id>' in parents`). Only an
  // id-shaped value may get there: a quote would break out of the clause
  // and turn the listing into a free search of the whole Shared Drive.
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(parent)) {
    return NextResponse.json(
      { ok: false, error: "invalid parent" },
      { status: 400 },
    );
  }
  try {
    const children = await listFolderChildren(gate.email, parent);
    return NextResponse.json({ ok: true, children });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
