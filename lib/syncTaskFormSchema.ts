/**
 * Reconciler — keeps the TaskFormSchema sheet in sync with the Drive
 * `סכמות משימה/<Dept>/<Kind>/` hierarchy.
 *
 * The sheet and the Drive tree both define which (department, kind)
 * pairs the new-task form should offer. Either side can be edited
 * independently — the admin might add a row via /admin/task-form-
 * schema, OR they might create a kind subfolder in Drive UI. This
 * reconciler is the bridge: a single call merges Drive → Sheet so
 * both reflect the same set of pairs.
 *
 * Drive layout (the source of truth for kind names):
 *
 *   <Tasks Shared Drive>/סכמות משימה/<Dept>/<Kind>/
 *
 * Each `<Kind>/` is a folder; the schema sheet's `template_doc_id`
 * column gets populated with the FOLDER id. The new-task form then
 * lists files inside that folder for the issuer to pick a template
 * from. (Pre-restructure rows that bind a single FILE id are still
 * supported by the resolver — see lib/taskTemplates.ts — but the
 * reconciler emits folder ids going forward.)
 *
 * Direction is **Drive → Sheet only.** Sheet rows that don't
 * correspond to a Drive file are kept verbatim — admins use them for
 * pairs that don't (yet) have an inline template; deleting them on
 * Drive's behalf would be destructive. Drive files that don't
 * correspond to a sheet row get appended.
 *
 * Sheet writes go through `replaceTaskFormSchema` (full-replacement
 * single shot) so the editor's pending-changes invariant stays true.
 *
 * NEVER deletes Drive files. NEVER deletes sheet rows. The reconciler
 * is purely additive + rename-tracking.
 */

import { driveClient, driveFolderOwner } from "@/lib/sa";
import {
  findChildFolderByName,
  getTasksSharedDriveId,
} from "@/lib/driveFolders";
import {
  listTaskFormSchemaRows,
  replaceTaskFormSchema,
  type TaskFormSchemaRow,
} from "@/lib/taskFormSchema";
import { TEMPLATES_ROOT_NAME } from "@/lib/taskTemplates";

export type SyncResult = {
  /** Newly-appended rows (Drive item had no matching sheet row). */
  added: number;
  /** Rows whose `kind` was updated because the Drive file was renamed
   *  but its id still matched. */
  renamed: number;
  /** Rows that gained a `templateDocId` because a Drive file matched
   *  by (dept, kind) name. */
  bound: number;
  /** Rows that were already in agreement — no change. */
  unchanged: number;
  /** Sheet rows kept verbatim because their `templateDocId` doesn't
   *  point to any Drive file (or no `templateDocId` set + no Drive
   *  file matches by name). Useful as a "manual rows" count. */
  manualPreserved: number;
  /** Total Drive files scanned across all dept folders. */
  driveItemsScanned: number;
  /** Whether the sheet was actually rewritten (false when nothing
   *  changed — saves a Sheets API write call). */
  sheetRewritten: boolean;
  errors: string[];
};

type DriveItem = {
  /** Containing department folder name. */
  dept: string;
  /** Kind folder name. */
  kind: string;
  /** Drive folder id of the kind folder (gets stored in the sheet's
   *  template_doc_id column). */
  folderId: string;
};

async function listAllDriveTemplates(
  subjectEmail: string,
): Promise<DriveItem[]> {
  const sharedDriveId = getTasksSharedDriveId();
  const drive = driveClient(driveFolderOwner() || subjectEmail);

  const rootId = await findChildFolderByName(
    drive,
    sharedDriveId,
    TEMPLATES_ROOT_NAME,
    sharedDriveId,
  );
  if (!rootId) return [];

  // List department subfolders.
  const deptRes = await drive.files.list({
    q: [
      "mimeType='application/vnd.google-apps.folder'",
      `'${rootId}' in parents`,
      "trashed=false",
    ].join(" and "),
    fields: "files(id, name)",
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: sharedDriveId,
  });
  const depts = deptRes.data.files ?? [];

  // For each dept folder, list its kind SUB-FOLDERS. Each kind folder
  // becomes one row on the schema sheet; its files get listed by the
  // form-side picker via /api/worktasks/template-options. We run the
  // dept-level listings in parallel — only ~7 depts, cheap.
  const items: DriveItem[] = [];
  await Promise.all(
    depts.map(async (deptFolder) => {
      if (!deptFolder.id || !deptFolder.name) return;
      try {
        const kindRes = await drive.files.list({
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
        const kinds = kindRes.data.files ?? [];
        for (const k of kinds) {
          if (!k.id || !k.name) continue;
          items.push({
            dept: deptFolder.name,
            kind: k.name,
            folderId: k.id,
          });
        }
      } catch (e) {
        // One dept folder failure shouldn't poison the whole sync.
        console.warn(
          `[syncTaskFormSchema] list ${deptFolder.name} failed:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }),
  );

  return items;
}

export async function reconcileSchemaWithDrive(
  subjectEmail: string,
): Promise<SyncResult> {
  const result: SyncResult = {
    added: 0,
    renamed: 0,
    bound: 0,
    unchanged: 0,
    manualPreserved: 0,
    driveItemsScanned: 0,
    sheetRewritten: false,
    errors: [],
  };

  let driveItems: DriveItem[] = [];
  try {
    driveItems = await listAllDriveTemplates(subjectEmail);
  } catch (e) {
    result.errors.push(
      `listAllDriveTemplates: ${e instanceof Error ? e.message : String(e)}`,
    );
    return result;
  }
  result.driveItemsScanned = driveItems.length;

  let sheetRows: TaskFormSchemaRow[] = [];
  try {
    sheetRows = await listTaskFormSchemaRows(subjectEmail);
  } catch (e) {
    result.errors.push(
      `listTaskFormSchemaRows: ${e instanceof Error ? e.message : String(e)}`,
    );
    return result;
  }

  // Working copy. Mutations happen here; we only POST back if changed.
  const updated: TaskFormSchemaRow[] = sheetRows.map((r) => ({
    department: r.department,
    kind: r.kind,
    templateDocId: r.templateDocId || "",
  }));

  // Index by template_doc_id (which now stores folder ids) for rename
  // + dup detection.
  const rowByBindingId = new Map<string, number>();
  updated.forEach((r, idx) => {
    if (r.templateDocId) rowByBindingId.set(r.templateDocId, idx);
  });
  // Index by (dept|kind) for "bind by name" matches.
  const keyOf = (dept: string, kind: string) =>
    `${dept.trim()}|${kind.trim()}`;
  const rowByKey = new Map<string, number>();
  updated.forEach((r, idx) => rowByKey.set(keyOf(r.department, r.kind), idx));

  let mutated = false;

  for (const item of driveItems) {
    // Case 1: Drive folder id already bound on a sheet row → just
    // check if the kind folder was renamed in Drive (so the row's
    // kind text follows along).
    const byIdIdx = rowByBindingId.get(item.folderId);
    if (byIdIdx !== undefined) {
      const row = updated[byIdIdx];
      if (
        row.department.trim() !== item.dept.trim() ||
        row.kind.trim() !== item.kind.trim()
      ) {
        rowByKey.delete(keyOf(row.department, row.kind));
        row.department = item.dept;
        row.kind = item.kind;
        rowByKey.set(keyOf(item.dept, item.kind), byIdIdx);
        result.renamed++;
        mutated = true;
      } else {
        result.unchanged++;
      }
      continue;
    }

    // Case 2: (dept, kind) name match, no folder-id match yet. Bind
    // the row to this folder id. This also covers the migration case
    // where rows have stale legacy file ids — we overwrite with the
    // canonical kind-folder id so the resolver picks up the new
    // structure.
    const byKeyIdx = rowByKey.get(keyOf(item.dept, item.kind));
    if (byKeyIdx !== undefined) {
      const row = updated[byKeyIdx];
      if (row.templateDocId === item.folderId) {
        result.unchanged++;
      } else {
        // Drop the previous binding from the index BEFORE replacing
        // so a stale id can't accidentally re-collide on the next
        // iteration.
        if (row.templateDocId) rowByBindingId.delete(row.templateDocId);
        row.templateDocId = item.folderId;
        rowByBindingId.set(item.folderId, byKeyIdx);
        result.bound++;
        mutated = true;
      }
      continue;
    }

    // Case 3: Neither folder id nor name match — append new row.
    const newRow: TaskFormSchemaRow = {
      department: item.dept,
      kind: item.kind,
      templateDocId: item.folderId,
    };
    updated.push(newRow);
    const newIdx = updated.length - 1;
    rowByBindingId.set(item.folderId, newIdx);
    rowByKey.set(keyOf(item.dept, item.kind), newIdx);
    result.added++;
    mutated = true;
  }

  // Count manual rows (no Drive folder match) for telemetry.
  const driveFolderIds = new Set(driveItems.map((d) => d.folderId));
  const driveKeys = new Set(driveItems.map((d) => keyOf(d.dept, d.kind)));
  for (const r of updated) {
    if (r.templateDocId && driveFolderIds.has(r.templateDocId)) continue;
    if (driveKeys.has(keyOf(r.department, r.kind))) continue;
    result.manualPreserved++;
  }

  if (!mutated) {
    return result;
  }

  // Persist. The replaceTaskFormSchema helper clears + rewrites the
  // sheet's data area atomically and invalidates the schema cache.
  try {
    await replaceTaskFormSchema(subjectEmail, updated);
    result.sheetRewritten = true;
  } catch (e) {
    result.errors.push(
      `replaceTaskFormSchema: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return result;
}
