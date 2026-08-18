import { NextResponse } from "next/server";
import { driveClient, driveFolderOwner } from "@/lib/sa";
import {
  getPrisaApprovalRequest,
  isAwaitingApproval,
  verifyPrisaApprovalToken,
} from "@/lib/prisaApprovalTokens";

/**
 * Token-scoped file-bytes proxy for the login-free approve page.
 *
 * PUBLIC (exempted in middleware.ts) — which is exactly why it takes a
 * TOKEN in the path rather than a fileId. /api/drive/image/<fileId> is
 * session-gated; making that public would turn any known Drive id into a
 * world-readable asset. Here the token names the one file it unlocks, so
 * the blast radius is the single plan those recipients were already sent.
 *
 * Streams image/*, application/pdf, and the two Excel spreadsheet types
 * (uploaded .xlsx/.xls plans are an accepted פריסה format, and refusing
 * them left the client with nothing to look at). Native Google Sheets
 * are rendered as an HTML table by the page itself (readPrisotData), so
 * they never reach this route; anything else gets a 415 and the page
 * shows an explicit "couldn't display this" note rather than a broken
 * image over a live approve button.
 */
export const dynamic = "force-dynamic";

/** Mime types we're willing to stream. Excel can't render inline, but the
 *  page links to it so the client can open it in their own spreadsheet
 *  app before signing off. */
const STREAMABLE = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

/** Same soft cap as /api/drive/image — a plan is a spread, not a RAW. */
const MAX_BYTES = 25 * 1024 * 1024;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token: tokenRaw } = await params;
  const verified = verifyPrisaApprovalToken(decodeURIComponent(tokenRaw || ""));
  if (!verified.ok) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  // The request must still be live — an expired or already-resolved plan
  // shouldn't keep serving its bytes to an old link.
  const request = await getPrisaApprovalRequest(verified.fileId);
  if (!isAwaitingApproval(request) && request?.resolution !== "approved") {
    return new NextResponse("Gone", { status: 410 });
  }

  const fileId = verified.fileId;
  try {
    const drive = driveClient(driveFolderOwner());
    const meta = await drive.files.get({
      fileId,
      fields: "mimeType, size",
      supportsAllDrives: true,
    });
    const mime = meta.data.mimeType || "";
    if (!mime.startsWith("image/") && !STREAMABLE.has(mime)) {
      return new NextResponse("No inline preview for this file type", {
        status: 415,
      });
    }
    const size = parseInt(String(meta.data.size || "0"), 10);
    if (Number.isFinite(size) && size > MAX_BYTES) {
      return new NextResponse("File too large for inline render", {
        status: 413,
      });
    }
    if (Number.isFinite(size) && size === 0) {
      return new NextResponse("Empty file", { status: 404 });
    }
    const file = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    return new NextResponse(file.data as unknown as ArrayBuffer, {
      status: 200,
      headers: {
        "content-type": mime,
        // private: this is a per-recipient capability URL, never a CDN
        // asset. Short TTL so a resolved request stops rendering soon.
        "cache-control": "private, max-age=300",
      },
    });
  } catch (e) {
    console.warn(
      `[/api/prisot/preview] failed for fileId=${fileId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return new NextResponse("Error", { status: 500 });
  }
}
