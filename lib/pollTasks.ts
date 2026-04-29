/**
 * In-process replacement for Apps Script's `pollTaskCompletions` trigger.
 *
 * Runs on a schedule (Cloud Scheduler hits /api/cron/poll-tasks). Walks
 * every Comments-sheet row that has at least one Google Task ref on it,
 * fetches each ref's current status from the Tasks API, and:
 *   - if the GT is now `completed` and the row's hub task isn't already
 *     in a terminal state, dispatch the right hub-side transition via
 *     `applyAutoTransition` (in-process call, no HTTP hop)
 *   - if the GT's due date drifted (user edited it in their Tasks app),
 *     update the row's `google_tasks` cell to match
 *
 * Concurrency: the cron caller is supposed to run a single fire at a
 * time (Cloud Scheduler default). We additionally guard with an
 * in-process flag so a second concurrent invocation on the same
 * container is dropped on the floor instead of doubling reads. The
 * per-task mutex in `tasksUpdateDirect` covers the case where one
 * poller fire and a hub UI write race on the same task.
 *
 * No GT spawn / close happens in here directly — the only side effects
 * are (a) writing the row's `google_tasks` cell to update due dates,
 * and (b) calling `applyAutoTransition` which itself owns the GT
 * cascade for the resulting status change.
 */

import { sheetsClient, tasksApiClient } from "@/lib/sa";
import { applyAutoTransition } from "@/lib/autoTransition";
import type { GTaskKind, GTaskRef } from "@/lib/appsScript";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/** Read the cell as a flat array regardless of legacy shape (object
 *  or array). Mirrors the helpers in `tasksDirect.ts` and
 *  `tasksWriteDirect.ts` — kept inline so this module doesn't pull
 *  the rest of those files transitively. */
function parseCell(value: unknown): GTaskRef[] {
  if (value == null || value === "") return [];
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (Array.isArray(parsed)) return parsed as GTaskRef[];
  if (parsed && typeof parsed === "object") {
    return Object.values(parsed as Record<string, GTaskRef>);
  }
  return [];
}

/** RFC3339 (`2026-04-30T00:00:00.000Z`) → `YYYY-MM-DD` ("" when blank). */
function rfcToDueDate(rfc: string | null | undefined): string {
  if (!rfc) return "";
  const m = String(rfc).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function columnLetter(colNumber: number): string {
  let n = colNumber;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type FetchResult =
  | { ok: true; status: string; due: string }
  | { ok: false; deleted: boolean };

async function fetchOne(ref: GTaskRef): Promise<FetchResult> {
  try {
    const tasksApi = tasksApiClient(ref.u);
    const res = await tasksApi.tasks.get({ tasklist: ref.l, task: ref.t });
    return {
      ok: true,
      status: res.data.status || "needsAction",
      due: rfcToDueDate(res.data.due ?? ""),
    };
  } catch (e) {
    const code = (e as { code?: number; response?: { status?: number } }).code
      ?? (e as { response?: { status?: number } }).response?.status;
    if (code === 404) {
      return { ok: false, deleted: true };
    }
    // Other errors (auth, network, rate limit) — caller treats as
    // "unknown, leave alone this cycle". Logged for observability.
    console.log(
      `[pollTasks] fetch failed for ${JSON.stringify(ref)}:`,
      e instanceof Error ? e.message : String(e),
    );
    return { ok: false, deleted: false };
  }
}

/* In-process re-entrancy guard. Cloud Scheduler shouldn't fire
 * overlapping invocations on the same job, but if it ever does (or if
 * a manual trigger races with the schedule), this drops the second. */
let inFlight: Promise<PollResult> | null = null;

export type PollResult = {
  rowsScanned: number;
  rowsWithGTs: number;
  refsFetched: number;
  duesUpdated: number;
  transitionsDispatched: number;
  transitionsSkipped: number;
  transitionsErrored: number;
  durationMs: number;
};

export async function pollAllTaskCompletions(): Promise<PollResult> {
  if (inFlight) {
    console.log("[pollTasks] another invocation in flight — skipping");
    return inFlight;
  }
  inFlight = pollAllTaskCompletionsInner();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function pollAllTaskCompletionsInner(): Promise<PollResult> {
  const start = Date.now();
  // Use the canonical admin identity — the SA only impersonates within
  // the F&F domain, and this user has read access to every project.
  const subjectEmail = "maayan@fandf.co.il";
  const sheets = sheetsClient(subjectEmail);
  const commentsSsId = envOrThrow("SHEET_ID_COMMENTS");

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: commentsSsId,
    range: "Comments",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const rows = (res.data.values ?? []) as unknown[][];
  if (rows.length < 2) {
    return summary(start, 0, 0, 0, 0, 0, 0, 0);
  }
  const headers = (rows[0] as unknown[]).map((h) => String(h ?? "").trim());
  const idx = (n: string): number => headers.indexOf(n);
  const I_ID = idx("id");
  const I_KIND = idx("row_kind");
  const I_RESOLVED = idx("resolved");
  const I_GT = idx("google_tasks");
  const I_STATUS = idx("status");
  if (I_ID < 0 || I_GT < 0) {
    throw new Error("Comments sheet missing required headers (id, google_tasks)");
  }

  // Step 1: collect every (row, ref) pair we need to fetch.
  type RowJob = {
    sheetRow: number; // 1-based row number in the sheet
    rowId: string;
    rowKind: string;
    resolved: boolean;
    hubStatus: string;
    refs: GTaskRef[];
  };
  const jobs: RowJob[] = [];
  let rowsWithGTs = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const refs = parseCell(I_GT < 0 ? "" : row[I_GT]);
    if (refs.length === 0) continue;
    rowsWithGTs++;
    jobs.push({
      sheetRow: i + 1,
      rowId: String(row[I_ID] ?? ""),
      rowKind: I_KIND < 0 ? "" : String(row[I_KIND] ?? "").trim(),
      resolved: I_RESOLVED < 0 ? false : Boolean(row[I_RESOLVED]),
      hubStatus: I_STATUS < 0 ? "" : String(row[I_STATUS] ?? "").trim(),
      refs,
    });
  }

  // Step 2: process each job. Sequential per-row but parallel within a
  // row's refs — a typical row has 1-3 refs, so this caps concurrency
  // naturally without explicit batching.
  const gtCol = columnLetter(I_GT + 1);
  let refsFetched = 0;
  let duesUpdated = 0;
  let dispatched = 0;
  let skipped = 0;
  let errored = 0;

  for (const job of jobs) {
    // Skip already-resolved comment rows (they're cosmetic — old refs
    // there are kept for audit). For task rows, also skip if hub
    // status is terminal — the cascade already closed the GTs, the
    // refs are just history.
    const terminal = job.hubStatus === "done" || job.hubStatus === "cancelled";
    if (job.resolved || terminal) continue;

    const fetched = await Promise.all(job.refs.map(fetchOne));
    refsFetched += fetched.length;

    // Update due dates on any ref where the GT side drifted. Build
    // the new array from the original refs + fetched data so refs the
    // API failed on retain their stored due value.
    let mutated = false;
    const updatedRefs: GTaskRef[] = job.refs.map((ref, k) => {
      const f = fetched[k];
      if (!f.ok) return ref;
      if (f.due !== (ref.d ?? "")) {
        mutated = true;
        return { ...ref, d: f.due };
      }
      return ref;
    });
    if (mutated) {
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: commentsSsId,
          range: `Comments!${gtCol}${job.sheetRow}`,
          valueInputOption: "RAW",
          requestBody: { values: [[JSON.stringify(updatedRefs)]] },
        });
        duesUpdated++;
      } catch (e) {
        console.log(
          `[pollTasks] due-date write failed for row ${job.rowId}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    // Find the FIRST completed ref and dispatch its kind. The cascade
    // inside applyAutoTransition closes any other open refs on this
    // row as part of the status transition (via syncGoogleTasksStatus
    // in tasksUpdateDirect), so we don't need to dispatch each
    // completed ref individually.
    if (job.rowKind !== "task") continue;
    const completed = updatedRefs
      .map((r, k) => ({ r, f: fetched[k] }))
      .find((p) => p.f.ok && p.f.status === "completed");
    if (!completed) continue;

    const kind: GTaskKind = (completed.r.kind as GTaskKind) || "todo";
    const completedBy = completed.r.u || "";
    const result = await applyAutoTransition({
      taskId: job.rowId,
      kind,
      completedBy,
    });
    if ("error" in result) {
      errored++;
      console.log(
        `[pollTasks] auto-transition failed for ${job.rowId}: ${result.error}`,
      );
    } else if (result.skipped) {
      skipped++;
    } else {
      dispatched++;
    }
  }

  return summary(start, rows.length - 1, rowsWithGTs, refsFetched, duesUpdated, dispatched, skipped, errored);
}

function summary(
  start: number,
  rowsScanned: number,
  rowsWithGTs: number,
  refsFetched: number,
  duesUpdated: number,
  transitionsDispatched: number,
  transitionsSkipped: number,
  transitionsErrored: number,
): PollResult {
  return {
    rowsScanned,
    rowsWithGTs,
    refsFetched,
    duesUpdated,
    transitionsDispatched,
    transitionsSkipped,
    transitionsErrored,
    durationMs: Date.now() - start,
  };
}
