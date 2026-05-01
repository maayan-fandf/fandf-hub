/**
 * Drive-folder helpers scoped to the campaign tier of the project tree.
 *
 * The hierarchy in the Shared Drive:
 *     <Shared Drive root> / <company> / <project> / <campaign> / <task>
 *
 * "Campaigns" used to be a free-text column on task rows — implicit, lazy,
 * created on first task save. As of 2026-04-27 we treat the Drive folder
 * tier as the source of truth: every campaign is a folder under its
 * project, and renames in either direction stay synced. This file is the
 * Drive-side half of that contract.
 *
 * Lower-level Drive primitives (find / create / list children) live in
 * `lib/driveFolders.ts`. We import only its `findCampaignFolderId` /
 * `ensureCampaignFolderId` so we don't duplicate the path-walk logic.
 */

import { unstable_cache, revalidateTag } from "next/cache";
import { driveClient, driveFolderOwner } from "@/lib/sa";
import {
  ensureCampaignFolderId,
  findCampaignFolderId,
} from "@/lib/driveFolders";
import { isSharedFolderName } from "@/lib/driveSharedFolder";

function tasksSharedDriveId(): string {
  const v = process.env.TASKS_SHARED_DRIVE_ID;
  if (!v) throw new Error("TASKS_SHARED_DRIVE_ID is not set");
  return v;
}

function driveFolderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${id}`;
}

export type CampaignFolder = {
  id: string;
  name: string;
  modifiedTime: string;
  viewUrl: string;
};

/**
 * Lists every direct child folder of `<company>/<project>/`. These are
 * the canonical campaigns for that project.
 *
 * Returns `[]` (not an error) when the project folder doesn't exist yet
 * — treat that as "no campaigns" so the picker can still offer "create
 * new". Callers that need the project folder itself materialized should
 * call `ensureCampaignFolderId(...,{campaign:""})` first.
 */
async function listInner(
  company: string,
  project: string,
): Promise<CampaignFolder[]> {
  const sharedDriveId = tasksSharedDriveId();
  // Use the folder owner so the listing is consistent regardless of who
  // calls — campaign folders in a Shared Drive are visible to all members
  // anyway, and centralizing on one subject avoids per-user JWT churn
  // for what's effectively a public read.
  const subject = driveFolderOwner();
  if (!subject) return [];
  const projectFolder = await findCampaignFolderId(subject, {
    company,
    project,
    campaign: "",
  });
  if (!projectFolder.folderId) return [];
  const drive = driveClient(subject);
  const res = await drive.files.list({
    q: [
      "mimeType='application/vnd.google-apps.folder'",
      `'${projectFolder.folderId}' in parents`,
      "trashed=false",
    ].join(" and "),
    fields: "files(id, name, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: sharedDriveId,
  });
  const items = res.data.files ?? [];
  return items
    .filter((f) => !isSharedFolderName(f.name || ""))
    .map((f) => ({
      id: f.id || "",
      name: f.name || "",
      modifiedTime: f.modifiedTime || "",
      viewUrl: driveFolderUrl(f.id || ""),
    }));
}

/**
 * Uncached campaign-list lookup. Earlier versions cached at 60s via
 * unstable_cache, but Firebase App Hosting's multi-instance topology
 * meant freshly-created Drive folders could stay invisible to one
 * instance while a sibling already saw them — same flakiness pattern
 * that bit getMyProjectsDirect (commit 37f6181) and
 * listRecentMessages (commit bc7fa0b). Only consumer is
 * tasksCampaignsDirect → /api/tasks/campaigns, which fires once per
 * task-form open (cold path). One Drive API call per request is well
 * within quota.
 */
export async function listCampaignFolders(
  company: string,
  project: string,
): Promise<CampaignFolder[]> {
  if (!project.trim()) return [];
  return listInner(company.trim(), project.trim());
}

function bustCampaignFoldersCache() {
  // Clear all cache entries tagged "campaign-folders" so the next read
  // hits Drive. Cheap because the only consumers are the picker + the
  // task read path's name-injection step, both server-side.
  try {
    revalidateTag("campaign-folders");
  } catch {
    // unstable_cache revalidation can throw outside a request context
    // (e.g. in a unit test); best-effort.
  }
}

/**
 * Creates a campaign folder upfront — used by the "+ צור קמפיין חדש"
 * affordance in the picker so the folder exists the moment the user
 * commits the name, not lazily on first task save.
 *
 * Idempotent via `ensureCampaignFolderId` — calling twice with the same
 * name returns the existing folder rather than creating a duplicate.
 */
export async function createCampaignFolder(
  subjectEmail: string,
  args: { company: string; project: string; name: string },
): Promise<CampaignFolder> {
  const name = args.name.trim();
  if (!name) throw new Error("Campaign name is required");
  const created = await ensureCampaignFolderId(subjectEmail, {
    company: args.company,
    project: args.project,
    campaign: name,
  });
  bustCampaignFoldersCache();
  return {
    id: created.folderId,
    name,
    modifiedTime: new Date().toISOString(),
    viewUrl: created.viewUrl,
  };
}

/**
 * Renames a campaign folder in Drive. Returns the live folder reference
 * with the new name. Caller is responsible for bulk-updating task rows
 * that referenced the old name — see `/api/campaigns/rename`.
 *
 * Refuses no-op renames (same name, case-insensitive) so we don't bust
 * caches or echo a redundant Drive write.
 */
export async function renameCampaignFolder(
  subjectEmail: string,
  args: { folderId: string; newName: string },
): Promise<CampaignFolder> {
  const newName = args.newName.trim().replace(/[\\/]/g, "-");
  if (!newName) throw new Error("New campaign name is required");
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  const current = await drive.files.get({
    fileId: args.folderId,
    fields: "id, name, modifiedTime",
    supportsAllDrives: true,
  });
  if ((current.data.name || "").trim() === newName) {
    return {
      id: current.data.id || args.folderId,
      name: current.data.name || newName,
      modifiedTime: current.data.modifiedTime || new Date().toISOString(),
      viewUrl: driveFolderUrl(args.folderId),
    };
  }
  const updated = await drive.files.update({
    fileId: args.folderId,
    requestBody: { name: newName },
    fields: "id, name, modifiedTime",
    supportsAllDrives: true,
  });
  bustCampaignFoldersCache();
  return {
    id: updated.data.id || args.folderId,
    name: updated.data.name || newName,
    modifiedTime: updated.data.modifiedTime || new Date().toISOString(),
    viewUrl: driveFolderUrl(args.folderId),
  };
}

/**
 * Resolves an existing campaign folder by name within `<company>/<project>`.
 * Returns null (not an error) when the folder doesn't exist — used by the
 * rename endpoint to locate the source folder when the caller passes only
 * the old name (the picker doesn't always have the folder ID handy).
 */
export async function findCampaignFolderByName(
  subjectEmail: string,
  args: { company: string; project: string; name: string },
): Promise<{ folderId: string } | null> {
  const name = args.name.trim();
  if (!name) return null;
  const ref = await findCampaignFolderId(subjectEmail, {
    company: args.company,
    project: args.project,
    campaign: name,
  });
  return ref.folderId ? { folderId: ref.folderId } : null;
}

/**
 * Reads the live name of a folder by ID. Used by the task read path to
 * project the canonical campaign name onto rows that have a stored
 * `drive_folder_id` — so a Drive-side rename propagates without a
 * sheet-side bulk-update.
 *
 * Cached for 60s under the same tag as `listCampaignFolders` so a rename
 * busts both reads simultaneously.
 */
const _folderNameCached = unstable_cache(
  async (folderId: string): Promise<string> => {
    const subject = driveFolderOwner();
    if (!subject || !folderId) return "";
    try {
      const drive = driveClient(subject);
      const res = await drive.files.get({
        fileId: folderId,
        fields: "name",
        supportsAllDrives: true,
      });
      return (res.data.name || "").trim();
    } catch {
      return "";
    }
  },
  ["campaign-folder-name"],
  { revalidate: 60, tags: ["campaign-folders"] },
);

export async function getFolderName(folderId: string): Promise<string> {
  if (!folderId) return "";
  return _folderNameCached(folderId);
}
