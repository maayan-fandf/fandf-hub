/**
 * Sheet-backed storage for chain templates. Read/write the
 * `ChainTemplates` tab on the SHEET_ID_COMMENTS spreadsheet so admins
 * can manage templates via the /admin/chain-templates UI without
 * code changes.
 *
 * Tab schema:
 *   id                       — kebab-case English (stable; URL-safe)
 *   label                    — Hebrew display label
 *   default_umbrella_title   — Pre-fill for umbrella title field
 *   steps_json               — JSON array of {title, department?, assigneeHint?}
 *   created_at               — ISO timestamp
 *   updated_at               — ISO timestamp
 *
 * The tab is created on first write if it doesn't exist (the
 * one-shot ensure-tab helper handles header bootstrap). Reads against
 * a missing tab return [] so the calling form falls back to the
 * hardcoded CHAIN_TEMPLATES seed transparently.
 *
 * Phase 10 of dependencies feature, 2026-05-03.
 */

import type { ChainTemplate, ChainStepTemplate } from "@/lib/chainTemplates";

const TAB = "ChainTemplates";
const HEADERS = [
  "id",
  "label",
  "default_umbrella_title",
  "steps_json",
  "created_at",
  "updated_at",
];

function nowIso(): string {
  return new Date().toISOString();
}

function colLetter(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/** List every template stored on the sheet. Returns [] when the tab
 *  is missing or empty (caller is expected to fall back to the
 *  hardcoded CHAIN_TEMPLATES seed in that case). */
export async function listChainTemplates(
  subjectEmail: string,
): Promise<ChainTemplate[]> {
  const { sheetsClient } = await import("@/lib/sa");
  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_COMMENTS");

  let values: unknown[][] = [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: TAB,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    values = (res.data.values ?? []) as unknown[][];
  } catch {
    // Tab doesn't exist — caller falls back to hardcoded seed.
    return [];
  }

  if (values.length < 2) return [];
  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const idx = (name: string) => headers.indexOf(name);
  const iId = idx("id");
  const iLabel = idx("label");
  const iDefault = idx("default_umbrella_title");
  const iSteps = idx("steps_json");
  if (iId < 0 || iLabel < 0 || iDefault < 0 || iSteps < 0) return [];

  const out: ChainTemplate[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const id = String(row[iId] ?? "").trim();
    if (!id) continue;
    let parsedSteps: ChainStepTemplate[] = [];
    try {
      const raw = row[iSteps];
      if (typeof raw === "string" && raw.trim()) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          parsedSteps = parsed
            .filter(
              (s: unknown): s is Record<string, unknown> =>
                !!s &&
                typeof s === "object" &&
                typeof (s as Record<string, unknown>).title === "string",
            )
            .map((s) => {
              const dept = s.department;
              const hint = s.assigneeHint;
              return {
                title: String(s.title ?? ""),
                department: typeof dept === "string" ? dept : undefined,
                assigneeHint: typeof hint === "string" ? hint : undefined,
              };
            });
        }
      }
    } catch {
      // Malformed steps_json — skip the steps but keep the template
      // visible so an admin can fix it via the editor.
      parsedSteps = [];
    }
    out.push({
      id,
      label: String(row[iLabel] ?? ""),
      defaultUmbrellaTitle: String(row[iDefault] ?? ""),
      steps: parsedSteps,
    });
  }
  return out;
}

/** Insert a new template OR update an existing one (matched by id).
 *  Returns the row number written to (1-indexed sheet row). */
export async function upsertChainTemplate(
  subjectEmail: string,
  template: ChainTemplate,
): Promise<{ ok: true; rowIndex: number; created: boolean }> {
  if (!template.id?.trim()) {
    throw new Error("upsertChainTemplate: id is required");
  }
  if (!template.label?.trim()) {
    throw new Error("upsertChainTemplate: label is required");
  }
  if (!Array.isArray(template.steps)) {
    throw new Error("upsertChainTemplate: steps must be an array");
  }
  await ensureTabExists(subjectEmail);

  const { sheetsClient } = await import("@/lib/sa");
  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_COMMENTS");
  const now = nowIso();

  // Read current rows to find by id (if exists).
  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: TAB,
  });
  const values = (cur.data.values ?? []) as unknown[][];
  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const cellByHeader = (row: unknown[], h: string): string => {
    const i = headers.indexOf(h);
    return i < 0 ? "" : String(row[i] ?? "");
  };
  let existingRowIndex = -1; // 0-indexed within `values`
  let existingCreatedAt = "";
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    if (cellByHeader(row, "id") === template.id) {
      existingRowIndex = i;
      existingCreatedAt = cellByHeader(row, "created_at");
      break;
    }
  }

  const stepsJson = JSON.stringify(
    template.steps.map((s) => ({
      title: s.title,
      department: s.department ?? "",
      assigneeHint: s.assigneeHint ?? "",
    })),
  );

  const cells: Record<string, string> = {
    id: template.id,
    label: template.label,
    default_umbrella_title: template.defaultUmbrellaTitle ?? "",
    steps_json: stepsJson,
    created_at: existingCreatedAt || now,
    updated_at: now,
  };
  const rowValues = HEADERS.map((h) => cells[h] ?? "");

  if (existingRowIndex >= 0) {
    const sheetRow = existingRowIndex + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId,
      range: `${TAB}!A${sheetRow}:${colLetter(HEADERS.length)}${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [rowValues] },
    });
    return { ok: true, rowIndex: sheetRow, created: false };
  }
  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId: ssId,
    range: TAB,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [rowValues] },
  });
  // Sheets returns the updated range like "ChainTemplates!A5:F5" —
  // parse out the row number for the response.
  const updatedRange = appendRes.data.updates?.updatedRange ?? "";
  const m = updatedRange.match(/(\d+):/);
  const rowIndex = m ? parseInt(m[1], 10) : values.length + 1;
  return { ok: true, rowIndex, created: true };
}

/** Delete a template by id. Returns true if the template was found
 *  and removed, false if it didn't exist. Implemented as a row clear
 *  + content-shift at the API level (Sheets v4 deleteDimension is
 *  the cleaner primitive but requires the numeric sheet ID; the
 *  cleared row would otherwise leave a blank line — we accept that
 *  and let admins re-tidy via Sheets if they care). */
export async function deleteChainTemplate(
  subjectEmail: string,
  id: string,
): Promise<{ ok: true; deleted: boolean }> {
  if (!id?.trim()) throw new Error("deleteChainTemplate: id required");

  const { sheetsClient } = await import("@/lib/sa");
  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_COMMENTS");

  const cur = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: TAB,
  });
  const values = (cur.data.values ?? []) as unknown[][];
  if (values.length < 2) return { ok: true, deleted: false };
  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const iId = headers.indexOf("id");
  if (iId < 0) return { ok: true, deleted: false };

  let foundRow = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i]?.[iId] ?? "").trim() === id) {
      foundRow = i + 1; // 1-indexed sheet row
      break;
    }
  }
  if (foundRow < 0) return { ok: true, deleted: false };

  // Use deleteDimension via batchUpdate so the row is fully removed
  // (no blank gap). Requires the numeric sheet ID — fetch it once.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: ssId,
    fields: "sheets(properties(sheetId,title))",
  });
  const sheetMeta = (meta.data.sheets ?? []).find(
    (s) => s.properties?.title === TAB,
  );
  const numericSheetId = sheetMeta?.properties?.sheetId;
  if (numericSheetId == null) {
    throw new Error(`deleteChainTemplate: sheet ${TAB} not found`);
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: numericSheetId,
              dimension: "ROWS",
              startIndex: foundRow - 1, // 0-indexed
              endIndex: foundRow, // exclusive
            },
          },
        },
      ],
    },
  });
  return { ok: true, deleted: true };
}

/** Create the ChainTemplates tab (with header row) if it doesn't
 *  exist yet. Idempotent — re-running after success is a no-op. */
async function ensureTabExists(subjectEmail: string): Promise<void> {
  const { sheetsClient } = await import("@/lib/sa");
  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_COMMENTS");

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: ssId,
    fields: "sheets(properties(title))",
  });
  const exists = (meta.data.sheets ?? []).some(
    (s) => s.properties?.title === TAB,
  );
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: TAB } } }],
    },
  });
  // Write the header row.
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `${TAB}!A1:${colLetter(HEADERS.length)}1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
}
