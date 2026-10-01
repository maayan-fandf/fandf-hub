import { NextResponse } from "next/server";
import { requireTeam } from "@/lib/viewerGate";
import { listFolderFiles } from "@/lib/driveFolders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/drive/folders/files?parent=<folderId>
 *
 * Returns the files (non-folder items) directly under `parent`. Used
 * by `TaskFilesPanel` to render the tile grid for a task. Folders
 * still go through `/api/drive/folders/children` — separate endpoints
 * keep the response shapes clean and lets each side cache differently.
 */
export async function GET(req: Request) {
  // Team only: the listing is read as the Shared Drive owner for whatever
  // folder id is sent, and TaskFilesPanel only renders on the task pages,
  // which bounce clients — a client has no folder to list here.
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
    const files = await listFolderFiles(gate.email, parent);
    return NextResponse.json({ ok: true, files });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
