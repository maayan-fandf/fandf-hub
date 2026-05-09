/**
 * Reconciler — keeps the TaskFormSchema sheet in sync with the Drive
 * `סכמות משימה/<Dept>/<File>` hierarchy.
 *
 * The sheet and the Drive tree both define which (department, kind)
 * pairs the new-task form should offer. Either side can be edited
 * independently — the admin might add a row via /admin/task-form-
 * schema, OR they might drop a Google Doc into a dept folder via
 * Drive UI. This reconciler is the bridge: a single call merges
 * Drive → Sheet so both reflect the same set of pairs.
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

const DRIVE_EXTENSION_RE = /\.(gdoc|gsheet|gslides|docx|xlsx|pptx)$/i;

/** Strip Drive's display-extension if present so the kind label
 *  matches what an admin would see in the schema editor. */
function normalizeFileNameToKind(name: string): string {
  const trimmed = String(name || "").trim();
  return trimmed.replace(DRIVE_EXTENSION_RE, "");
}

type DriveItem = {
  /** Containing department folder name. */
  dept: string;
  /** File display name (post extension-strip). */
  kind: string;
  /** Drive file id. */
  docId: string;
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

  // For each dept folder, list non-folder children. Run in parallel —
  // 7-ish departments, cheap.
  const items: DriveItem[] = [];
  await Promise.all(
    depts.map(async (deptFolder) => {
      if (!deptFolder.id || !deptFolder.name) return;
      try {
        const filesRes = await drive.files.list({
          q: [
            "mimeType!='application/vnd.google-apps.folder'",
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
        const files = filesRes.data.files ?? [];
        for (const f of files) {
          if (!f.id || !f.name) continue;
          const kind = normalizeFileNameToKind(f.name);
          if (!kind) continue;
          items.push({
            dept: deptFolder.name,
            kind,
            docId: f.id,
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

  // Index by template_doc_id for rename + dup detection.
  const rowByDocId = new Map<string, number>();
  updated.forEach((r, idx) => {
    if (r.templateDocId) rowByDocId.set(r.templateDocId, idx);
  });
  // Index by (dept|kind) for "bind by name" matches.
  const keyOf = (dept: string, kind: string) =>
    `${dept.trim()}|${kind.trim()}`;
  const rowByKey = new Map<string, number>();
  updated.forEach((r, idx) => rowByKey.set(keyOf(r.department, r.kind), idx));

  let mutated = false;

  for (const item of driveItems) {
    // Case 1: Drive id already on a sheet row → check for rename.
    const byIdIdx = rowByDocId.get(item.docId);
    if (byIdIdx !== undefined) {
      const row = updated[byIdIdx];
      if (
        row.department.trim() !== item.dept.trim() ||
        row.kind.trim() !== item.kind.trim()
      ) {
        // Drop the old key from the index before mutating.
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

    // Case 2: No id match, but (dept, kind) name matches an existing
    // unbound row → bind the doc id to that row.
    const byKeyIdx = rowByKey.get(keyOf(item.dept, item.kind));
    if (byKeyIdx !== undefined) {
      const row = updated[byKeyIdx];
      if (!row.templateDocId) {
        row.templateDocId = item.docId;
        rowByDocId.set(item.docId, byKeyIdx);
        result.bound++;
        mutated = true;
      } else {
        // Row already has a different doc id bound — leave it alone
        // (admin's explicit binding wins over folder discovery).
        result.unchanged++;
      }
      continue;
    }

    // Case 3: Neither id nor name matches — new row.
    const newRow: TaskFormSchemaRow = {
      department: item.dept,
      kind: item.kind,
      templateDocId: item.docId,
    };
    updated.push(newRow);
    const newIdx = updated.length - 1;
    rowByDocId.set(item.docId, newIdx);
    rowByKey.set(keyOf(item.dept, item.kind), newIdx);
    result.added++;
    mutated = true;
  }

  // Count manual rows (no Drive file match) for telemetry.
  const driveDocIds = new Set(driveItems.map((d) => d.docId));
  const driveKeys = new Set(driveItems.map((d) => keyOf(d.dept, d.kind)));
  for (const r of updated) {
    if (r.templateDocId && driveDocIds.has(r.templateDocId)) continue;
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
