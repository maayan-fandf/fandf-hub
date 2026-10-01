import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { uploadToProjectCommentsFolder } from "@/lib/commentsUpload";
import { canOpenProject } from "@/lib/projectAccess";
import { viewerTier } from "@/lib/viewerTier";

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

  // The file is written as the owner identity (lib/commentsUpload), which
  // can write to every project's folder — so the caller's own right to this
  // project has to be checked here. Clients do upload, to their own project.
  const email = session.user.email;
  if (!(await canOpenProject(email, project))) {
    return NextResponse.json(
      { ok: false, error: "Forbidden" },
      { status: 403 },
    );
  }

  // Audience routing: an attachment on an INTERNAL (F&F-only) comment must
  // NOT land in the client-share folder. Resolve from the parent comment's
  // scope (replies inherit their root's scope), with an explicit `internal`
  // form field as an override for non-reply callers. Default shared.
  const parentCommentId = String(form.get("parentCommentId") || "").trim();
  const explicitInternal = /^(1|true|internal)$/i.test(
    String(form.get("internal") || "").trim(),
  );
  let internal = explicitInternal;
  if (!internal && parentCommentId) {
    try {
      const { getCommentScopeById } = await import("@/lib/commentsDirect");
      internal =
        (await getCommentScopeById(email, parentCommentId)) === "internal";
    } catch {
      internal = false; // unknown → client bucket (current behavior)
    }
  }
  // The team-only bucket is not a client's to write into, whatever the form
  // says. Staff and the Keys-listed freelancers keep it: their task
  // attachments are sent with internal=1 and must not land in the client's
  // folder.
  if (internal && (await viewerTier(email)) === "client") internal = false;
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
      email,
      project,
      fileName,
      mimeType,
      bytes,
      internal,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
