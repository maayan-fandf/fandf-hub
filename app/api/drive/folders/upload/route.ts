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
//
// 30MB, not the 50MB this used to claim. Cloud Run refuses a request
// body over 32 MiB before our code runs at all — measured on prod
// 2026-09-06, a 33MB upload comes back as Cloud Run's own HTML 500
// page — so the old ceiling promised 18MB that could never arrive and
// turned into an unexplained failure instead of a clear message.
export const maxDuration = 60;
const MAX_BYTES = 30 * 1024 * 1024;

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
  // Size first, and from the header — a body that is too big has to be
  // rejected with a sentence the uploader can act on, BEFORE formData()
  // gets to fail on it for a reason that reads like a bug in the file.
  // Sapir hit exactly that on 2026-09-06: a render over the middleware
  // clone limit came back as "Invalid multipart body", which says nothing
  // about size and sent everyone looking at the JPEG.
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: `הקובץ גדול מדי (${Math.round(declared / 1024 / 1024)}MB, מקסימום ${Math.floor(MAX_BYTES / 1024 / 1024)}MB). העלה/י אותו ישירות ל-Drive דרך התיקייה של הפרויקט.`,
      },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    // Never swallow the cause. Undici's parse errors name the actual
    // problem ("expected boundary after body" = the body arrived
    // truncated), and without it a size/transport failure is
    // indistinguishable from a corrupt file.
    const cause =
      e instanceof Error
        ? String((e.cause as Error | undefined)?.message ?? e.message)
        : String(e);
    console.warn(
      `[drive/upload] formData() failed (content-length=${declared}): ${cause}`,
    );
    return NextResponse.json(
      {
        ok: false,
        error: `לא הצלחתי לקרוא את הקובץ מהבקשה (${cause}). אם הקובץ גדול, נסה/י להעלות אותו ישירות ל-Drive.`,
      },
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
