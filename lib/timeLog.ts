/**
 * Time-tracking ledger — one row per logged time entry, appended to the
 * self-provisioning `TimeLog` tab on the Comments spreadsheet.
 *
 * This is the optional, informational sibling of the PricingLog billing
 * ledger (see lib/pricingLog.ts). A user logs minutes spent on a task
 * from the task detail page; each submission appends one row. It is
 * append-only and per-person-per-task: the same task can collect many
 * rows from different people on different days, each carrying who
 * logged it. The /admin/time report pivots it by month × company,
 * mirroring /admin/billing — but time is informational here (it does
 * NOT drive a charge; billing stays on the flat Pricingsetup price).
 *
 * Unlike PricingLog (a fire-and-forget side-effect of task creation),
 * logging time is a deliberate user action, so the writer surfaces
 * hard failures to the caller (the API route → a toast) instead of
 * swallowing them. The missing-tab path still self-provisions
 * (addSheet + header) then retries once, exactly like pricingLog.
 *
 * Tab columns:
 *   logged_at_il | task_id | company | project | departments |
 *   kind | minutes | note | logged_by
 */

import { sheetsClient } from "@/lib/sa";

const TAB = "TimeLog";
const HEADER = [
  "logged_at_il",
  "task_id",
  "company",
  "project",
  "departments",
  "kind",
  "minutes",
  "note",
  "logged_by",
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
      range: `${TAB}!A1:I1`,
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
    console.log("[timeLog] could not provision tab:", msg);
    return false;
  }
}

export type TaskTimeEntry = {
  subjectEmail: string;
  taskId: string;
  company: string;
  project: string;
  departments: string[];
  kind: string;
  /** Minutes spent — a positive integer (the UI accepts hours and
   *  converts before calling). */
  minutes: number;
  /** Optional free-text note ("first draft", "client revisions", …). */
  note: string;
  loggedBy: string;
};

/**
 * Append one time-log row. Throws on a hard failure (the caller is a
 * user-initiated POST that wants to confirm or report the error). The
 * missing-tab case self-provisions and retries once before giving up.
 */
export async function logTaskTime(entry: TaskTimeEntry): Promise<void> {
  const spreadsheetId = envOrThrow("SHEET_ID_COMMENTS");
  const sheets = sheetsClient(entry.subjectEmail);
  const row = [
    nowIsraelString(),
    entry.taskId,
    entry.company,
    entry.project,
    (entry.departments || []).join(", "),
    entry.kind,
    entry.minutes,
    entry.note,
    entry.loggedBy,
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
    if (!tabEnsured && /Unable to parse range|not found/i.test(msg)) {
      const created = await ensureTab(sheets, spreadsheetId);
      if (!created) throw new Error("TimeLog tab could not be provisioned");
      await doAppend();
    } else {
      throw e;
    }
  }
}

export type TimeLogRow = {
  /** "YYYY-MM-DD HH:MM:SS" Asia/Jerusalem (as written by the appender). */
  loggedAt: string;
  /** Derived "YYYY-MM" for month grouping. */
  month: string;
  taskId: string;
  company: string;
  project: string;
  departments: string;
  kind: string;
  minutes: number;
  note: string;
  loggedBy: string;
  /** Enrichment joined from the task by taskId at report time (the
   *  ledger tab itself doesn't store these). Undefined when the task
   *  can't be resolved (deleted / no access). */
  title?: string;
  /** The task's brief (WorkTask.campaign). */
  brief?: string;
  /** The task's assignee(s) — display string. */
  worker?: string;
  /** Status-time rows only: the task's counter is running right now
   *  (in_progress, not paused, no manual override) — drives the live
   *  indicator + quick-pause button on /admin/time. */
  running?: boolean;
  /** Status-time rows only: in_progress but currently paused. */
  paused?: boolean;
  /** True for the synthesized per-task status-time rows (vs the manual
   *  ledger rows). Only these are editable / get the actual-vs-shown
   *  comparison on /admin/time. */
  isStatus?: boolean;
  /** Status rows only: raw wall-clock minutes the task sat in בעבודה
   *  (ignores pauses AND the manual override) — the "actual" column. */
  rawMinutes?: number;
  /** Status rows only: the pause-adjusted derived minutes BEFORE any
   *  manual override (what to fall back to when an override is reset). */
  autoMinutes?: number;
  /** Status rows only: a manual `inprogress_minutes` override is set
   *  (shown amount = override, not the derived value). */
  overridden?: boolean;
  /** Status-time rows only: accumulated time is abnormally large and
   *  has NOT been manually corrected — likely left in ׳בעבודה׳ without
   *  real work (e.g. over a weekend). Drives the ⚠ "needs review"
   *  marker + filter on /admin/time. */
  needsReview?: boolean;
};

function parseRows(values: unknown[][]): TimeLogRow[] {
  const out: TimeLogRow[] = [];
  for (const r of values) {
    const loggedAt = String(r[0] ?? "").trim();
    const taskId = String(r[1] ?? "").trim();
    if (!loggedAt && !taskId) continue;
    const minutesRaw = r[6];
    const minutes =
      typeof minutesRaw === "number"
        ? minutesRaw
        : Number(String(minutesRaw ?? "").replace(/[^\d.-]/g, ""));
    out.push({
      loggedAt,
      month: loggedAt.slice(0, 7), // "YYYY-MM"
      taskId,
      company: String(r[2] ?? "").trim(),
      project: String(r[3] ?? "").trim(),
      departments: String(r[4] ?? "").trim(),
      kind: String(r[5] ?? "").trim(),
      minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 0,
      note: String(r[7] ?? "").trim(),
      loggedBy: String(r[8] ?? "").trim(),
    });
  }
  return out;
}

/**
 * Read the whole TimeLog ledger for the /admin/time report. Returns []
 * when the tab doesn't exist yet (no time logged since the feature
 * shipped) — the report renders an empty state, not an error.
 * Read-only; admin-gated at the route.
 */
export async function readTimeLog(
  subjectEmail: string,
): Promise<TimeLogRow[]> {
  try {
    const spreadsheetId = envOrThrow("SHEET_ID_COMMENTS");
    const sheets = sheetsClient(subjectEmail);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${TAB}!A2:I`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    return parseRows((res.data.values ?? []) as unknown[][]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Unable to parse range|not found/i.test(msg)) return [];
    console.log("[timeLog] readTimeLog failed (non-fatal):", msg);
    return [];
  }
}

/**
 * Read the time entries for a single task (the detail-page tracker).
 * The ledger is small early on and Sheets has no server-side filter on
 * a plain values.get, so this reads the tab and filters by task_id.
 * Returns [] when the tab is missing.
 */
export async function readTaskTimeLog(
  subjectEmail: string,
  taskId: string,
): Promise<TimeLogRow[]> {
  const id = String(taskId || "").trim();
  if (!id) return [];
  const all = await readTimeLog(subjectEmail);
  return all
    .filter((r) => r.taskId === id)
    .sort((a, b) => b.loggedAt.localeCompare(a.loggedAt));
}
