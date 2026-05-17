/**
 * Pricing ledger — one row per created task, appended to the
 * self-provisioning `PricingLog` tab on the Comments spreadsheet.
 *
 * This is the billing-export half of "store the price BOTH on the task
 * row AND in a ledger". The price also lives on the task row (the
 * `price` column); this tab is the flat, finance-friendly accumulation
 * you can pivot/export without touching the tasks data.
 *
 * HARD RULE: telemetry-style — must never slow down or break task
 * creation. Callers fire-and-forget (`void logTaskPricing(...)`), every
 * path swallows its own errors, and a missing tab self-provisions
 * (addSheet + header) then retries once. Mirrors lib/aiToolLog.
 *
 * Tab columns:
 *   created_at_il | task_id | company | project | departments |
 *   kind | price | created_by
 */

import { sheetsClient } from "@/lib/sa";

const TAB = "PricingLog";
const HEADER = [
  "created_at_il",
  "task_id",
  "company",
  "project",
  "departments",
  "kind",
  "price",
  "created_by",
];

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function nowIsraelString(): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

let tabEnsured = false;

async function ensureTab(
  sheets: ReturnType<typeof sheetsClient>,
  spreadsheetId: string,
): Promise<boolean> {
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${TAB}!A1:H1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
    tabEnsured = true;
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/already exists/i.test(msg)) {
      tabEnsured = true;
      return true;
    }
    console.log("[pricingLog] could not provision tab (non-fatal):", msg);
    return false;
  }
}

export type TaskPricingEntry = {
  subjectEmail: string;
  taskId: string;
  company: string;
  project: string;
  departments: string[];
  kind: string;
  /** Resolved/entered price. null/undefined → logged as "" (a task
   *  created without a price still gets a ledger row for completeness). */
  price: number | null | undefined;
  createdBy: string;
};

/** Append one ledger row. Never throws. Not awaited by the create path. */
export async function logTaskPricing(entry: TaskPricingEntry): Promise<void> {
  try {
    const spreadsheetId = envOrThrow("SHEET_ID_COMMENTS");
    const sheets = sheetsClient(entry.subjectEmail);
    const row = [
      nowIsraelString(),
      entry.taskId,
      entry.company,
      entry.project,
      (entry.departments || []).join(", "),
      entry.kind,
      entry.price == null ? "" : entry.price,
      entry.createdBy,
    ];
    const doAppend = () =>
      sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${TAB}!A:H`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [row] },
      });
    try {
      await doAppend();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!tabEnsured && /Unable to parse range|not found/i.test(msg)) {
        const created = await ensureTab(sheets, spreadsheetId);
        if (created) await doAppend();
      } else {
        throw e;
      }
    }
  } catch (e) {
    console.log(
      "[pricingLog] append failed (non-fatal):",
      e instanceof Error ? e.message : String(e),
    );
  }
}
