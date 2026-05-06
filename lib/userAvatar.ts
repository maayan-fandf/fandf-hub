/**
 * Resolve a Workspace user's profile photo bytes via the Admin SDK
 * Directory API (`users.photos.get`). Returns the raw image bytes +
 * mime type, or `null` if the user has no photo / isn't in the F&F
 * domain / the call fails.
 *
 * `users.photos.get` is the canonical way to fetch a Workspace user's
 * avatar — `thumbnailPhotoUrl` from `users.get` points at an OAuth-
 * gated googleusercontent URL that browsers can't load directly. The
 * photos endpoint streams the bytes back to us under SA auth.
 *
 * Scope used: `auth/admin.directory.user.readonly` — already wired
 * into `directoryClient()` (sa.ts:225) and granted in DWD on prior
 * work for the chat displayName lookups.
 *
 * Caching: process-local Map. 24h TTL on hits, 1h negative TTL on
 * misses (so a user who later sets a photo eventually gets picked
 * up). The bytes themselves are small (≈few KB per user); even a
 * full-domain warmup is on the order of <1MB resident.
 */

import { directoryClient, driveFolderOwner } from "@/lib/sa";

const TTL_MS = 24 * 60 * 60 * 1000;
const NEG_TTL_MS = 60 * 60 * 1000;

type CachedPhoto = {
  bytes: Buffer | null;
  contentType: string;
  expiresAt: number;
};

const cache = new Map<string, CachedPhoto>();

function isFandfEmail(email: string): boolean {
  return /^[^\s@]+@fandf\.co\.il$/i.test(email.trim());
}

export async function getUserPhoto(
  email: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const key = email.toLowerCase().trim();
  if (!key || !isFandfEmail(key)) return null;

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.bytes) return null;
    return { bytes: cached.bytes, contentType: cached.contentType };
  }

  try {
    const directory = directoryClient(driveFolderOwner());
    const res = await directory.users.photos.get({ userKey: key });
    const photoData = res.data.photoData;
    const mimeType = res.data.mimeType || "image/jpeg";
    if (!photoData) {
      cache.set(key, {
        bytes: null,
        contentType: "",
        expiresAt: Date.now() + TTL_MS,
      });
      return null;
    }
    // Directory API returns photoData as URL-safe base64 (RFC 4648).
    const b64 = photoData.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Buffer.from(b64, "base64");
    cache.set(key, {
      bytes,
      contentType: mimeType,
      expiresAt: Date.now() + TTL_MS,
    });
    return { bytes, contentType: mimeType };
  } catch (e) {
    const code =
      (e as { code?: number; response?: { status?: number } }).code ??
      (e as { response?: { status?: number } }).response?.status;
    if (code === 404) {
      // User exists in the directory but has no profile photo.
      cache.set(key, {
        bytes: null,
        contentType: "",
        expiresAt: Date.now() + TTL_MS,
      });
    } else {
      console.log(
        "[userAvatar] photos.get failed for",
        email,
        "code=" + code + ":",
        e instanceof Error ? e.message : e,
      );
      cache.set(key, {
        bytes: null,
        contentType: "",
        expiresAt: Date.now() + NEG_TTL_MS,
      });
    }
    return null;
  }
}
