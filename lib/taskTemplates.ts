/**
 * Task-kind templates — resolves a Google Doc/Sheet template for a
 * given (department, kind) pair so the new-task form can copy it into
 * the issuer's draft folder.
 *
 * Two-tier resolution:
 *
 *   1. **Explicit:** if the TaskFormSchema sheet has a `template_doc_id`
 *      value for the (department, kind) row, that wins. Set via the
 *      /admin/task-form-schema editor's "תבנית" cell.
 *   2. **Folder convention:** otherwise, walk the Shared Drive at
 *      `<shared>/סכמות משימה/<department>/<kind>` and pick the first
 *      matching file. The kind name is matched case-sensitively against
 *      the file's display name (with optional `.gdoc`/`.gsheet`/`.gslides`
 *      extension stripped — Drive doesn't actually use those, but users
 *      sometimes rename files including them).
 *
 * The folder convention lets non-developer admins drop new templates
 * into Drive without touching the schema sheet — they only need the
 * folder/file naming to match. The explicit override exists so
 * cross-department reuse (one template, multiple kinds) and renames
 * are robust against file moves.
 *
 * Per-request memoization via React's `cache()` keeps the Drive walk
 * cheap when both /tasks/new + /api/worktasks/draft-template hit the
 * resolver in the same request lifecycle. We deliberately AVOID
 * unstable_cache here — see feedback_unstable_cache_multi_instance.md.
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
 *  drop templates into the per-dept subfolders by hand thereafter. */
export const TEMPLATES_ROOT_NAME = "סכמות משימה";

export type TemplateRef = {
  /** Drive file id of the template (Doc, Sheet, or Slides). */
  docId: string;
  /** Display name of the template file, for surfacing in the UI. */
  docName: string;
  /** Where the binding came from — useful for admin debugging when a
   *  template doesn't appear as expected. */
  source: "schema" | "folder";
};

/**
 * Returns the template doc for `(department, kind)` if one exists,
 * `null` otherwise. Schema-explicit binding wins; falls back to a
 * Drive folder walk under `<shared>/סכמות משימה/<department>`.
 *
 * The schema is expected to be the result of `getTaskFormSchema` and
 * may legitimately be `null` (e.g. when the sheet read fails) — in
 * that case we still try the folder convention so a misbehaving sheet
 * doesn't take the whole feature down.
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
    const docName = await fetchFileName(subjectEmail, schemaId).catch(() => "");
    return { docId: schemaId, docName: docName || knd, source: "schema" };
  }

  // 2) Folder convention.
  const folderHit = await findTemplateInFolder(subjectEmail, dept, knd);
  return folderHit;
}

async function findTemplateInFolder(
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
    // List files in the dept folder. We want NON-folder children
    // matching the kind name. The schema kind is the source of
    // truth — file names that strip an extension still match.
    const res = await drive.files.list({
      q: [
        "mimeType!='application/vnd.google-apps.folder'",
        `'${deptFolderId}' in parents`,
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
    if (files.length === 0) return null;
    const wanted = kind.trim();
    // Match exactly (with optional Drive-style extension trimmed). The
    // first match wins; if admins drop two files with the same kind
    // they're warned by the sheet not lining up anyway.
    const hit = files.find((f) => {
      const n = String(f.name ?? "").trim();
      if (!n) return false;
      if (n === wanted) return true;
      const stripped = n.replace(/\.(gdoc|gsheet|gslides|docx|xlsx|pptx)$/i, "");
      return stripped === wanted;
    });
    if (!hit?.id) return null;
    return {
      docId: hit.id,
      docName: hit.name || wanted,
      source: "folder",
    };
  } catch (e) {
    console.warn(
      "[taskTemplates.findTemplateInFolder] failed:",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

/** Resolve a Drive file's display name. Best-effort; empty string on
 *  failure so the caller can fall back to the kind label. */
async function fetchFileName(
  subjectEmail: string,
  fileId: string,
): Promise<string> {
  try {
    const drive = driveClient(driveFolderOwner() || subjectEmail);
    const res = await drive.files.get({
      fileId,
      fields: "id, name",
      supportsAllDrives: true,
    });
    return res.data.name || "";
  } catch (e) {
    console.warn(
      `[taskTemplates.fetchFileName] failed for fileId=${fileId}:`,
      e instanceof Error ? e.message : String(e),
    );
    return "";
  }
}
