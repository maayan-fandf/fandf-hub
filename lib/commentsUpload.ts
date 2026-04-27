/**
 * Upload arbitrary file bytes into a project's comment-attachments
 * folder.
 *
 * Folder hierarchy:
 *     <Shared Drive>/<company>/<project>/הערות/<file>
 *
 * The `הערות` subfolder is lazy-created the first time someone
 * attaches a file from a הערה (top-level project comment) on that
 * project. Sibling to the per-task / per-campaign folders the tasks
 * pipeline creates, but global-per-project — there's no per-comment
 * subfolder, since comments are short-lived chat-style notes and
 * splitting attachments by comment ID would just clutter Drive.
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

const COMMENTS_SUBFOLDER_NAME = "הערות";

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

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function ensureCommentsSubfolder(
  drive: drive_v3.Drive,
  parentFolderId: string,
  project: string,
): Promise<string> {
  const cacheKey = project.toLowerCase().trim();
  const cached = COMMENTS_FOLDER_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  // Look up an existing הערות subfolder first.
  const listed = await drive.files.list({
    q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${escapeDriveQuery(COMMENTS_SUBFOLDER_NAME)}' and trashed=false`,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    spaces: "drive",
    pageSize: 1,
  });
  let folderId = listed.data.files?.[0]?.id || "";
  if (!folderId) {
    const created = await drive.files.create({
      requestBody: {
        name: COMMENTS_SUBFOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentFolderId],
      },
      fields: "id",
      supportsAllDrives: true,
    });
    folderId = created.data.id || "";
  }
  if (!folderId) throw new Error("Could not ensure comments attachments subfolder");
  COMMENTS_FOLDER_CACHE.set(cacheKey, {
    id: folderId,
    expiresAt: Date.now() + COMMENTS_FOLDER_TTL_MS,
  });
  return folderId;
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
