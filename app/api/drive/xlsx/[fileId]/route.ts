import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { driveClient, driveFolderOwner } from "@/lib/sa";

/**
 * Export a Google Sheet as .xlsx and stream it through the hub as a
 * download. Backs the "הורד XLS" button on LatestPrisotCard.
 *
 * Proxied (not a raw docs.google.com/export link) for the same reason
 * the image/thumb proxies exist: the read happens under
 * DRIVE_FOLDER_OWNER's identity via DWD, so an external client whose
 * browser has NO F&F Google session — or who is signed into a personal
 * Google account — still gets the file instead of a Google
 * "request access" wall.
 *
 * Refuses anything that isn't a Google Sheet: files.export only works on
 * Workspace-native types, and this endpoint must never become a generic
 * "stream any Drive file" hole. Not cached — a פריסה is edited in place,
 * so a download must always reflect the live sheet.
 */
export const dynamic = "force-dynamic";

const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
    const meta = await drive.files.get({
      fileId,
      fields: "mimeType, name",
      supportsAllDrives: true,
    });
    if ((meta.data.mimeType || "") !== SHEET_MIME) {
      return new NextResponse("Not a Google Sheet", { status: 400 });
    }
    const file = await drive.files.export(
      { fileId, mimeType: XLSX_MIME },
      { responseType: "arraybuffer" },
    );
    const body = file.data as unknown as ArrayBuffer;

    // Filename: Hebrew plan names are the norm, so send BOTH a stripped
    // ASCII `filename` (for legacy clients) and the RFC-5987 `filename*`
    // that real browsers prefer. Quotes/backslashes/CR/LF are removed so
    // they can't break out of the header.
    const base = (meta.data.name || "prisa").replace(/[\\"\r\n]/g, "").trim();
    const name = base.toLowerCase().endsWith(".xlsx") ? base : `${base}.xlsx`;
    const asciiName =
      name.replace(/[^\x20-\x7E]/g, "_").replace(/\s+/g, " ").trim() ||
      "prisa.xlsx";
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": XLSX_MIME,
        "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    const code =
      (e as { code?: number; response?: { status?: number } }).code ??
      (e as { response?: { status?: number } }).response?.status;
    console.warn(
      `[/api/drive/xlsx] failed for fileId=${fileId} code=${code}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return new NextResponse("Error", { status: 500 });
  }
}
