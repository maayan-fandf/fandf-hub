import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { driveClient, driveFolderOwner } from "@/lib/sa";

/**
 * Proxy a Drive image file's actual bytes through the hub server. Used
 * by LatestPrisotCard when the latest פריסה file is an image (jpeg /
 * png / gif / webp / heic) — we want the user to see the real file at
 * full fidelity, not the small Drive-generated thumbnail.
 *
 * The SA-side read happens under DRIVE_FOLDER_OWNER's identity (DWD),
 * so external clients (whose browser has no F&F Google session) can
 * still see the image. Refuses non-image mime types (we don't want
 * this endpoint accidentally streaming a Doc or PDF).
 *
 * Cache: 5 minutes browser-side, same as the thumb proxy. Image files
 * inside פריסות don't typically change in place (a new spread = a new
 * file with a new ID), so this is conservative but safe.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const { fileId: fileIdRaw } = await params;
  const fileId = decodeURIComponent(fileIdRaw);
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(fileId)) {
    return new NextResponse("Bad file id", { status: 400 });
  }

  try {
    const drive = driveClient(driveFolderOwner() || session.user.email);
    // Refuse anything that isn't an image up-front so we never stream
    // a 50MB PDF / Sheet / video through the hub.
    const meta = await drive.files.get({
      fileId,
      fields: "mimeType, name, size",
      supportsAllDrives: true,
    });
    const mime = meta.data.mimeType || "";
    if (!mime.startsWith("image/")) {
      return new NextResponse("Not an image", { status: 400 });
    }
    // Soft cap on file size — 25 MB. Prevents accidentally serving
    // a giant raw camera RAW that someone dropped into the folder.
    const sizeRaw = parseInt(String(meta.data.size || "0"), 10);
    if (Number.isFinite(sizeRaw) && sizeRaw > 25 * 1024 * 1024) {
      console.warn(
        `[/api/drive/image] refusing oversize file ${fileId}: ${sizeRaw} bytes`,
      );
      return new NextResponse("File too large for inline render", {
        status: 413,
      });
    }
    // Stream the actual file content. responseType=arraybuffer lets us
    // hand the bytes straight to NextResponse without a chunked-stream
    // dance — fine for ≤25MB images.
    const file = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    const body = file.data as unknown as ArrayBuffer;
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": mime,
        "cache-control": "private, max-age=300",
      },
    });
  } catch (e) {
    const code =
      (e as { code?: number; response?: { status?: number } }).code ??
      (e as { response?: { status?: number } }).response?.status;
    console.warn(
      `[/api/drive/image] failed for fileId=${fileId} code=${code}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return new NextResponse("Error", { status: 500 });
  }
}
