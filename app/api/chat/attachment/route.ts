import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { chatClient } from "@/lib/sa";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proxy a Chat attachment through the hub so the browser can render
 * images posted in project Chat spaces without depending on the
 * viewer's Workspace cookie state.
 *
 * Why this exists: `attachment.thumbnailUri` from
 * spaces.messages.list is googleusercontent-hosted and only loads in
 * a browser that's signed into a Google account with explicit access
 * to the Chat space. From hub.fandf.co.il's origin we have no
 * googleusercontent cookies, so every <img> tag pointing at the
 * thumbnailUri returns a broken image. Reported by maayan
 * 2026-05-11 — first photo posted in chat showed a broken-image icon
 * next to the filename.
 *
 * This route accepts the attachment's download `resourceName` (from
 * `attachment.attachmentDataRef.resourceName` — distinct from the
 * upload-time resourceName / attachmentUploadToken) and streams the
 * bytes back via `chat.media.download` running under DWD impersonation.
 * Bytes are served at hub origin so the browser loads them with the
 * user's hub session cookie. No CORS or third-party-cookie issues.
 *
 * Query shape: ?r=<resourceName>. The resourceName is opaque (e.g.,
 * "AATTaIB...") so a query string is the most ergonomic format for an
 * img src — easier than path-encoding the whole opaque string.
 *
 * Security: the hub session gates access — only authenticated users
 * can hit the proxy. The SA-side download runs as the hub deployer
 * identity which is a member of every project space, so we don't
 * further validate per-space membership here. The resourceName is
 * unguessable in practice (long opaque token); the page only surfaces
 * it for attachments the user can already see in their chat feed.
 */
export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const url = new URL(req.url);
  const resourceName = (url.searchParams.get("r") || "").trim();
  if (!resourceName) {
    return new NextResponse("Missing ?r=", { status: 400 });
  }

  try {
    const chat = chatClient(email);
    /* eslint-disable @typescript-eslint/no-explicit-any */
    // `alt: "media"` is REQUIRED — without it Chat returns 400
    // INVALID_ARGUMENT: "Invalid value for query parameter 'alt'.
    // It must be set to \"media\"." The SDK's responseType:"stream"
    // hint doesn't translate into this query param automatically
    // for this endpoint, so we set it explicitly on the params.
    // Confirmed via the diagnostic-error response 2026-05-11.
    const res = await (chat.media as any).download(
      { resourceName, alt: "media" },
      { responseType: "stream" },
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const stream = res.data as Readable;
    const contentType =
      (res.headers?.["content-type"] as string) || "application/octet-stream";
    // Convert Node Readable to a Web ReadableStream so NextResponse
    // can pass it to the fetch response body.
    const webStream = Readable.toWeb(stream) as unknown as ReadableStream;
    return new NextResponse(webStream, {
      status: 200,
      headers: {
        "content-type": contentType,
        // Cache aggressively at the edge — Chat attachments are
        // immutable once posted. 1 day in the browser; the hub
        // session gate runs each time so revocation comes from
        // session expiry, not cache-control.
        "cache-control": "private, max-age=86400",
      },
    });
  } catch (e) {
    const code =
      (e as { code?: number; response?: { status?: number } }).code ??
      (e as { response?: { status?: number } }).response?.status;
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[chat/attachment] download failed (${code}) for ${resourceName.slice(0, 60)}: ${msg}`,
    );
    // Surface the actual error message in the response body so we
    // can diagnose without log access — content-type=text/plain so
    // it doesn't try to render as an image.
    return new NextResponse(
      `Chat attachment fetch failed (${code || 500}): ${msg.slice(0, 400)}`,
      {
        status: code || 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  }
}
