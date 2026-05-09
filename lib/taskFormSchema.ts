/**
 * Task-form schema — controls the מחלקות + nested סוג options on
 * /tasks/new. Source of truth: the "TaskFormSchema" tab on the
 * Comments spreadsheet (SHEET_ID_COMMENTS), with three columns:
 *
 *   מחלקה | סוג | תבנית
 *
 * Each row pairs one department with one of its kinds, plus an
 * optional Google Doc template ID (the "תבנית" column). When set,
 * the new-task form will auto-copy that template into the task's
 * Drive folder when an issuer picks the matching (dept, kind). When
 * blank, the form falls back to discovery via Drive folder convention
 * (סכמות משימה / <Dept> / <Kind>) — see lib/taskTemplates.ts.
 *
 * The תבנית column is optional and back-compatible — old 2-column
 * sheets continue to work, with templateDocId defaulting to ''.
 *
 * The tab is created + seeded by scripts/seed-task-form-schema.mjs;
 * after that, admins edit it via the sheet directly OR via the
 * /admin/task-form-schema page (Phase 3c).
 *
 * Caching: 5 min in-process, mirrors lib/userPrefs.ts. Admin edits
 * via the editor invalidate via the same write path.
 */

import { sheetsClient } from "@/lib/sa";

const TAB = "TaskFormSchema";

export type TaskFormSchemaRow = {
  department: string;
  kind: string;
  /** Optional — Google Drive file id of a Doc/Sheet template that the
   *  new-task form should copy into the task folder when an issuer
   *  picks this (department, kind) pair. Empty string means "no
   *  explicit binding"; the form will fall back to folder-name
   *  discovery via lib/taskTemplates.ts. */
  templateDocId?: string;
};

export type TaskFormSchema = {
  /** Distinct departments in sheet order (after de-dup). */
  departments: string[];
  /** All distinct kinds across the schema (used as a fallback when
   *  no department is selected, or as the union when multiple are). */
  allKinds: string[];
  /** kind values per department, preserving sheet order. */
  kindsByDepartment: Record<string, string[]>;
  /** templateDocId per (department, kind). Only populated for rows
   *  that have a non-empty value in the תבנית column. The new-task
   *  form looks up `templatesByDeptAndKind[dept]?.[kind]` and falls
   *  back to folder-name discovery if missing. */
  templatesByDeptAndKind: Record<string, Record<string, string>>;
  /** True when the sheet is empty / missing. UI falls back to a
   *  hardcoded shape in that case so the form still works. */
  isEmpty: boolean;
};

const CACHE: { value: TaskFormSchema | null; expiresAt: number } = {
  value: null,
  expiresAt: 0,
};
const TTL_MS = 5 * 60 * 1000;

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/** Empty schema returned when the sheet is missing / empty. The form
 *  uses its own legacy KINDS list in that case. */
function emptySchema(): TaskFormSchema {
  return {
    departments: [],
    allKinds: [],
    kindsByDepartment: {},
    templatesByDeptAndKind: {},
    isEmpty: true,
  };
}

/** Read the schema. Reads the whole tab (it's tiny — at most a few
 *  hundred rows even when generously seeded) and indexes it. */
export async function getTaskFormSchema(
  subjectEmail: string,
): Promise<TaskFormSchema> {
  if (CACHE.value && CACHE.expiresAt > Date.now()) {
    return CACHE.value;
  }

  let schema: TaskFormSchema = emptySchema();
  try {
    const sheets = sheetsClient(subjectEmail);
    const ssId = envOrThrow("SHEET_ID_COMMENTS");
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: TAB,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const values = (res.data.values ?? []) as unknown[][];
    if (values.length < 2) {
      schema = emptySchema();
    } else {
      const headers = (values[0] as unknown[]).map((h) =>
        String(h ?? "").trim(),
      );
      const iDept = headers.findIndex(
        (h) => h === "מחלקה" || h.toLowerCase() === "department",
      );
      const iKind = headers.findIndex(
        (h) => h === "סוג" || h.toLowerCase() === "kind",
      );
      const iTemplate = headers.findIndex(
        (h) => h === "תבנית" || h.toLowerCase() === "template_doc_id",
      );
      if (iDept >= 0 && iKind >= 0) {
        const rows: TaskFormSchemaRow[] = [];
        for (let r = 1; r < values.length; r++) {
          const dept = String(values[r][iDept] ?? "").trim();
          const kind = String(values[r][iKind] ?? "").trim();
          if (!dept || !kind) continue;
          const templateDocId =
            iTemplate >= 0
              ? String(values[r][iTemplate] ?? "").trim()
              : "";
          rows.push({ department: dept, kind, templateDocId });
        }
        schema = indexRows(rows);
      }
    }
  } catch (e) {
    // Tab missing or read failed — fall through to empty.
    console.log(
      "[taskFormSchema] read failed, returning empty:",
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

/** Read every row as-is (preserving order, including duplicates).
 *  Used by the admin editor to render the table. */
export async function listTaskFormSchemaRows(
  subjectEmail: string,
): Promise<TaskFormSchemaRow[]> {
  try {
    const sheets = sheetsClient(subjectEmail);
    const ssId = envOrThrow("SHEET_ID_COMMENTS");
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: TAB,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const values = (res.data.values ?? []) as unknown[][];
    if (values.length < 2) return [];
    const headers = (values[0] as unknown[]).map((h) => String(h ?? "").trim());
    const iDept = headers.findIndex(
      (h) => h === "מחלקה" || h.toLowerCase() === "department",
    );
    const iKind = headers.findIndex(
      (h) => h === "סוג" || h.toLowerCase() === "kind",
    );
    const iTemplate = headers.findIndex(
      (h) => h === "תבנית" || h.toLowerCase() === "template_doc_id",
    );
    if (iDept < 0 || iKind < 0) return [];
    const rows: TaskFormSchemaRow[] = [];
    for (let r = 1; r < values.length; r++) {
      const dept = String(values[r][iDept] ?? "").trim();
      const kind = String(values[r][iKind] ?? "").trim();
      if (!dept || !kind) continue;
      const templateDocId =
        iTemplate >= 0 ? String(values[r][iTemplate] ?? "").trim() : "";
      rows.push({ department: dept, kind, templateDocId });
    }
    return rows;
  } catch (e) {
    console.log(
      "[taskFormSchema] listRows failed:",
      e instanceof Error ? e.message : String(e),
    );
    return [];
  }
}

/** Replace the entire schema with a fresh set of rows. Wipes the
 *  data area below the header and writes the new rows. Single-shot
 *  semantics — admin editor sends the full table on every save. */
export async function replaceTaskFormSchema(
  subjectEmail: string,
  rows: TaskFormSchemaRow[],
): Promise<void> {
  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_COMMENTS");
  // Clear data rows (rows 2+) across all 3 columns. The C column was
  // added in 2026-05 for the תבנית binding — clearing it here means
  // existing 2-column sheets that pick up an admin save will gain the
  // new header at row 1 and start round-tripping the value cleanly.
  await sheets.spreadsheets.values.clear({
    spreadsheetId: ssId,
    range: `${TAB}!A2:C`,
  });
  // Re-write headers + new rows in one update so a slow round-trip
  // doesn't briefly leave the sheet headerless.
  const data: (string | number | boolean)[][] = [
    ["מחלקה", "סוג", "תבנית"],
    ...rows.map(
      (r) =>
        [
          r.department,
          r.kind,
          r.templateDocId ?? "",
        ] as (string | number | boolean)[],
    ),
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `${TAB}!A1:C${data.length}`,
    valueInputOption: "RAW",
    requestBody: { values: data },
  });
  invalidateTaskFormSchema();
}

function indexRows(rows: TaskFormSchemaRow[]): TaskFormSchema {
  const departments: string[] = [];
  const allKinds: string[] = [];
  const kindsByDepartment: Record<string, string[]> = {};
  const templatesByDeptAndKind: Record<string, Record<string, string>> = {};
  const seenDept = new Set<string>();
  const seenKind = new Set<string>();
  for (const r of rows) {
    if (!seenDept.has(r.department)) {
      seenDept.add(r.department);
      departments.push(r.department);
    }
    if (!seenKind.has(r.kind)) {
      seenKind.add(r.kind);
      allKinds.push(r.kind);
    }
    const list = kindsByDepartment[r.department] ?? [];
    if (!list.includes(r.kind)) list.push(r.kind);
    kindsByDepartment[r.department] = list;
    const tpl = (r.templateDocId ?? "").trim();
    if (tpl) {
      const inner = templatesByDeptAndKind[r.department] ?? {};
      inner[r.kind] = tpl;
      templatesByDeptAndKind[r.department] = inner;
    }
  }
  return {
    departments,
    allKinds,
    kindsByDepartment,
    templatesByDeptAndKind,
    isEmpty: rows.length === 0,
  };
}
