import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { driveClient, driveFolderOwner } from "@/lib/sa";
import { getTasksSharedDriveId } from "@/lib/driveFolders";

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
 * Security: clients are intended callers (the plan card on their project
 * page), so this is not a staff/team route; `auth()` keeps out accounts
 * on no roster. The read happens under DRIVE_FOLDER_OWNER's identity, so
 * the route refuses any file outside the tasks Shared Drive — every plan
 * the card and the budget desk show lives there, and without it this was
 * a preview of anything the owner can open. STILL OPEN (authorization
 * audit, 2026-10-01): the file id is not checked against the projects the
 * caller may open. It used to be "non-sensitive because the page resolved
 * it"; a client who learns another project's file id still gets its
 * preview.
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
    const meta = await drive.files.get({
      fileId,
      fields: "thumbnailLink, driveId",
      supportsAllDrives: true,
    });
    if (meta.data.driveId !== getTasksSharedDriveId()) {
      return new NextResponse("Forbidden", { status: 403 });
    }
    const link = meta.data.thumbnailLink || "";
    if (!link) return new NextResponse("No thumbnail", { status: 404 });

    // Pull a fresh access token off the underlying JWT auth.
    const auth2 = drive.context._options.auth as
      | { getAccessToken: () => Promise<{ token?: string | null }> }
      | undefined;
    const tokenResp = await auth2?.getAccessToken?.();
    const token = tokenResp?.token;
    if (!token) {
      return new NextResponse("No token", { status: 502 });
    }

    // Build a fallback chain of candidate URLs. Drive's thumbnail
    // serving differs by file type (Docs go through googleusercontent
    // and accept arbitrary size, Sheets go through a separate
    // docs.google.com/feeds/vt endpoint that hard-caps at ~220px),
    // and individual files occasionally have stale/missing thumbnails.
    // We try big-then-small variants, taking the first that returns
    // an actual image. Always-original is the last resort so we never
    // 404 when there's a working thumbnail at SOME size.
    const candidates = buildCandidates(link, targetSize);
    for (const url of candidates) {
      const r = await tryFetchImage(url, token);
      if (r) {
        return new NextResponse(r.body, {
          status: 200,
          headers: {
            "content-type": r.contentType,
            // 5-minute browser cache — the underlying file changes
            // when the user updates the sheet, but a 5-min stale
            // image on the overview is fine; clicking through opens
            // the live sheet.
            "cache-control": "private, max-age=300",
          },
        });
      }
    }
    console.warn(
      `[/api/drive/thumb] all candidates failed for ${fileId} (size=${targetSize})`,
    );
    return new NextResponse("No image", { status: 404 });
  } catch (e) {
    console.warn("[/api/drive/thumb] failed:", e);
    return new NextResponse("Error", { status: 500 });
  }
}

/** Returns image body + content-type when the upstream URL responds with
 *  an image, otherwise null. Caller iterates a candidate list. */
async function tryFetchImage(
  url: string,
  token: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return null;
    const body = await res.arrayBuffer();
    if (body.byteLength === 0) return null;
    return { body, contentType: ct };
  } catch {
    return null;
  }
}

/** Generate ordered candidate URLs from a Drive thumbnailLink. The
 *  first variant requests the user's target size; subsequent variants
 *  step down to safer fallbacks ending with the unmodified original. */
function buildCandidates(link: string, targetSize: number): string[] {
  const out: string[] = [];
  const sz = `s${targetSize}`;
  const wsz = `w${targetSize}`;
  // Query-param form (Sheets):  ?...&sz=s220
  if (/[?&]sz=[ws]\d+(-[a-z]+)?(?=[&]|$)/.test(link)) {
    out.push(
      link.replace(/([?&]sz=)[ws]\d+(-[a-z]+)?(?=[&]|$)/, `$1${sz}`),
    );
  }
  // Path-suffix forms (googleusercontent):
  if (/=w\d+-h\d+(-[a-z]+)?$/.test(link)) {
    out.push(link.replace(/=w\d+-h\d+(-[a-z]+)?$/, `=${wsz}`));
  } else if (/=w\d+(-[a-z]+)?$/.test(link)) {
    out.push(link.replace(/=w\d+(-[a-z]+)?$/, `=${wsz}`));
  } else if (/=s\d+(-[a-z]+)?$/.test(link)) {
    out.push(link.replace(/=s\d+(-[a-z]+)?$/, `=${sz}`));
  }
  // Always include the unmodified link as the last-resort fallback.
  // This is the variant Drive itself serves to its UI, so it's the
  // most likely to return a real image even if the resize request
  // gets refused (Sheets-feeds-vt rejects sizes outside its narrow
  // accepted range).
  if (!out.includes(link)) out.push(link);
  return out;
}
