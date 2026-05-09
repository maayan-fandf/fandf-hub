/**
 * Per-user "drafts" Drive folder management — supports the inline
 * template flow on /tasks/new. When an issuer picks a (dept, kind)
 * with a configured template, we materialize a copy of the template
 * here so they can edit it inline before the task is actually created.
 * On task submit, the draft folder is RENAMED + RE-PARENTED into the
 * permanent task folder spot. On abandon, a daily cron prunes drafts
 * older than 24h.
 *
 * Layout (under the Tasks Shared Drive):
 *
 *   _drafts_/
 *     <userEmail>/
 *       <draft-folder-id>/
 *         <copied-template>.gdoc
 *
 * The per-user split is purely cosmetic — the prune cron walks the
 * whole `_drafts_` tree and keys decisions on `modifiedTime`. The
 * folder hierarchy makes it easy for admins to see at a glance who
 * has open drafts.
 *
 * All ops impersonate `driveFolderOwner()` so the draft + its
 * contents are owned by the team account, matching how the rest of
 * the task pipeline structures Drive ownership.
 */

import { driveClient, driveFolderOwner } from "@/lib/sa";
import {
  findChildFolderByName,
  getOrCreateChildFolder,
  getTasksSharedDriveId,
} from "@/lib/driveFolders";

/** Top-level folder name on the Shared Drive. Underscores chosen to
 *  visually push it to the bottom of admin browsing — it's not user-
 *  facing content. */
export const DRAFTS_ROOT_NAME = "_drafts_";

export type DraftMaterializationResult = {
  /** The draft folder we created (or reused) under the user's
   *  per-user drafts folder. */
  draftFolderId: string;
  /** Drive open-in-browser URL for the draft folder. */
  draftFolderUrl: string;
  /** Drive id of the COPIED template that lives inside the draft
   *  folder — this is what the form embeds in its iframe. */
  copyDocId: string;
  /** Direct link to the copy. */
  copyDocUrl: string;
  /** Display name of the copy (typically `"<template> (טיוטה)"`). */
  copyDocName: string;
};

function draftFolderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${id}`;
}

/**
 * Materializes a draft folder for a user and copies the template doc
 * into it. Idempotent at the folder level — the same user's drafts
 * folder is reused. Each call creates a NEW draft subfolder + new
 * copy, so two simultaneous edits get separate Drive identities.
 */
export async function materializeDraft(args: {
  subjectEmail: string;
  userEmail: string;
  templateDocId: string;
  templateName: string;
  /** Optional context label baked into the draft folder name so admins
   *  can see at a glance which task is being drafted. */
  contextLabel?: string;
}): Promise<DraftMaterializationResult> {
  const sharedDriveId = getTasksSharedDriveId();
  const drive = driveClient(driveFolderOwner() || args.subjectEmail);

  // _drafts_/<userEmail>/  — user-scoped sub-tree.
  const draftsRootId = await getOrCreateChildFolder(
    drive,
    sharedDriveId,
    DRAFTS_ROOT_NAME,
    sharedDriveId,
  );
  const userBucketId = await getOrCreateChildFolder(
    drive,
    draftsRootId,
    args.userEmail,
    sharedDriveId,
  );

  // Per-draft subfolder. Always a fresh one (no idempotency at this
  // level — different (dept, kind) selections must not collide).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const draftName = `${stamp}${
    args.contextLabel ? ` — ${args.contextLabel}` : ""
  }`;
  const draftFolderRes = await drive.files.create({
    requestBody: {
      name: draftName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [userBucketId],
    },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });
  const draftFolderId = draftFolderRes.data.id;
  if (!draftFolderId) throw new Error("Drive folder create returned no id");

  // Copy the template into the draft folder. files.copy preserves the
  // mime type, so a Google Doc template stays a Doc, a Sheet stays a
  // Sheet, etc. We rename the copy to "<template> (טיוטה)" so it
  // visually identifies as work-in-progress in Drive listings.
  const copyName = `${args.templateName} (טיוטה)`;
  const copyRes = await drive.files.copy({
    fileId: args.templateDocId,
    requestBody: {
      name: copyName,
      parents: [draftFolderId],
    },
    fields: "id, name, mimeType, webViewLink",
    supportsAllDrives: true,
  });
  const copyDocId = copyRes.data.id;
  if (!copyDocId) throw new Error("Drive copy returned no id");

  return {
    draftFolderId,
    draftFolderUrl:
      draftFolderRes.data.webViewLink || draftFolderUrl(draftFolderId),
    copyDocId,
    copyDocUrl:
      copyRes.data.webViewLink ||
      `https://drive.google.com/file/d/${copyDocId}/view`,
    copyDocName: copyRes.data.name || copyName,
  };
}

/**
 * Verifies that `draftFolderId` is a folder under
 * `_drafts_/<userEmail>/` and deletes it (along with its contents)
 * via Drive's `trash → delete`. Caller is expected to have a session
 * for `userEmail` — we re-check the parent path here defensively to
 * prevent a hostile request from deleting arbitrary Drive folders.
 *
 * Best-effort: returns `false` on any failure, the caller treats that
 * as "draft probably already gone" — since the daily prune cron will
 * mop up anything we miss.
 */
export async function deleteDraftFolder(args: {
  subjectEmail: string;
  userEmail: string;
  draftFolderId: string;
}): Promise<boolean> {
  if (!args.draftFolderId) return false;
  try {
    const sharedDriveId = getTasksSharedDriveId();
    const drive = driveClient(driveFolderOwner() || args.subjectEmail);
    // Resolve the draft's parent folder + walk up two levels to
    // confirm it's the matching user's drafts bucket. This rejects
    // requests where a user passes someone else's draftFolderId.
    const meta = await drive.files.get({
      fileId: args.draftFolderId,
      fields: "id, parents, mimeType",
      supportsAllDrives: true,
    });
    if (meta.data.mimeType !== "application/vnd.google-apps.folder") {
      console.warn(
        `[draftFolders.deleteDraftFolder] not a folder: ${args.draftFolderId}`,
      );
      return false;
    }
    const parentId = meta.data.parents?.[0];
    if (!parentId) return false;
    // Parent should be the user-bucket folder named after their email.
    const parentMeta = await drive.files.get({
      fileId: parentId,
      fields: "id, name, parents",
      supportsAllDrives: true,
    });
    const expectedName = args.userEmail;
    if ((parentMeta.data.name || "") !== expectedName) {
      console.warn(
        `[draftFolders.deleteDraftFolder] parent mismatch: ` +
          `expected ${expectedName}, got ${parentMeta.data.name}`,
      );
      return false;
    }
    // Grandparent should be _drafts_ under the shared drive.
    const grandparentId = parentMeta.data.parents?.[0];
    if (!grandparentId) return false;
    const grandparentMeta = await drive.files.get({
      fileId: grandparentId,
      fields: "id, name",
      supportsAllDrives: true,
    });
    if ((grandparentMeta.data.name || "") !== DRAFTS_ROOT_NAME) {
      console.warn(
        `[draftFolders.deleteDraftFolder] grandparent mismatch: ` +
          `expected ${DRAFTS_ROOT_NAME}, got ${grandparentMeta.data.name}`,
      );
      return false;
    }
    // Verified — delete the folder + contents.
    await drive.files.delete({
      fileId: args.draftFolderId,
      supportsAllDrives: true,
    });
    return true;
  } catch (e) {
    console.warn(
      `[draftFolders.deleteDraftFolder] failed for ${args.draftFolderId}:`,
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
}

/**
 * Moves a draft folder out of the drafts hierarchy and into a new
 * parent (the campaign folder). Renames it at the same time so the
 * folder ends up matching the standard task folder naming. Returns
 * the new view URL on success.
 *
 * Used by the task-create path when the issuer is committing a draft
 * — preserves the user's edits to the embedded template by NOT
 * re-copying anything.
 */
export async function adoptDraftFolderAsTaskFolder(args: {
  subjectEmail: string;
  draftFolderId: string;
  newParentId: string;
  newName: string;
}): Promise<{ folderId: string; viewUrl: string }> {
  const drive = driveClient(driveFolderOwner() || args.subjectEmail);
  // Read current parents so we can replace them atomically with the
  // new campaign folder.
  const meta = await drive.files.get({
    fileId: args.draftFolderId,
    fields: "id, parents, webViewLink",
    supportsAllDrives: true,
  });
  const currentParents = (meta.data.parents || []).join(",");
  const updated = await drive.files.update({
    fileId: args.draftFolderId,
    requestBody: { name: args.newName },
    addParents: args.newParentId,
    removeParents: currentParents || undefined,
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });
  return {
    folderId: updated.data.id || args.draftFolderId,
    viewUrl:
      updated.data.webViewLink || draftFolderUrl(args.draftFolderId),
  };
}

/**
 * Looks up the user's drafts bucket folder id (the
 * `_drafts_/<userEmail>/` level). Returns `null` if not yet created.
 * Used by the GC cron to enumerate pruning candidates.
 */
export async function findUserDraftsBucket(args: {
  subjectEmail: string;
  userEmail: string;
}): Promise<string | null> {
  const sharedDriveId = getTasksSharedDriveId();
  const drive = driveClient(driveFolderOwner() || args.subjectEmail);
  const draftsRootId = await findChildFolderByName(
    drive,
    sharedDriveId,
    DRAFTS_ROOT_NAME,
    sharedDriveId,
  );
  if (!draftsRootId) return null;
  return findChildFolderByName(
    drive,
    draftsRootId,
    args.userEmail,
    sharedDriveId,
  );
}
