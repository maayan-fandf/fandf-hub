/**
 * Task-form schema — controls the מחלקות + nested סוג options on
 * /tasks/new. Source of truth: the Drive folder hierarchy at
 *
 *   <Tasks Shared Drive>/סכמות משימה/<Dept>/<Kind>/
 *
 * Each kind folder = one (department, kind) pair. Files inside the
 * kind folder are the templates the new-task form's picker offers.
 *
 * Why Drive (and not a sheet)? Both kinds AND templates already live
 * in Drive. Maintaining a parallel sheet copy meant we needed a
 * sync — and any sync introduces drift bugs. With Drive as the
 * single source of truth, adding a kind = creating a folder, deleting
 * a kind = deleting a folder; no reconciler needed.
 *
 * The legacy `TaskFormSchema` tab on SHEET_ID_COMMENTS is left in
 * place but unused. Future cleanup can drop the tab.
 *
 * Caching: 5 min in-process to keep page-load latency low. Admin
 * mutations (creating folders via /api/admin/task-form-folder)
 * invalidate the cache. Server components also rely on Next's
 * per-request `cache()` for further dedup within a single render.
 */

import { driveClient, driveFolderOwner } from "@/lib/sa";
import {
  findChildFolderByName,
  getTasksSharedDriveId,
} from "@/lib/driveFolders";
import { TEMPLATES_ROOT_NAME } from "@/lib/taskTemplates";

/** Legacy field name retained for backwards compat with anything that
 *  destructures TaskFormSchemaRow. After the 2026-05-09 restructure
 *  the value is the kind FOLDER id (was a single file id pre-split).
 *  Use `kindFolderId` going forward. */
export type TaskFormSchemaRow = {
  department: string;
  kind: string;
  /** @deprecated alias for kindFolderId — kept until call sites migrate. */
  templateDocId?: string;
  kindFolderId?: string;
};

export type TaskFormSchema = {
  /** Distinct departments in folder order. */
  departments: string[];
  /** All distinct kinds across the schema (used as a fallback when
   *  no department is selected, or as the union when multiple are). */
  allKinds: string[];
  /** kind values per department, preserving folder order. */
  kindsByDepartment: Record<string, string[]>;
  /** Kind folder id per (department, kind). Used by lib/taskTemplates.ts
   *  to list the picker files inside the kind folder. */
  templatesByDeptAndKind: Record<string, Record<string, string>>;
  /** True when the Drive root has no department folders yet. UI
   *  falls back to a hardcoded shape in that case so the form still
   *  renders something. */
  isEmpty: boolean;
};

const CACHE: { value: TaskFormSchema | null; expiresAt: number } = {
  value: null,
  expiresAt: 0,
};
const TTL_MS = 5 * 60 * 1000;

function emptySchema(): TaskFormSchema {
  return {
    departments: [],
    allKinds: [],
    kindsByDepartment: {},
    templatesByDeptAndKind: {},
    isEmpty: true,
  };
}

/**
 * Walks the templates folder tree once and indexes the result. Cached
 * 5 min in-process.
 */
export async function getTaskFormSchema(
  subjectEmail: string,
): Promise<TaskFormSchema> {
  if (CACHE.value && CACHE.expiresAt > Date.now()) {
    return CACHE.value;
  }

  let schema: TaskFormSchema = emptySchema();
  try {
    schema = await readSchemaFromDrive(subjectEmail);
  } catch (e) {
    console.log(
      "[taskFormSchema] Drive read failed, returning empty:",
      e instanceof Error ? e.message : String(e),
    );
  }

  CACHE.value = schema;
  CACHE.expiresAt = Date.now() + TTL_MS;
  return schema;
}

export function invalidateTaskFormSchema(): void {
  CACHE.value = null;
  CACHE.expiresAt = 0;
}

async function readSchemaFromDrive(
  subjectEmail: string,
): Promise<TaskFormSchema> {
  const sharedDriveId = getTasksSharedDriveId();
  const drive = driveClient(driveFolderOwner() || subjectEmail);

  const rootId = await findChildFolderByName(
    drive,
    sharedDriveId,
    TEMPLATES_ROOT_NAME,
    sharedDriveId,
  );
  if (!rootId) {
    return emptySchema();
  }

  // List department subfolders.
  const deptRes = await drive.files.list({
    q: [
      "mimeType='application/vnd.google-apps.folder'",
      `'${rootId}' in parents`,
      "trashed=false",
    ].join(" and "),
    fields: "files(id, name)",
    pageSize: 500,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: sharedDriveId,
  });
  const depts = (deptRes.data.files ?? []).filter(
    (f) => !!f.id && !!f.name,
  );
  if (depts.length === 0) {
    return emptySchema();
  }

  // For each dept, list its kind subfolders. Run in parallel — small
  // dept count keeps this cheap.
  const departments: string[] = [];
  const allKindsSet = new Set<string>();
  const kindsByDepartment: Record<string, string[]> = {};
  const templatesByDeptAndKind: Record<string, Record<string, string>> = {};

  await Promise.all(
    depts.map(async (deptFolder) => {
      const dept = deptFolder.name as string;
      try {
        const kindsRes = await drive.files.list({
          q: [
            "mimeType='application/vnd.google-apps.folder'",
            `'${deptFolder.id}' in parents`,
            "trashed=false",
          ].join(" and "),
          fields: "files(id, name)",
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          corpora: "drive",
          driveId: sharedDriveId,
        });
        const kindFolders = (kindsRes.data.files ?? []).filter(
          (f) => !!f.id && !!f.name,
        );
        const kindNames: string[] = [];
        const inner: Record<string, string> = {};
        for (const f of kindFolders) {
          const name = f.name as string;
          kindNames.push(name);
          allKindsSet.add(name);
          inner[name] = f.id as string;
        }
        kindsByDepartment[dept] = kindNames;
        templatesByDeptAndKind[dept] = inner;
        departments.push(dept);
      } catch (e) {
        // Per-dept failure shouldn't poison the whole schema. Surface
        // the dept folder anyway with no kinds so admin can see it.
        console.warn(
          `[taskFormSchema] list kinds for ${dept} failed:`,
          e instanceof Error ? e.message : String(e),
        );
        departments.push(dept);
        kindsByDepartment[dept] = [];
        templatesByDeptAndKind[dept] = {};
      }
    }),
  );

  // Stable display order: locale-sort departments. Kinds keep their
  // Drive-listing order within each dept (no second sort).
  departments.sort((a, b) => a.localeCompare(b, "he"));

  return {
    departments,
    allKinds: Array.from(allKindsSet),
    kindsByDepartment,
    templatesByDeptAndKind,
    isEmpty: departments.length === 0,
  };
}
