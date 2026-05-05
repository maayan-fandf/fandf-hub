import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { uploadFileToFolder } from "@/lib/driveFolders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cap per-request upload size to keep the App Hosting container's
// memory bounded. The form data has to deserialize entirely before
// reaching this handler. Most task attachments are well under 25MB
// (PSDs, MP4 cuts, briefs); above that the user can use Drive's own
// upload via the Picker which streams through Google's CDN.
export const maxDuration = 60;
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * POST /api/drive/folders/upload
 *
 * Multipart body: { parent: string, file: File }
 * Returns: { ok: true, file: DriveFile }
 *
 * Server-side upload via the SA — keeps file ownership on the shared
 * drive owner, doesn't depend on the user's `drive.file` OAuth scope.
 * Used by TaskFilesPanel's drag-drop upload zone.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid multipart body" },
      { status: 400 },
    );
  }
  const parent = String(form.get("parent") || "").trim();
  const file = form.get("file");
  if (!parent) {
    return NextResponse.json(
      { ok: false, error: "parent is required" },
      { status: 400 },
    );
  }
  if (!(file instanceof File) || !file.size) {
    return NextResponse.json(
      { ok: false, error: "file is required" },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: `קובץ גדול מדי (מקס׳ ${Math.floor(MAX_BYTES / 1024 / 1024)}MB)`,
      },
      { status: 413 },
    );
  }
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const uploaded = await uploadFileToFolder(
      session.user.email,
      parent,
      file.name || "untitled",
      file.type || "application/octet-stream",
      buf,
    );
    return NextResponse.json({ ok: true, file: uploaded });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
