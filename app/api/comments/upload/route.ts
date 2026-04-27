import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { uploadToProjectCommentsFolder } from "@/lib/commentsUpload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Upload an attachment to a project's הערות subfolder, used by the
 * "+ הערה" drawer on the project page. Mirrors /api/worktasks/upload
 * but keyed on `project` instead of `taskId` — comments are project-
 * scoped, not task-scoped.
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
      { ok: false, error: "Expected multipart/form-data" },
      { status: 400 },
    );
  }

  const project = String(form.get("project") || "").trim();
  const fileEntry = form.get("file");
  if (!project || !(fileEntry instanceof Blob)) {
    return NextResponse.json(
      { ok: false, error: "project and file are required" },
      { status: 400 },
    );
  }
  if (fileEntry.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: `File too large (max ${MAX_BYTES / 1024 / 1024}MB)` },
      { status: 413 },
    );
  }

  const fileName =
    fileEntry instanceof File && fileEntry.name
      ? fileEntry.name
      : `pasted-${Date.now()}.png`;
  const mimeType = fileEntry.type || "application/octet-stream";

  try {
    const bytes = Buffer.from(await fileEntry.arrayBuffer());
    const result = await uploadToProjectCommentsFolder(
      session.user.email,
      project,
      fileName,
      mimeType,
      bytes,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
