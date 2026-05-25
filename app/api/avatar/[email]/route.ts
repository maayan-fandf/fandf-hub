import { NextResponse } from "next/server";
import { getUserPhoto } from "@/lib/userAvatar";
import { getDriveAvatar } from "@/lib/driveAvatars";

/**
 * Proxy a team member's avatar bytes through the hub. The Avatar
 * component (`components/Avatar.tsx`) loads this URL as an `<img>`
 * overlay — when there's a photo it shows over the initials, otherwise
 * the response is a transparent 1×1 GIF and the initials underneath
 * remain visible.
 *
 * Source priority:
 *   1. the shared "profile images" Drive folder (lib/driveAvatars) —
 *      the curated team avatars, keyed by email local-part;
 *   2. the user's Workspace profile photo (lib/userAvatar) as a
 *      fallback for anyone without a file in the folder.
 *
 * No auth gate here on purpose: the response only contains bytes
 * already destined for someone's avatar circle, the libs gate by
 * `@fandf.co.il` domain / folder membership, and Cache-Control means
 * each unique avatar costs at most one request per browser per day.
 */
export const dynamic = "force-dynamic";

// 1×1 fully-transparent GIF. Used as the "no photo" fallback so the
// `<img>` tag in <Avatar> always loads cleanly — the underlying
// initials show through the transparent image.
const TRANSPARENT_GIF = new Uint8Array(
  Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  ),
);

function transparentResponse(): NextResponse {
  return new NextResponse(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      "content-type": "image/gif",
      // 24h browser cache, 7d SWR — we don't expect users to change
      // their Workspace photo more than once a day. The lib's
      // process-local cache covers the server-side TTL.
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ email: string }> },
) {
  const { email: raw } = await params;
  const email = decodeURIComponent(raw || "").toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return transparentResponse();
  }

  // Curated Drive-folder avatar first; Workspace profile photo as the
  // fallback for anyone without a file in the folder.
  const photo = (await getDriveAvatar(email)) || (await getUserPhoto(email));
  if (!photo) return transparentResponse();

  return new NextResponse(new Uint8Array(photo.bytes), {
    status: 200,
    headers: {
      "content-type": photo.contentType,
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
