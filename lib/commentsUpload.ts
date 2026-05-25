/**
 * Upload arbitrary file bytes into a project's comment-attachments
 * folder. The destination depends on the comment's AUDIENCE:
 *
 *   shared (client tab) → <Shared Drive>/<company>/<project>/שיתוף עם הלקוח/
 *   internal (F&F tab)  → <Shared Drive>/<company>/<project>/קבצים פנימיים (צוות בלבד)/
 *
 * Both subfolder names are deliberately role-explicit so an admin
 * browsing Drive can tell at a glance who can see a file. Since the
 * Google Chat migration, internal-tab chatter lives in the hub (not a
 * Chat space), so internal attachments must NOT land in the client
 * bucket — they go to a clearly-internal sibling folder instead
 * (2026-05-25). The route resolves the audience from the parent
 * comment's scope.
 *
 * The subfolder is lazy-created the first time someone attaches a file
 * on that tab. Global-per-project (no per-comment subfolder) — comments
 * are short-lived chat-style notes; splitting by comment id would just
 * clutter Drive.
 *
 * Drive impersonation uses DRIVE_FOLDER_OWNER (same as the tasks
 * upload path), so the folder + uploaded file are owned by the team
 * account regardless of who clicked "upload" in the hub.
 */

import { Readable } from "node:stream";
import type { drive_v3 } from "googleapis";
import { driveClient, driveFolderOwner } from "@/lib/sa";
import { ensureCampaignFolderId } from "@/lib/driveFolders";
import { readKeysCached } from "@/lib/keys";

export type CommentUploadResult = {
  fileId: string;
  name: string;
  mimeType: string;
  viewUrl: string;
  embedUrl: string;
};

/** Client-visible attachments bucket (shared / client tab). */
const COMMENTS_SUBFOLDER_NAME = "שיתוף עם הלקוח";
/** Internal-only attachments bucket (F&F tab) — NOT shared with the
 *  client. Sibling of the client bucket under the project folder; the
 *  project root lives in an internal-only Shared Drive, and (unlike the
 *  `<project> תיקיה משותפת` folder) this one is never granted client
 *  permissions. */
const INTERNAL_SUBFOLDER_NAME = "קבצים פנימיים (צוות בלבד)";

// In-process cache: project name → comments-attachments folder id.
// Drive lookups are slow; the folder name never moves once created.
// Keyed on lowercase project name. 1h TTL is conservative — folders
// don't get renamed via the hub; an admin renaming via Drive UI takes
// effect on next server restart or after the entry expires.
const COMMENTS_FOLDER_CACHE = new Map<
  string,
  { id: string; expiresAt: number }
>();
const COMMENTS_FOLDER_TTL_MS = 60 * 60 * 1000;

// In-flight folder-ensure promises, keyed identically to the cache.
// THE DUPLICATE-FOLDER FIX: dropping N files at once fires N concurrent
// uploads. Without this lock each one misses the cache, LISTs (finding
// nothing yet), and CREATEs — producing N identical folders. Sharing a
// single promise per key collapses the burst onto ONE create; the rest
// await it and reuse the same id. The sync path below (cache-check →
// inflight-check → set) has no `await` between the check and the set, so
// a concurrent caller is guaranteed to observe the in-flight entry.
const COMMENTS_FOLDER_INFLIGHT = new Map<string, Promise<string>>();

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function ensureCommentsSubfolder(
  drive: drive_v3.Drive,
  parentFolderId: string,
  project: string,
  subfolderName: string,
): Promise<string> {
  const cacheKey = `${project.toLowerCase().trim()}|${subfolderName}`;
  const cached = COMMENTS_FOLDER_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  // Collapse a concurrent burst (multi-file drop) onto one create.
  const inflight = COMMENTS_FOLDER_INFLIGHT.get(cacheKey);
  if (inflight) return inflight;

  const run = (async (): Promise<string> => {
    // Look up an existing attachments subfolder first. orderBy
    // createdTime (ascending) so that if duplicates already exist —
    // e.g. from before this fix, or a cross-instance race that the
    // per-process lock can't cover — every caller deterministically
    // converges on the OLDEST folder and piles new files there rather
    // than minting yet another dupe.
    const listed = await drive.files.list({
      q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${escapeDriveQuery(subfolderName)}' and trashed=false`,
      fields: "files(id, name)",
      orderBy: "createdTime",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      spaces: "drive",
      pageSize: 1,
    });
    let folderId = listed.data.files?.[0]?.id || "";
    if (!folderId) {
      const created = await drive.files.create({
        requestBody: {
          name: subfolderName,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentFolderId],
        },
        fields: "id",
        supportsAllDrives: true,
      });
      folderId = created.data.id || "";
    }
    if (!folderId) {
      throw new Error("Could not ensure comments attachments subfolder");
    }
    COMMENTS_FOLDER_CACHE.set(cacheKey, {
      id: folderId,
      expiresAt: Date.now() + COMMENTS_FOLDER_TTL_MS,
    });
    return folderId;
  })();

  COMMENTS_FOLDER_INFLIGHT.set(cacheKey, run);
  try {
    return await run;
  } finally {
    // Always clear so a failed ensure can be retried (and so the map
    // doesn't grow unbounded). Success is preserved in the cache above.
    COMMENTS_FOLDER_INFLIGHT.delete(cacheKey);
  }
}

/**
 * Resolves the company associated with a project name from the cached
 * Keys read. Throws if the project isn't on the Keys tab — the only
 * non-malicious way to hit that is a stale URL referencing a deleted
 * project, which is rare enough that a friendly error is enough.
 */
async function lookupCompanyForProject(
  subjectEmail: string,
  project: string,
): Promise<string> {
  const { headers, rows } = await readKeysCached(subjectEmail);
  const iProj = headers.indexOf("פרוייקט");
  const iCo = headers.indexOf("חברה");
  if (iProj < 0 || iCo < 0) {
    throw new Error("Keys tab is missing פרוייקט / חברה headers");
  }
  const target = project.trim();
  for (const row of rows) {
    if (String(row[iProj] ?? "").trim() === target) {
      const company = String(row[iCo] ?? "").trim();
      if (!company) {
        throw new Error(`Project "${project}" is missing a חברה in Keys`);
      }
      return company;
    }
  }
  throw new Error(`Project not found: ${project}`);
}

export async function uploadToProjectCommentsFolder(
  subjectEmail: string,
  project: string,
  fileName: string,
  mimeType: string,
  bytes: Buffer,
  /** When true, store under the internal (team-only) bucket instead of
   *  the client-share bucket. Resolved from the parent comment's scope
   *  at the route. Defaults false (client bucket) for back-compat. */
  internal = false,
): Promise<CommentUploadResult> {
  const company = await lookupCompanyForProject(subjectEmail, project);
  // Use ensureCampaignFolderId (campaign="") so the company + project
  // folders get created if they don't exist yet — this is the first
  // path that touches a project's Drive tree from outside the tasks
  // pipeline, so we can't rely on tasks having materialized them.
  const projectFolder = await ensureCampaignFolderId(
    driveFolderOwner() || subjectEmail,
    { company, project, campaign: "" },
  );
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  const commentsFolderId = await ensureCommentsSubfolder(
    drive,
    projectFolder.folderId,
    project,
    internal ? INTERNAL_SUBFOLDER_NAME : COMMENTS_SUBFOLDER_NAME,
  );
  const created = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [commentsFolderId],
    },
    media: {
      mimeType,
      body: Readable.from(bytes),
    },
    fields: "id, webViewLink, mimeType",
    supportsAllDrives: true,
  });
  const fileId = created.data.id;
  if (!fileId) throw new Error("Drive file create returned no id");
  return {
    fileId,
    name: fileName,
    mimeType: created.data.mimeType || mimeType,
    viewUrl:
      created.data.webViewLink ||
      `https://drive.google.com/file/d/${fileId}/view`,
    embedUrl: `https://lh3.googleusercontent.com/d/${fileId}=w1600`,
  };
}
