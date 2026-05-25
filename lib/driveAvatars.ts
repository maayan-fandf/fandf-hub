/**
 * Team avatars sourced from a shared Drive folder ("profile images").
 *
 * Convention: one image per person, named by their email LOCAL-PART —
 * `maayan.png` ↔ maayan@fandf.co.il, `nadav.png` ↔ nadav@fandf.co.il,
 * etc. (case-insensitive; any image extension). A file whose stem
 * doesn't match a local-part is simply ignored, so AI drafts / oddly
 * named files in the folder don't break anything.
 *
 * This is the PRIMARY avatar source — `/api/avatar/<email>` tries here
 * first and only falls back to the Workspace profile photo
 * (lib/userAvatar.ts) when a person has no file in the folder.
 *
 * Two caches, both process-local (per server instance):
 *   - the folder listing (stem → {id,mimeType}), 1h TTL — the folder's
 *     contents change rarely; one Drive `files.list` per hour.
 *   - the image bytes per local-part, 24h TTL (1h negative) — one Drive
 *     download per person per day; the route also sets a 24h browser
 *     Cache-Control so each avatar costs at most one request/browser/day.
 *
 * Drive access uses DRIVE_FOLDER_OWNER impersonation (same as the other
 * Drive paths), so the folder only needs to be readable by that account.
 */

import { driveClient, driveFolderOwner } from "@/lib/sa";

const FOLDER_ID =
  process.env.AVATARS_FOLDER_ID || "1K1f9toK7kwL_t1sCDruEIbn9Wm4En27p";

const MAP_TTL_MS = 60 * 60 * 1000; // 1h — folder contents rarely change
const BYTES_TTL_MS = 24 * 60 * 60 * 1000; // 24h on hit
const NEG_TTL_MS = 60 * 60 * 1000; // 1h on miss (so a newly-added file shows up)

type FolderEntry = { id: string; mimeType: string };
let folderMap: { at: number; map: Map<string, FolderEntry> } | null = null;

/** List the avatars folder once → stem(lowercased, no extension) →
 *  {fileId, mimeType}. Cached for MAP_TTL_MS. On error keeps the prior
 *  (stale) map if there is one rather than blanking everyone's avatar. */
async function getFolderMap(): Promise<Map<string, FolderEntry>> {
  if (folderMap && folderMap.at + MAP_TTL_MS > Date.now()) return folderMap.map;
  const map = new Map<string, FolderEntry>();
  try {
    const drive = driveClient(driveFolderOwner());
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${FOLDER_ID}' in parents and trashed=false and mimeType contains 'image/'`,
        fields: "nextPageToken, files(id, name, mimeType)",
        pageSize: 200,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        spaces: "drive",
        pageToken,
      });
      for (const f of res.data.files ?? []) {
        const name = String(f.name ?? "");
        const id = String(f.id ?? "");
        if (!name || !id) continue;
        const stem = name
          .replace(/\.[a-z0-9]+$/i, "")
          .toLowerCase()
          .trim();
        // First write wins → stable if two files share a stem.
        if (stem && !map.has(stem)) {
          map.set(stem, { id, mimeType: String(f.mimeType ?? "image/png") });
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    folderMap = { at: Date.now(), map };
  } catch (e) {
    console.log(
      "[driveAvatars] folder list failed:",
      e instanceof Error ? e.message : e,
    );
    if (folderMap) return folderMap.map; // keep stale rather than blank
    folderMap = { at: Date.now(), map };
  }
  return folderMap.map;
}

type CachedBytes = {
  bytes: Buffer | null;
  contentType: string;
  expiresAt: number;
};
const bytesCache = new Map<string, CachedBytes>();

/**
 * Avatar bytes for `email` from the Drive folder, or null when the
 * person has no file there (caller falls back to the Workspace photo).
 * Never throws.
 */
export async function getDriveAvatar(
  email: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const local = email.toLowerCase().trim().split("@")[0];
  if (!local) return null;

  const cached = bytesCache.get(local);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.bytes
      ? { bytes: cached.bytes, contentType: cached.contentType }
      : null;
  }

  const map = await getFolderMap();
  const entry = map.get(local);
  if (!entry) {
    bytesCache.set(local, {
      bytes: null,
      contentType: "",
      expiresAt: Date.now() + NEG_TTL_MS,
    });
    return null;
  }

  try {
    const drive = driveClient(driveFolderOwner());
    const res = await drive.files.get(
      { fileId: entry.id, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" },
    );
    const bytes = Buffer.from(res.data as ArrayBuffer);
    const contentType =
      (res.headers?.["content-type"] as string | undefined) ||
      entry.mimeType ||
      "image/png";
    bytesCache.set(local, {
      bytes,
      contentType,
      expiresAt: Date.now() + BYTES_TTL_MS,
    });
    return { bytes, contentType };
  } catch (e) {
    console.log(
      "[driveAvatars] download failed for",
      local,
      e instanceof Error ? e.message : e,
    );
    bytesCache.set(local, {
      bytes: null,
      contentType: "",
      expiresAt: Date.now() + NEG_TTL_MS,
    });
    return null;
  }
}
