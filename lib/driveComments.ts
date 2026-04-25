/**
 * Drive comments — read-only mirror of comments left on files inside a
 * task's Drive folder. Surfaces design feedback that lives on the
 * artwork itself (anchored rectangles on screenshots, etc.) into the
 * task's hub thread.
 *
 * Read-only on purpose. Drive's anchor coordinates can't be reproduced
 * from a hub textarea, so v1 just renders + deep-links back to Drive
 * for replies. Two-way sync is a bigger lift documented in
 * project_chat_feeling_backlog.md.
 *
 * Auth: same SA / DWD client used everywhere — Drive scope already
 * granted. Impersonates the caller so per-user permissions apply (a
 * user who can't see a file's comments in Drive won't see them here).
 */

import type { drive_v3 } from "googleapis";
import { driveClient } from "@/lib/sa";

export type DriveCommentReply = {
  id: string;
  authorName: string;
  authorPhoto?: string;
  content: string;
  createdTime: string;
  modifiedTime?: string;
  resolved?: boolean;
};

export type DriveCommentThread = DriveCommentReply & {
  /** When the comment is anchored to a region of the file (e.g. the
   *  yellow rectangle on a screenshot), the deep-link below opens
   *  Drive with the comment selected. */
  driveDeepLink: string;
  quotedSnippet?: string;
  replies: DriveCommentReply[];
};

export type DriveFileWithComments = {
  fileId: string;
  fileName: string;
  mimeType: string;
  iconLink?: string;
  thumbnailLink?: string;
  webViewLink: string;
  threads: DriveCommentThread[];
};

/* ── In-process cache: 60s TTL keyed on (folderId, subjectEmail) ──── */

type CacheEntry = {
  expiresAt: number;
  payload: DriveFileWithComments[];
};
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

function cacheKey(folderId: string, subject: string): string {
  return `${folderId}::${subject.toLowerCase()}`;
}

function readCache(folderId: string, subject: string): DriveFileWithComments[] | null {
  const k = cacheKey(folderId, subject);
  const hit = CACHE.get(k);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    CACHE.delete(k);
    return null;
  }
  return hit.payload;
}

function writeCache(
  folderId: string,
  subject: string,
  payload: DriveFileWithComments[],
): void {
  CACHE.set(cacheKey(folderId, subject), {
    expiresAt: Date.now() + TTL_MS,
    payload,
  });
}

/* ── Public read ──────────────────────────────────────────────────── */

/**
 * Returns the list of files in `folderId` that have at least one
 * comment, with their threads + replies. Files with zero comments are
 * dropped from the result so the caller doesn't render empty headers.
 *
 * Concurrency: we list children once, then fan out comments.list per
 * file. For typical task folders (≤30 files) this is fine. If folders
 * grow large, switch to filtering by mime types where annotation is
 * common (image/*, application/pdf) before the comments fan-out.
 */
export async function listTaskDriveComments(
  subjectEmail: string,
  folderId: string,
): Promise<DriveFileWithComments[]> {
  if (!folderId) return [];
  const cached = readCache(folderId, subjectEmail);
  if (cached) return cached;

  const drive = driveClient(subjectEmail);
  const sharedDriveId = process.env.TASKS_SHARED_DRIVE_ID;

  // List immediate children of the folder (any mime type — comments can
  // live on any file). Skip nested folders since we're scoped to the
  // task's own folder per the spec.
  const filesRes = await drive.files.list({
    q: [
      `'${folderId}' in parents`,
      "trashed=false",
      "mimeType != 'application/vnd.google-apps.folder'",
    ].join(" and "),
    fields:
      "files(id, name, mimeType, iconLink, thumbnailLink, webViewLink)",
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    ...(sharedDriveId
      ? { corpora: "drive" as const, driveId: sharedDriveId }
      : {}),
  });

  const files = filesRes.data.files ?? [];
  if (!files.length) {
    writeCache(folderId, subjectEmail, []);
    return [];
  }

  const out = await Promise.all(
    files.map((f) => readFileComments(drive, f)),
  );
  const filtered = out.filter((x): x is DriveFileWithComments => !!x);
  writeCache(folderId, subjectEmail, filtered);
  return filtered;
}

async function readFileComments(
  drive: drive_v3.Drive,
  file: drive_v3.Schema$File,
): Promise<DriveFileWithComments | null> {
  if (!file.id) return null;
  try {
    const res = await drive.comments.list({
      fileId: file.id,
      fields:
        "comments(id, author(displayName, photoLink), content, htmlContent, createdTime, modifiedTime, resolved, deleted, quotedFileContent, anchor, replies(id, author(displayName, photoLink), content, createdTime, modifiedTime, deleted))",
      includeDeleted: false,
      pageSize: 100,
    });
    const raw = (res.data.comments ?? []).filter((c) => !c.deleted);
    if (!raw.length) return null;
    const threads: DriveCommentThread[] = raw.map((c) => {
      const replies = (c.replies ?? [])
        .filter((r) => !r.deleted)
        .map((r) => ({
          id: r.id || "",
          authorName: r.author?.displayName || "—",
          authorPhoto: r.author?.photoLink || undefined,
          content: r.content || "",
          createdTime: r.createdTime || "",
          modifiedTime: r.modifiedTime || undefined,
        }));
      return {
        id: c.id || "",
        authorName: c.author?.displayName || "—",
        authorPhoto: c.author?.photoLink || undefined,
        content: c.content || "",
        createdTime: c.createdTime || "",
        modifiedTime: c.modifiedTime || undefined,
        resolved: !!c.resolved,
        quotedSnippet: c.quotedFileContent?.value || undefined,
        // Drive's `?disco=<commentId>` opens the file with the comment
        // selected (and the anchor highlighted on images).
        driveDeepLink:
          (file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`) +
          `?disco=${encodeURIComponent(c.id || "")}`,
        replies,
      };
    });
    return {
      fileId: file.id,
      fileName: file.name || "(unnamed)",
      mimeType: file.mimeType || "",
      iconLink: file.iconLink || undefined,
      thumbnailLink: file.thumbnailLink || undefined,
      webViewLink:
        file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
      threads,
    };
  } catch (e) {
    // A file we can't read shouldn't kill the whole list — log and
    // continue. Most often this is a transient API hiccup.
    console.log(
      `[driveComments] comments.list failed for file ${file.id}:`,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}
