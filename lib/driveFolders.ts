/**
 * Drive-folder helpers shared by the task write path and the folder
 * picker UI.
 *
 * All ops target the same Shared Drive (env TASKS_SHARED_DRIVE_ID) the
 * task pipeline already uses. Impersonation uses the DRIVE_FOLDER_OWNER
 * so new folders land under the same team account.
 *
 * The "campaign folder" is the 3rd level of the hierarchy:
 *     <Shared Drive> / <company> / <project> / <campaign>
 * The picker scopes listings and creates to a campaign subtree.
 */

import type { drive_v3 } from "googleapis";
import { driveClient, driveFolderOwner } from "@/lib/sa";

export type FolderRef = {
  id: string;
  name: string;
  viewUrl: string;
};

export type FolderChild = {
  id: string;
  name: string;
  modifiedTime: string;
  hasChildren: boolean;
};

function tasksSharedDriveId(): string {
  const v = process.env.TASKS_SHARED_DRIVE_ID;
  if (!v) throw new Error("TASKS_SHARED_DRIVE_ID is not set");
  return v;
}

function driveFolderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${id}`;
}

async function findFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
  sharedDriveId: string,
): Promise<string | null> {
  const safe = name.replace(/'/g, "\\'");
  const q = [
    "mimeType='application/vnd.google-apps.folder'",
    `name='${safe}'`,
    `'${parentId}' in parents`,
    "trashed=false",
  ].join(" and ");
  const res = await drive.files.list({
    q,
    fields: "files(id, name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: sharedDriveId,
  });
  return res.data.files?.[0]?.id ?? null;
}

async function createFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
): Promise<FolderRef> {
  const safe = (name || "(unnamed)").replace(/[\\/]/g, "-");
  const created = await drive.files.create({
    requestBody: {
      name: safe,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id, name, webViewLink",
    supportsAllDrives: true,
  });
  const id = created.data.id;
  if (!id) throw new Error("Drive folder create returned no id");
  return {
    id,
    name: created.data.name || safe,
    viewUrl: created.data.webViewLink || driveFolderUrl(id),
  };
}

async function getOrCreate(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
  sharedDriveId: string,
): Promise<string> {
  const existing = await findFolder(drive, parentId, name, sharedDriveId);
  if (existing) return existing;
  const ref = await createFolder(drive, parentId, name);
  return ref.id;
}

/**
 * READ-ONLY lookup of the campaign folder at
 * `<company>/<project>/<campaign>` inside the Shared Drive. Returns
 * `null` for `folderId` if any segment is missing — the caller is
 * expected to treat this as "not yet — will be created at task save
 * time" and render an empty state.
 *
 * This is the function called by the picker UI on every company /
 * project / campaign change. It MUST NOT create folders — an earlier
 * version called `ensureCampaignFolderId` here, which meant every
 * keystroke in the campaign input silently materialized an empty
 * folder at the project level. The cleanup-prone bug was caught in
 * production testing on 2026-04-24.
 *
 * If `campaign` is empty, returns the project-level folder (or null if
 * the project folder itself doesn't exist yet).
 */
export async function findCampaignFolderId(
  subjectEmail: string,
  args: { company: string; project: string; campaign: string },
): Promise<{ folderId: string | null; viewUrl: string | null }> {
  const sharedDriveId = tasksSharedDriveId();
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  let parent: string | null = sharedDriveId;
  const co = args.company.trim();
  if (co) {
    parent = await findFolder(drive, parent, co, sharedDriveId);
    if (!parent) return { folderId: null, viewUrl: null };
  }
  const proj = args.project.trim() || "(no-project)";
  parent = await findFolder(drive, parent, proj, sharedDriveId);
  if (!parent) return { folderId: null, viewUrl: null };
  const campaign = args.campaign.trim();
  if (campaign) {
    parent = await findFolder(drive, parent, campaign, sharedDriveId);
    if (!parent) return { folderId: null, viewUrl: null };
  }
  return { folderId: parent, viewUrl: driveFolderUrl(parent) };
}

/**
 * Resolves (and creates if missing) the campaign folder. Only used on
 * task save — never from the picker UI directly. Before this was
 * split, the picker called this function on every keystroke in the
 * campaign input and filled Drive with partial-name folders.
 */
export async function ensureCampaignFolderId(
  subjectEmail: string,
  args: { company: string; project: string; campaign: string },
): Promise<{ folderId: string; viewUrl: string }> {
  const sharedDriveId = tasksSharedDriveId();
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  let parent = sharedDriveId;
  const co = args.company.trim();
  if (co) parent = await getOrCreate(drive, parent, co, sharedDriveId);
  parent = await getOrCreate(
    drive,
    parent,
    args.project.trim() || "(no-project)",
    sharedDriveId,
  );
  const campaign = args.campaign.trim();
  if (campaign) {
    parent = await getOrCreate(drive, parent, campaign, sharedDriveId);
  }
  return { folderId: parent, viewUrl: driveFolderUrl(parent) };
}

/**
 * Lists immediate subfolders of `parentId` inside the Shared Drive.
 * Results are sorted by modifiedTime desc so recent work surfaces first
 * in the picker. `hasChildren` is a coarse hint — we do one extra query
 * per parent (page-size 1) to check if any child folder exists, which is
 * cheap and avoids a chevron with no content behind it.
 */
export async function listFolderChildren(
  subjectEmail: string,
  parentId: string,
): Promise<FolderChild[]> {
  const sharedDriveId = tasksSharedDriveId();
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  const res = await drive.files.list({
    q: [
      "mimeType='application/vnd.google-apps.folder'",
      `'${parentId}' in parents`,
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
  // Coarse "has children" probe: one list per folder, page-size 1. For
  // a typical campaign folder (≤20 subfolders) this is ≤20 extra cheap
  // requests, all running in parallel.
  const probes = await Promise.all(
    items.map(async (f) => {
      if (!f.id) return false;
      try {
        const probe = await drive.files.list({
          q: [
            "mimeType='application/vnd.google-apps.folder'",
            `'${f.id}' in parents`,
            "trashed=false",
          ].join(" and "),
          fields: "files(id)",
          pageSize: 1,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          corpora: "drive",
          driveId: sharedDriveId,
        });
        return (probe.data.files?.length ?? 0) > 0;
      } catch {
        return false;
      }
    }),
  );
  return items.map((f, i) => ({
    id: f.id || "",
    name: f.name || "",
    modifiedTime: f.modifiedTime || "",
    hasChildren: probes[i],
  }));
}

/**
 * Creates a subfolder under the given parent. Used by the picker's
 * "+ new folder" action.
 */
export async function createChildFolder(
  subjectEmail: string,
  parentId: string,
  name: string,
): Promise<FolderRef> {
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  return createFolder(drive, parentId, name);
}

/**
 * Reads a folder's current name + webViewLink. Used when a task is
 * re-pointed to an existing folder so we can persist a stable
 * `drive_folder_url` alongside the ID.
 */
export async function getFolderRef(
  subjectEmail: string,
  folderId: string,
): Promise<FolderRef> {
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  const res = await drive.files.get({
    fileId: folderId,
    fields: "id, name, webViewLink",
    supportsAllDrives: true,
  });
  return {
    id: res.data.id || folderId,
    name: res.data.name || "",
    viewUrl: res.data.webViewLink || driveFolderUrl(folderId),
  };
}
