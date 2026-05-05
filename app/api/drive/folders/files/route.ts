import { NextResponse } from "next/server";
import { auth } from "@/auth";
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
    const files = await listFolderFiles(session.user.email, parent);
    return NextResponse.json({ ok: true, files });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
