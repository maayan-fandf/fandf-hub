/**
 * Upload arbitrary file bytes into a task's Drive folder.
 *
 * Looks up the task row in the Comments sheet, reads its
 * `drive_folder_id`, then uploads via the same SA/DWD pipeline used
 * for folder creation. Returns a stable view URL + an inline-embed URL
 * the comment renderer can drop into an `<img>` tag.
 *
 * Legacy tasks (created before the Drive-folder-per-task change) may
 * have an empty `drive_folder_id`. In that case the caller gets a
 * friendly error; lazy bootstrap can be added later if needed.
 */

import { Readable } from "node:stream";
import { sheetsClient, driveClient, driveFolderOwner } from "@/lib/sa";

export type UploadResult = {
  fileId: string;
  name: string;
  mimeType: string;
  viewUrl: string;
  embedUrl: string;
};

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function findTaskFolderId(
  subjectEmail: string,
  taskId: string,
): Promise<string> {
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
    return folderId;
  }
  throw new Error("Task not found: " + taskId);
}

export async function uploadToTaskFolder(
  subjectEmail: string,
  taskId: string,
  fileName: string,
  mimeType: string,
  bytes: Buffer,
): Promise<UploadResult> {
  const folderId = await findTaskFolderId(subjectEmail, taskId);
  const drive = driveClient(driveFolderOwner());
  const created = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
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
