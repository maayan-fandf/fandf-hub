/**
 * Upload arbitrary file bytes into a task's Drive folder.
 *
 * Looks up the task row in the Comments sheet, reads its
 * `drive_folder_id` (= the campaign folder, in the current model),
 * then lazy-creates a per-task attachments subfolder inside it and
 * uploads the file there. This keeps the campaign folder tidy when
 * multiple tasks share it: each task gets its own subfolder named
 * after its title (or task id when there's no title).
 *
 * Legacy tasks (created before the Drive-folder-per-task change) may
 * have an empty `drive_folder_id`. In that case the caller gets a
 * friendly error.
 */

import { Readable } from "node:stream";
import type { drive_v3 } from "googleapis";
import { sheetsClient, driveClient, driveFolderOwner } from "@/lib/sa";

export type UploadResult = {
  fileId: string;
  name: string;
  mimeType: string;
  viewUrl: string;
  embedUrl: string;
};

export type TaskAttachment = {
  fileId: string;
  name: string;
  mimeType: string;
  viewUrl: string;
  thumbnailLink: string;
  iconLink: string;
  modifiedTime: string;
  sizeBytes: number;
};

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

type TaskFolderInfo = { folderId: string; title: string };

async function findTaskFolderInfo(
  subjectEmail: string,
  taskId: string,
): Promise<TaskFolderInfo> {
  const sheets = sheetsClient(subjectEmail);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
    range: "Comments",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (values.length < 2) throw new Error("Task not found: " + taskId);
  const headers = (values[0] as unknown[]).map((h) => String(h ?? "").trim());
  const idCol = headers.indexOf("id");
  const rowKindCol = headers.indexOf("row_kind");
  const folderIdCol = headers.indexOf("drive_folder_id");
  const titleCol = headers.indexOf("title");
  if (idCol < 0 || rowKindCol < 0 || folderIdCol < 0) {
    throw new Error("Comments sheet is missing required columns");
  }
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol] ?? "") !== taskId) continue;
    if (String(values[i][rowKindCol] ?? "").trim() !== "task") continue;
    const folderId = String(values[i][folderIdCol] ?? "").trim();
    if (!folderId) {
      throw new Error(
        "למשימה זו אין עדיין תיקיית Drive. פתח וערוך אותה כדי ליצור תיקייה.",
      );
    }
    const title = titleCol >= 0 ? String(values[i][titleCol] ?? "").trim() : "";
    return { folderId, title };
  }
  throw new Error("Task not found: " + taskId);
}

/** Sanitize a folder name: strip path separators, collapse to a max
 *  length safe for Drive (which accepts ≤ ~250 but we keep it short
 *  for readability). */
function sanitizeFolderName(name: string): string {
  return name.replace(/[\\/]/g, "-").slice(0, 120);
}

function escapeDriveQuery(value: string): string {
  // Drive search literals are single-quoted; escape backslashes and
  // single quotes to keep the q-string syntactically valid.
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// 5-min in-process cache: taskId → attachmentsFolderId. Keyed by task
// id so a task title rename doesn't immediately spawn a fresh subfolder
// (the cache survives until expiry; a server restart re-resolves by
// name search and falls back to creating a new one).
const ATTACH_CACHE = new Map<string, { id: string; expiresAt: number }>();
const ATTACH_TTL_MS = 5 * 60 * 1000;

async function ensureTaskAttachmentsFolder(
  drive: drive_v3.Drive,
  parentFolderId: string,
  taskId: string,
  taskTitle: string,
): Promise<string> {
  const cached = ATTACH_CACHE.get(taskId);
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  const subfolderName = sanitizeFolderName(taskTitle.trim() || taskId);
  // Look up an existing subfolder of this name first — handles server
  // restarts and the case where a previous upload already created it.
  const listed = await drive.files.list({
    q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${escapeDriveQuery(subfolderName)}' and trashed=false`,
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
        name: subfolderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentFolderId],
      },
      fields: "id",
      supportsAllDrives: true,
    });
    folderId = created.data.id || "";
  }
  if (!folderId) throw new Error("Could not ensure attachments subfolder");
  ATTACH_CACHE.set(taskId, { id: folderId, expiresAt: Date.now() + ATTACH_TTL_MS });
  return folderId;
}

export async function uploadToTaskFolder(
  subjectEmail: string,
  taskId: string,
  fileName: string,
  mimeType: string,
  bytes: Buffer,
): Promise<UploadResult> {
  const { folderId: taskFolderId, title: taskTitle } = await findTaskFolderInfo(
    subjectEmail,
    taskId,
  );
  const drive = driveClient(driveFolderOwner());
  const attachmentsFolderId = await ensureTaskAttachmentsFolder(
    drive,
    taskFolderId,
    taskId,
    taskTitle,
  );
  const created = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [attachmentsFolderId],
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

/**
 * List files currently in the task's attachments subfolder. Used by the
 * /tasks/[id] "קבצים" section to render thumbnails + links to files
 * uploaded from the discussion composer. Returns an empty list when no
 * subfolder exists yet (no uploads yet) or when the parent is missing.
 *
 * `parentFolderId` is the task's `drive_folder_id` (campaign folder in
 * the current model). `taskTitle`/`taskId` resolve to the same
 * subfolder name `ensureTaskAttachmentsFolder` would create — but we
 * never CREATE here, only read.
 */
export async function listTaskAttachments(
  subjectEmail: string,
  parentFolderId: string,
  taskId: string,
  taskTitle: string,
): Promise<{ folderId: string; folderUrl: string; files: TaskAttachment[] }> {
  if (!parentFolderId) return { folderId: "", folderUrl: "", files: [] };
  const drive = driveClient(driveFolderOwner());
  void subjectEmail; // owner-impersonation is sufficient for read-only listing
  const subfolderName = sanitizeFolderName(taskTitle.trim() || taskId);

  // Find the subfolder. Use the cache when warm.
  let attachmentsFolderId = "";
  const cached = ATTACH_CACHE.get(taskId);
  if (cached && cached.expiresAt > Date.now()) {
    attachmentsFolderId = cached.id;
  } else {
    const listed = await drive.files.list({
      q: `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${escapeDriveQuery(subfolderName)}' and trashed=false`,
      fields: "files(id, name)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      spaces: "drive",
      pageSize: 1,
    });
    attachmentsFolderId = listed.data.files?.[0]?.id || "";
    if (attachmentsFolderId) {
      ATTACH_CACHE.set(taskId, {
        id: attachmentsFolderId,
        expiresAt: Date.now() + ATTACH_TTL_MS,
      });
    }
  }
  if (!attachmentsFolderId) {
    return { folderId: "", folderUrl: "", files: [] };
  }

  const filesRes = await drive.files.list({
    q: `'${attachmentsFolderId}' in parents and trashed=false`,
    fields:
      "files(id, name, mimeType, webViewLink, thumbnailLink, iconLink, modifiedTime, size)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    spaces: "drive",
    pageSize: 100,
    orderBy: "modifiedTime desc",
  });
  const files: TaskAttachment[] = (filesRes.data.files ?? []).map((f) => ({
    fileId: f.id || "",
    name: f.name || "",
    mimeType: f.mimeType || "",
    viewUrl:
      f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
    thumbnailLink: f.thumbnailLink || "",
    iconLink: f.iconLink || "",
    modifiedTime: f.modifiedTime || "",
    sizeBytes: typeof f.size === "string" ? parseInt(f.size, 10) || 0 : 0,
  }));
  const folderUrl = `https://drive.google.com/drive/folders/${attachmentsFolderId}`;
  return { folderId: attachmentsFolderId, folderUrl, files };
}
