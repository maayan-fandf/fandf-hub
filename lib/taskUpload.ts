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
import {
  sheetsClient,
  driveClient,
  driveFolderOwner,
  useFirestoreWrites,
} from "@/lib/sa";
import { isStaffEmail } from "@/lib/viewerTier";
import { canOpenProject } from "@/lib/projectAccess";

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

/** Who the task belongs to — read off the same row as the folder id. */
type TaskWho = { project: string; people: string[] };

function lcEmails(v: unknown): string[] {
  return (Array.isArray(v) ? v : String(v ?? "").split(/[,;]+/))
    .map((s) => String(s ?? "").toLowerCase().trim())
    .filter(Boolean);
}

/**
 * May this viewer add files to this task? The upload runs as the Drive
 * owner, and nothing here used to compare the caller to the task — any
 * account holding a task id could write into its folder (authorization
 * audit, 2026-10-01).
 *
 * Same rule as tasksGetDirect, applied to the row this file already reads
 * (tasksGetDirect scans the whole collection — too heavy for the upload
 * hot path): staff pass on the domain; anyone else must be on the task
 * (author / approver / assignee) or have its project in their Keys scope.
 * Fails closed.
 */
async function mayTouchTask(
  subjectEmail: string,
  who: TaskWho,
): Promise<boolean> {
  const lc = String(subjectEmail || "").toLowerCase().trim();
  if (!lc) return false;
  if (isStaffEmail(lc)) return true;
  if (who.people.includes(lc)) return true;
  return canOpenProject(lc, who.project);
}

// A Drive id is letters, digits, "-" and "_". A folder id of any other
// shape that reaches a `q` string is a query injection, not a folder; the
// length floor also keeps out aliases such as "root".
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

// Per-process cache: taskId → { info, expiresAt }. Drive folder IDs are
// effectively immutable per task (set at create time, never reassigned)
// and titles change rarely. Caching the lookup with a 5-min TTL cuts
// the Sheets API reads on the submission hot path — Maayan hit the
// 300-reads/min/user quota 2026-05-12 while repeatedly testing the
// submission modal because each /api/worktasks/upload reread the
// entire Comments tab from scratch.
//
// Single shared map across subjects since the data is the same
// regardless of viewer (drive_folder_id + title don't depend on who's
// asking). The 5-min TTL bounds staleness if a title is renamed.
//
// WHO may upload does depend on the viewer, so `who` is cached beside the
// folder and checked on every call — a cache hit is not an access grant.
type CacheEntry = { info: TaskFolderInfo; who: TaskWho; expiresAt: number };
const FOLDER_INFO_CACHE = new Map<string, CacheEntry>();
const FOLDER_INFO_TTL_MS = 5 * 60 * 1000;

async function findTaskFolderInfo(
  subjectEmail: string,
  taskId: string,
): Promise<TaskFolderInfo> {
  const cached = FOLDER_INFO_CACHE.get(taskId);
  // A cached "no" falls through to a fresh read rather than refusing: the
  // viewer may have been assigned to the task since the entry was stored.
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    (await mayTouchTask(subjectEmail, cached.who))
  ) {
    return cached.info;
  }
  if (useFirestoreWrites()) {
    // Phase 4 — the Comments sheet is no longer written (it goes
    // stale, so a freshly-created/edited task's folder wouldn't be
    // found here), so read this task's Drive-folder info straight
    // from its Firestore doc: one keyed get, far cheaper than the
    // full-tab scan below. Same error semantics as the Sheets path.
    const { getDb, FS_COLLECTIONS } = await import("@/lib/firestore");
    const db = getDb();
    const docRef = db.collection(FS_COLLECTIONS.tasks).doc(taskId);
    const snap = await docRef.get();
    if (!snap.exists) throw new Error("Task not found: " + taskId);
    const d = snap.data() as Record<string, unknown>;
    let folderId = String(d.drive_folder_id ?? "").trim();
    const title = String(d.title ?? "").trim();
    // Before the lazy folder creation below — a refused caller must not
    // leave a folder behind in the shared drive.
    const who: TaskWho = {
      project: String(d.project ?? "").trim(),
      people: [
        ...lcEmails(d.author_email),
        ...lcEmails(d.approver_email),
        ...lcEmails(d.assignees),
      ],
    };
    if (!(await mayTouchTask(subjectEmail, who))) {
      throw new Error("Access denied");
    }
    if (!folderId) {
      // LAZY folder creation (2026-06-10): tasks no longer get a Drive
      // folder at create time (it was cluttering project folders —
      // most tasks never receive attachments). The first actual upload
      // creates the folder on-demand here, under the same campaign
      // hierarchy createTask used to use, then persists the id+url
      // back onto the task doc so the task page shows the 📂 link
      // from now on.
      const { createTaskFolder } = await import("@/lib/tasksWriteDirect");
      const folder = await createTaskFolder({
        id: taskId,
        title,
        company: String(d.company ?? "").trim(),
        project: String(d.project ?? "").trim(),
        campaign: String(d.campaign ?? "").trim(),
      });
      if (!folder) {
        throw new Error(
          "יצירת תיקיית Drive למשימה נכשלה — נסה/י שוב או בחר/י תיקייה ידנית בעריכת המשימה.",
        );
      }
      folderId = folder.folderId;
      await docRef
        .update({
          drive_folder_id: folder.folderId,
          drive_folder_url: folder.folderUrl,
        })
        .catch((e) => {
          // Folder exists in Drive but the doc update failed — log and
          // continue; the upload still lands in the right place, and a
          // retry next upload will find the folder by id via this same
          // lazy path (after the cache expires it re-reads the doc,
          // sees empty id again, and createTaskFolder will create a
          // SECOND folder — acceptable rare-failure cost vs blocking
          // the user's upload now).
          console.log(
            "[taskUpload] lazy folder persisted to Drive but doc update failed:",
            e instanceof Error ? e.message : e,
          );
        });
    }
    const info: TaskFolderInfo = { folderId, title };
    FOLDER_INFO_CACHE.set(taskId, {
      info,
      who,
      expiresAt: Date.now() + FOLDER_INFO_TTL_MS,
    });
    return info;
  }
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
  const cellOf = (row: unknown[], name: string): unknown => {
    const c = headers.indexOf(name);
    return c >= 0 ? row[c] : "";
  };
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol] ?? "") !== taskId) continue;
    if (String(values[i][rowKindCol] ?? "").trim() !== "task") continue;
    // Sheet rows keep the assignees in the legacy `mentions` CSV column.
    const who: TaskWho = {
      project: String(cellOf(values[i], "project") ?? "").trim(),
      people: [
        ...lcEmails(cellOf(values[i], "author_email")),
        ...lcEmails(cellOf(values[i], "approver_email")),
        ...lcEmails(cellOf(values[i], "mentions")),
      ],
    };
    if (!(await mayTouchTask(subjectEmail, who))) {
      throw new Error("Access denied");
    }
    const folderId = String(values[i][folderIdCol] ?? "").trim();
    if (!folderId) {
      throw new Error(
        "למשימה זו אין עדיין תיקיית Drive. פתח וערוך אותה כדי ליצור תיקייה.",
      );
    }
    const title = titleCol >= 0 ? String(values[i][titleCol] ?? "").trim() : "";
    const info: TaskFolderInfo = { folderId, title };
    FOLDER_INFO_CACHE.set(taskId, {
      info,
      who,
      expiresAt: Date.now() + FOLDER_INFO_TTL_MS,
    });
    return info;
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
//
// The key also carries the PARENT folder the subfolder was found under.
// listTaskAttachments takes its parent from the caller (the peek route
// passes it from the query string), and with a task-id-only key a listing
// under some other folder seeded this cache — the next upload to that
// task then landed in the other folder.
const ATTACH_CACHE = new Map<string, { id: string; expiresAt: number }>();
const ATTACH_TTL_MS = 5 * 60 * 1000;
const attachKey = (taskId: string, parentFolderId: string) =>
  `${taskId}|${parentFolderId}`;

async function ensureTaskAttachmentsFolder(
  drive: drive_v3.Drive,
  parentFolderId: string,
  taskId: string,
  taskTitle: string,
): Promise<string> {
  const cached = ATTACH_CACHE.get(attachKey(taskId, parentFolderId));
  if (cached && cached.expiresAt > Date.now()) return cached.id;
  if (!DRIVE_ID_RE.test(parentFolderId)) {
    throw new Error(
      "מזהה תיקיית ה-Drive של המשימה אינו תקין — בחר/י תיקייה מחדש בעריכת המשימה.",
    );
  }

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
  ATTACH_CACHE.set(attachKey(taskId, parentFolderId), {
    id: folderId,
    expiresAt: Date.now() + ATTACH_TTL_MS,
  });
  return folderId;
}

export async function uploadToTaskFolder(
  subjectEmail: string,
  taskId: string,
  fileName: string,
  mimeType: string,
  bytes: Buffer,
): Promise<UploadResult> {
  // Defensive upfront check — refuse 0-byte input rather than creating
  // an empty Drive file that the comment composer will then reference
  // forever. Maayan reported 2026-05-12 a `image.png` token pointing
  // at a `size: 0` Drive file (broken-image render); the proximate
  // cause was the upload path silently accepting an empty paste.
  if (!bytes || bytes.length === 0) {
    throw new Error(
      "הקובץ ריק — ייתכן שההדבקה לא הצליחה. נסה/י להעתיק את הצילום שוב ולהדביק.",
    );
  }
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
      // Wrap the Buffer in a Node Readable. The googleapis SDK calls
      // `body.pipe()` unconditionally inside its media-upload helper, so
      // passing a Buffer directly throws "b.body.pipe is not a function"
      // (Buffer has no .pipe). Same bug `lib/chat.ts` worked around;
      // this surface re-tripped it in commit 9d14b00 when the previous
      // `Readable.from(bytes)` was swapped to a bare Buffer to try to
      // fix occasional 0-byte uploads. The 0-byte concern is now caught
      // belt-and-suspenders by:
      //   • route.ts (rejects fileEntry.size === 0 at the boundary)
      //   • the upfront `bytes.length === 0` check above
      //   • the post-create `size` verification below
      // so reverting to Readable.from is safe.
      body: Readable.from(bytes),
    },
    // Include `size` so we can verify the upload actually carried bytes
    // before returning success to the composer.
    fields: "id, webViewLink, mimeType, size",
    supportsAllDrives: true,
  });
  const fileId = created.data.id;
  if (!fileId) throw new Error("Drive file create returned no id");
  const reportedSize = parseInt(String(created.data.size || "0"), 10);
  if (!Number.isFinite(reportedSize) || reportedSize <= 0) {
    // Drive accepted the create but ended up with 0 bytes — clean up
    // the empty file so the composer doesn't insert a token that
    // permanently renders as a broken image. Best-effort delete; the
    // thrown error is what reaches the user.
    try {
      await drive.files.delete({ fileId, supportsAllDrives: true });
    } catch (e) {
      console.warn(
        `[taskUpload] failed to delete 0-byte upload ${fileId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    throw new Error(
      "ההעלאה הסתיימה ללא תוכן (0 בייטים). נסה/י שוב — אם זה חוזר, שמור/י את הקובץ קודם ואז גרור/י אותו לתיבת התגובה.",
    );
  }
  return {
    fileId,
    name: fileName,
    mimeType: created.data.mimeType || mimeType,
    viewUrl:
      created.data.webViewLink ||
      `https://drive.google.com/file/d/${fileId}/view`,
    // Proxy through the hub origin so cross-origin auth issues with
    // `lh3.googleusercontent.com` (which only serves files the viewer's
    // Google session can see) can't break inline render. CommentBody
    // re-derives this from the viewUrl anyway, so this field is purely
    // for legacy callers that read `embedUrl` directly.
    embedUrl: `/api/drive/image/${encodeURIComponent(fileId)}`,
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
  // Not a Drive id → nothing to list (and nothing to splice into `q`).
  if (!parentFolderId || !DRIVE_ID_RE.test(parentFolderId)) {
    return { folderId: "", folderUrl: "", files: [] };
  }
  const drive = driveClient(driveFolderOwner());
  void subjectEmail; // owner-impersonation is sufficient for read-only listing
  const subfolderName = sanitizeFolderName(taskTitle.trim() || taskId);

  // Find the subfolder. Use the cache when warm.
  let attachmentsFolderId = "";
  const cached = ATTACH_CACHE.get(attachKey(taskId, parentFolderId));
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
      ATTACH_CACHE.set(attachKey(taskId, parentFolderId), {
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
