import { NextResponse } from "next/server";
import { getUserPhoto } from "@/lib/userAvatar";
import { getDriveAvatar } from "@/lib/driveAvatars";
import { requireViewer } from "@/lib/viewerGate";

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
 * Any hub viewer may load an avatar — clients see their team's faces in
 * the discussion and the roster — but not a Google account that is on no
 * roster: the libs only check the TARGET address, and they read the
 * Drive folder and the Workspace directory as the owner identity.
 * Cache-Control is `private` for the same reason: a shared cache would
 * hand the bytes to whoever asks next without coming back here. Each
 * unique avatar still costs at most one request per browser per day.
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
      "cache-control": "private, max-age=86400, stale-while-revalidate=604800",
    },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ email: string }> },
) {
  const gate = await requireViewer();
  if (gate instanceof NextResponse) return gate;

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
      "cache-control": "private, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
