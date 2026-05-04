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

  // Optional ?sz= override; defaults to a wide thumbnail that's
  // readable at typical card sizes (1600px-wide). Drive's documented
  // thumbnail endpoint accepts `sz=w<N>` for width-bound rendering;
  // the range it actually serves is roughly 200–2000px. Anything
  // outside that range gets clamped server-side.
  const url = new URL(_req.url);
  const szRaw = url.searchParams.get("sz") || "w1600";
  const sz = /^w\d{2,4}$/.test(szRaw) ? szRaw : "w1600";

  try {
    const drive = driveClient(driveFolderOwner() || session.user.email);
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

    // Drive's documented thumbnail endpoint — `sz=w<N>` returns a
    // <N>-pixel-wide rendering. Much larger + readable than the default
    // ~220px thumbnailLink. Auth via Bearer token works for any user
    // who has Drive read on the file (DRIVE_FOLDER_OWNER does).
    const upstreamUrl = `https://drive.google.com/thumbnail?id=${encodeURIComponent(
      fileId,
    )}&sz=${sz}`;
    const upstream = await fetch(upstreamUrl, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!upstream.ok) {
      return new NextResponse(`Upstream ${upstream.status}`, {
        status: 502,
      });
    }
    const buf = await upstream.arrayBuffer();
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "content-type":
          upstream.headers.get("content-type") || "image/jpeg",
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
