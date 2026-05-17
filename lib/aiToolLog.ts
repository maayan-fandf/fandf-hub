/**
 * Best-effort telemetry for the chat assistant's tool calls.
 *
 * One row per tool invocation, appended to the `ai_tool_log` tab on the
 * Comments spreadsheet (same workbook tasks live in — the signed-in
 * user already has write access there, so no extra grant). This is the
 * observability layer that turns "a user noticed the assistant got the
 * CRM funnel wrong" into a queryable record of which tool fired for
 * which question and whether it succeeded — so routing regressions
 * surface proactively instead of via bug reports.
 *
 * HARD RULE: this must never slow down or break the chat. Callers
 * fire-and-forget (`void logToolCall(...)`), every path swallows its
 * own errors, and a missing tab is tolerated (logged once to console,
 * never thrown). If the tab doesn't exist yet the append simply no-ops.
 *
 * The tab is self-provisioning: the first append after deploy finds it
 * missing, creates it with a header row, and retries once. No manual
 * setup, and the create path is just as swallowed as everything else.
 *
 * Tab columns:
 *   timestamp_il | user_email | subject_email | question |
 *   tool | args_json | ok | error | duration_ms
 */

import { sheetsClient } from "@/lib/sa";

const TAB = "ai_tool_log";
const MAX_QUESTION = 500;
const MAX_ARGS = 800;
const MAX_ERROR = 500;

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function nowIsraelString(): string {
  // e.g. "2026-05-17 14:32:09" in Asia/Jerusalem — sortable + readable.
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

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export type ToolLogEntry = {
  userEmail: string;
  subjectEmail: string;
  question: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  durationMs: number;
};

const HEADER = [
  "timestamp_il",
  "user_email",
  "subject_email",
  "question",
  "tool",
  "args_json",
  "ok",
  "error",
  "duration_ms",
];

// In-memory hint that the tab exists on this instance — skips the
// create attempt on the hot path once we've seen it. Not cross-instance
// (each App Hosting instance provisions independently); the addSheet
// "already exists" catch makes concurrent/repeat creates harmless.
let tabEnsured = false;

/** Best-effort create of the ai_tool_log tab + header row. Idempotent:
 *  addSheet on an existing title throws "already exists", which we
 *  treat as success. Fully swallowed. */
async function ensureTab(
  sheets: ReturnType<typeof sheetsClient>,
  spreadsheetId: string,
): Promise<boolean> {
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    });
    // Freshly created — lay down the header row.
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${TAB}!A1:I1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
    tabEnsured = true;
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/already exists/i.test(msg)) {
      tabEnsured = true; // someone else created it — fine
      return true;
    }
    console.log("[aiToolLog] could not provision tab (non-fatal):", msg);
    return false;
  }
}

/**
 * Append one tool-call row. Never throws. Awaiting it is allowed but
 * the chat route deliberately does NOT await — the row landing a few
 * hundred ms after the stream is fine; blocking the stream is not.
 */
export async function logToolCall(entry: ToolLogEntry): Promise<void> {
  try {
    const sheets = sheetsClient(entry.subjectEmail);
    let argsJson = "";
    try {
      argsJson = JSON.stringify(entry.args ?? {});
    } catch {
      argsJson = "(unserializable)";
    }
    const spreadsheetId = envOrThrow("SHEET_ID_COMMENTS");
    const row = [
      nowIsraelString(),
      entry.userEmail,
      entry.subjectEmail,
      clip(entry.question || "", MAX_QUESTION),
      entry.tool,
      clip(argsJson, MAX_ARGS),
      entry.ok ? "TRUE" : "FALSE",
      clip(entry.error || "", MAX_ERROR),
      String(entry.durationMs),
    ];
    const doAppend = () =>
      sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${TAB}!A:I`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [row] },
      });
    try {
      await doAppend();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The one recoverable case: the tab doesn't exist yet. Provision
      // it once, then retry the append a single time. Anything else is
      // swallowed below.
      if (!tabEnsured && /Unable to parse range|not found/i.test(msg)) {
        const created = await ensureTab(sheets, spreadsheetId);
        if (created) await doAppend();
      } else {
        throw e;
      }
    }
  } catch (e) {
    // Telemetry must never affect the chat — swallow everything.
    console.log(
      "[aiToolLog] append failed (non-fatal):",
      e instanceof Error ? e.message : String(e),
    );
  }
}
