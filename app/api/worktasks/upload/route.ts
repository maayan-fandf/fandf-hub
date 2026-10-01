import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { uploadToTaskFolder } from "@/lib/taskUpload";
import { requireTeam } from "@/lib/viewerGate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  // Team only: the file is written into the Tasks shared drive as the
  // owner. Every caller is a task surface, which clients never see.
  // (Which TASK the caller may touch is checked in uploadToTaskFolder.)
  const gate = await requireTeam();
  if (gate instanceof NextResponse) return gate;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Expected multipart/form-data" },
      { status: 400 },
    );
  }

  const taskId = String(form.get("taskId") || "").trim();
  const fileEntry = form.get("file");
  if (!taskId || !(fileEntry instanceof Blob)) {
    return NextResponse.json(
      { ok: false, error: "taskId and file are required" },
      { status: 400 },
    );
  }
  if (fileEntry.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: `File too large (max ${MAX_BYTES / 1024 / 1024}MB)` },
      { status: 413 },
    );
  }
  // Reject 0-byte uploads up-front rather than streaming them down to
  // Drive (where they'd land as empty image.png files that render as
  // broken icons in comments). Symptom Maayan hit 2026-05-12: a paste
  // that registered as an image file in the clipboard but carried no
  // actual bytes.
  if (fileEntry.size === 0) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "הקובץ ריק — ייתכן שההדבקה לא הצליחה. נסה/י לצלם או לבחור שוב ולהדביק.",
      },
      { status: 400 },
    );
  }

  const fileName =
    fileEntry instanceof File && fileEntry.name
      ? fileEntry.name
      : `pasted-${Date.now()}.png`;
  const mimeType = fileEntry.type || "application/octet-stream";

  try {
    const bytes = Buffer.from(await fileEntry.arrayBuffer());
    const result = await uploadToTaskFolder(
      session.user.email,
      taskId,
      fileName,
      mimeType,
      bytes,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "Access denied") {
      return NextResponse.json({ ok: false, error: msg }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
