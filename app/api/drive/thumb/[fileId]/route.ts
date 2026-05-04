import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { driveClient, driveFolderOwner } from "@/lib/sa";

/**
 * Proxy a Drive file's thumbnail through the hub server so external
 * clients (whose browser has no F&F Google session) can still see the
 * preview image. We fetch via DWD-impersonated drive.files.get with
 * `alt=media` on the thumbnailLink isn't a thing — instead we hit the
 * thumbnailLink URL with the SA's bearer token attached.
 *
 * Used by LatestPrisotCard (project overview page) to show the latest
 * פריסה file's preview image. Returns the binary thumbnail body or 404
 * if the file has none / access denied.
 *
 * Security: the user must be authenticated to the hub; the SA-side
 * Drive read happens under DRIVE_FOLDER_OWNER's identity (which has
 * shared-drive access), so we deliberately don't validate that the
 * caller has access to this specific file. The file ID is treated as
 * non-sensitive since the caller would only have it because the page
 * already resolved it from a project they can see.
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

  // Optional ?sz= override; defaults to a width that's readable at
  // typical card sizes. The number we put on the thumbnailLink suffix
  // is the requested pixel size — Drive's googleusercontent CDN treats
  // this as a hint and serves something close to that within its own
  // bounds (~2000px max).
  const url = new URL(_req.url);
  const szRaw = parseInt(url.searchParams.get("sz") || "1600", 10);
  const targetSize =
    Number.isFinite(szRaw) && szRaw >= 200 && szRaw <= 2000 ? szRaw : 1600;

  try {
    const drive = driveClient(driveFolderOwner() || session.user.email);
    // First step: read the file's thumbnailLink. Drive returns a URL
    // pointing at googleusercontent with a size suffix (=s220, =w220,
    // =w220-h220, etc.) — defaults to a small thumbnail. Rewriting the
    // suffix lets us request a larger rendering without needing a
    // separate Drive endpoint.
    const meta = await drive.files.get({
      fileId,
      fields: "thumbnailLink",
      supportsAllDrives: true,
    });
    let link = meta.data.thumbnailLink || "";
    if (!link) return new NextResponse("No thumbnail", { status: 404 });
    // Drive returns thumbnailLink in two shapes depending on file type:
    //   • Path-suffix form (used by Docs etc.):
    //       https://lh3.googleusercontent.com/.../=s220
    //       https://lh3.googleusercontent.com/.../=w220-h220
    //   • Query-param form (used by Sheets):
    //       https://docs.google.com/feeds/vt?...&sz=s220
    // Rewrite both to request our target size.
    const sz = `s${targetSize}`;
    const wsz = `w${targetSize}`;
    // Query-param form first since it's the Sheets-typical shape.
    if (/[?&]sz=[ws]\d+(-[a-z]+)?(?=[&]|$)/.test(link)) {
      link = link.replace(/([?&]sz=)[ws]\d+(-[a-z]+)?(?=[&]|$)/, `$1${sz}`);
    } else if (/=w\d+-h\d+(-[a-z]+)?$/.test(link)) {
      link = link.replace(/=w\d+-h\d+(-[a-z]+)?$/, `=${wsz}`);
    } else if (/=w\d+(-[a-z]+)?$/.test(link)) {
      link = link.replace(/=w\d+(-[a-z]+)?$/, `=${wsz}`);
    } else if (/=s\d+(-[a-z]+)?$/.test(link)) {
      link = link.replace(/=s\d+(-[a-z]+)?$/, `=${sz}`);
    }

    // Pull the access token off the underlying JWT auth so we can
    // forward it. googleapis lazily refreshes the token; calling
    // getAccessToken() ensures it's fresh.
    const auth2 = drive.context._options.auth as
      | { getAccessToken: () => Promise<{ token?: string | null }> }
      | undefined;
    const tokenResp = await auth2?.getAccessToken?.();
    const token = tokenResp?.token;
    if (!token) {
      return new NextResponse("No token", { status: 502 });
    }
    const upstream = await fetch(link, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "follow",
    });
    if (!upstream.ok) {
      console.warn(
        `[/api/drive/thumb] upstream ${upstream.status} for ${fileId} (size=${targetSize})`,
      );
      return new NextResponse(`Upstream ${upstream.status}`, {
        status: 502,
      });
    }
    // Defensive content-type check — googleusercontent occasionally
    // returns an HTML error page with 200 OK when it can't render the
    // thumbnail (e.g. just-created sheets). Returning that as the
    // response body to an <img> tag breaks the page rendering with
    // garbage; fail cleanly instead.
    const ct = upstream.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) {
      console.warn(
        `[/api/drive/thumb] non-image content-type for ${fileId}: ${ct}`,
      );
      return new NextResponse("Not an image", { status: 404 });
    }
    const buf = await upstream.arrayBuffer();
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "content-type": ct,
        // 5-minute browser cache — the underlying file changes when the
        // user updates the sheet, but a 5-min stale image on the
        // overview is fine; clicking through opens the live sheet.
        "cache-control": "private, max-age=300",
      },
    });
  } catch (e) {
    console.warn("[/api/drive/thumb] failed:", e);
    return new NextResponse("Error", { status: 500 });
  }
}
