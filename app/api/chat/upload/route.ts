import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  uploadChatAttachment,
  parseSpaceId,
} from "@/lib/chat";
import { readKeysCached } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Upload an attachment (image / file) into a project's Chat space's
 * media area. Two-step composer flow:
 *
 *   1. POST /api/chat/upload with FormData {project, file}
 *      → returns { resourceName, name, mimeType, isImage }
 *   2. POST /api/chat/post with body's `attachments[]` referring to
 *      the resourceName(s) returned above.
 *
 * Splitting upload from post lets the composer show local previews
 * + a "remove this attachment" affordance before the user clicks
 * send. Same UX pattern as our /api/comments/upload + comment
 * compose flow.
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

  // Resolve space ID from Keys col L (same lookup the post route
  // and InternalDiscussionTab use).
  let webhookUrl = "";
  try {
    const { headers, rows } = await readKeysCached(session.user.email);
    const iProj = headers.indexOf("פרוייקט");
    const iWebhook = headers.indexOf("Chat Webhook");
    if (iProj < 0 || iWebhook < 0) {
      return NextResponse.json(
        { ok: false, error: "Keys missing פרוייקט / Chat Webhook columns" },
        { status: 500 },
      );
    }
    const target = project.toLowerCase().trim();
    for (const row of rows) {
      if (String(row[iProj] ?? "").toLowerCase().trim() === target) {
        webhookUrl = String(row[iWebhook] ?? "").trim();
        break;
      }
    }
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "Keys lookup failed: " + (e instanceof Error ? e.message : String(e)),
      },
      { status: 500 },
    );
  }
  const spaceId = parseSpaceId(webhookUrl);
  if (!spaceId) {
    return NextResponse.json(
      { ok: false, error: "Project has no Chat space configured" },
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
    const ref = await uploadChatAttachment(
      session.user.email,
      spaceId,
      fileName,
      mimeType,
      bytes,
    );
    return NextResponse.json({
      ok: true,
      resourceName: ref.resourceName,
      name: fileName,
      mimeType,
      isImage: mimeType.startsWith("image/"),
    });
  } catch (e) {
    // Surface the full stack on the server console — the chip-side
    // error toast only gets the message, but the message has been
    // unhelpful for googleapis-internal failures (e.g. "Cannot read
    // properties of undefined (reading 'from')" coming out of the
    // media-upload multipart/related construction). Logging here
    // gives Firebase Cloud Logging the full trace next time.
    console.error("[chat/upload] failed", {
      project,
      fileName,
      mimeType,
      bytes: fileEntry.size,
      error: e instanceof Error ? { message: e.message, stack: e.stack } : String(e),
    });
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
