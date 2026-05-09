/**
 * Task-kind templates — resolves the Drive folder containing
 * template files for a given (department, kind) pair, plus the
 * actual files inside it. The new-task form uses this to show a
 * per-kind picker so the issuer can pick which template to copy
 * into their draft folder.
 *
 * Drive layout:
 *
 *   <Tasks Shared Drive>/
 *     סכמות משימה/
 *       <Department>/
 *         <Kind>/                  ← kind FOLDER (one per kind)
 *           <template files>       ← admin drops 1+ files here
 *         <Kind 2>/
 *           ...
 *
 * Two-tier resolution:
 *
 *   1. **Explicit:** if the TaskFormSchema sheet has a `template_doc_id`
 *      value for the row, treat it as the kind-folder id. Set via
 *      the /admin/task-form-schema editor's "תבנית" cell or by the
 *      automatic Drive→Sheet reconciler.
 *   2. **Folder convention:** otherwise, walk
 *      `סכמות משימה/<Department>/<Kind>/`.
 *
 * Backward-compat: an explicit `template_doc_id` MAY still point at a
 * file (legacy — pre-folder-restructure rows). When that happens we
 * wrap it as a single-file list so old rows keep working until the
 * reconciler rebinds them to folder ids.
 */

import { cache } from "react";
import { driveClient, driveFolderOwner } from "@/lib/sa";
import {
  findChildFolderByName,
  getTasksSharedDriveId,
} from "@/lib/driveFolders";
import type { TaskFormSchema } from "@/lib/taskFormSchema";

/** Top-level folder name on the F&F Shared Drive. Bootstrap script
 *  creates it (and the per-department subfolders) once; admins can
 *  drop kind folders + template files into it thereafter. */
export const TEMPLATES_ROOT_NAME = "סכמות משימה";

/** A single template file the admin has dropped into a kind folder.
 *  Surfaced to the new-task form picker. */
export type TemplateOption = {
  /** Drive file id. */
  id: string;
  /** Display name. Includes Drive-style extension (.gdoc/.gsheet/...) */
  name: string;
  /** Drive mime type — used downstream to choose between the
   *  /document/.../edit?embedded=true and /spreadsheets/... and
   *  /presentation/... iframe URLs. */
  mimeType: string;
};

export type TemplateRef = {
  /** Drive folder id that holds the templates for this (dept, kind).
   *  Empty string for the legacy single-file case. */
  folderId: string;
  /** Display name of the kind folder (or the file when legacy). */
  folderName: string;
  /** Files inside the kind folder, ordered as Drive returned them.
   *  Empty array means "folder exists but no templates inside yet" —
   *  the form should NOT show the picker in that case. */
  files: TemplateOption[];
  /** Where the binding came from. */
  source: "schema" | "folder" | "schema-legacy-file";
};

/**
 * Returns the template options for `(department, kind)` if any are
 * configured, `null` otherwise. Resolution order: schema-explicit
 * binding wins; falls back to a Drive folder walk under
 * `<shared>/סכמות משימה/<department>/<kind>/`.
 */
export const resolveTemplate = cache(_resolveTemplate);

async function _resolveTemplate(
  subjectEmail: string,
  department: string,
  kind: string,
  schema: TaskFormSchema | null,
): Promise<TemplateRef | null> {
  const dept = department.trim();
  const knd = kind.trim();
  if (!dept || !knd) return null;

  // 1) Schema-explicit binding.
  const schemaId = schema?.templatesByDeptAndKind?.[dept]?.[knd] || "";
  if (schemaId) {
    const resolved = await resolveBoundId(subjectEmail, schemaId);
    if (resolved) return resolved;
    // The bound id points at nothing (file/folder deleted, permission
    // gone). Fall through to folder convention so the feature stays
    // alive even when the explicit binding has rotted.
  }

  // 2) Folder convention.
  return findKindFolder(subjectEmail, dept, knd);
}

/**
 * Resolves a Drive id (file OR folder) into a TemplateRef. The new
 * model expects folders, but legacy bindings might still point at a
 * single file — handle both transparently.
 */
async function resolveBoundId(
  subjectEmail: string,
  boundId: string,
): Promise<TemplateRef | null> {
  try {
    const drive = driveClient(driveFolderOwner() || subjectEmail);
    const meta = await drive.files.get({
      fileId: boundId,
      fields: "id, name, mimeType",
      supportsAllDrives: true,
    });
    const mime = meta.data.mimeType || "";
    const name = meta.data.name || "";
    if (mime === "application/vnd.google-apps.folder") {
      const files = await listFilesInFolder(subjectEmail, boundId);
      return { folderId: boundId, folderName: name, files, source: "schema" };
    }
    // Legacy: bound id is a single file. Wrap it.
    return {
      folderId: "",
      folderName: name,
      files: [{ id: boundId, name, mimeType: mime }],
      source: "schema-legacy-file",
    };
  } catch (e) {
    console.warn(
      `[taskTemplates.resolveBoundId] failed for id=${boundId}:`,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

/**
 * Walk `<shared>/סכמות משימה/<dept>/<kind>/` and list its files.
 * Returns null when any part of the path is missing.
 */
async function findKindFolder(
  subjectEmail: string,
  department: string,
  kind: string,
): Promise<TemplateRef | null> {
  try {
    const sharedDriveId = getTasksSharedDriveId();
    const drive = driveClient(driveFolderOwner() || subjectEmail);
    const rootId = await findChildFolderByName(
      drive,
      sharedDriveId,
      TEMPLATES_ROOT_NAME,
      sharedDriveId,
    );
    if (!rootId) return null;
    const deptFolderId = await findChildFolderByName(
      drive,
      rootId,
      department,
      sharedDriveId,
    );
    if (!deptFolderId) return null;
    const kindFolderId = await findChildFolderByName(
      drive,
      deptFolderId,
      kind,
      sharedDriveId,
    );
    if (!kindFolderId) return null;
    const files = await listFilesInFolder(subjectEmail, kindFolderId);
    return {
      folderId: kindFolderId,
      folderName: kind,
      files,
      source: "folder",
    };
  } catch (e) {
    console.warn(
      "[taskTemplates.findKindFolder] failed:",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

/** Lists non-folder children of a folder on the Tasks Shared Drive.
 *  Used as the source for the new-task form's template picker. */
export async function listFilesInFolder(
  subjectEmail: string,
  folderId: string,
): Promise<TemplateOption[]> {
  try {
    const sharedDriveId = getTasksSharedDriveId();
    const drive = driveClient(driveFolderOwner() || subjectEmail);
    const res = await drive.files.list({
      q: [
        "mimeType!='application/vnd.google-apps.folder'",
        `'${folderId}' in parents`,
        "trashed=false",
      ].join(" and "),
      fields: "files(id, name, mimeType)",
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "drive",
      driveId: sharedDriveId,
    });
    const files = res.data.files ?? [];
    return files
      .filter((f) => !!f.id && !!f.name)
      .map((f) => ({
        id: f.id as string,
        name: f.name as string,
        mimeType: f.mimeType || "",
      }));
  } catch (e) {
    console.warn(
      `[taskTemplates.listFilesInFolder] failed for folder=${folderId}:`,
      e instanceof Error ? e.message : String(e),
    );
    return [];
  }
}
