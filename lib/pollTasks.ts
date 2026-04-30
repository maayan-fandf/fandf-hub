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
import {
  createGoogleTasks,
  persistGoogleTasksCell,
} from "@/lib/tasksWriteDirect";
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
  /** Reconciliation: how many task rows were missing one-or-more GT for
   *  their current stage and got a fresh spawn. Should be ≥0 in steady
   *  state — non-zero means drift was detected and healed. */
  rowsHealed: number;
  /** Reconciliation: how many GTs were spawned across all healed rows. */
  gtsSpawned: number;
  durationMs: number;
};

/** Active statuses where the reconciliation should ensure a GT exists
 *  for each expected recipient. Other statuses (terminal / draft) are
 *  skipped — the existing transition cascade already closed the GTs. */
type ActiveStatus =
  | "awaiting_handling"
  | "in_progress"
  | "awaiting_approval"
  | "awaiting_clarification";

/** Compute the (recipient email, GT kind) pairs that SHOULD exist for
 *  a task at the given status. Empty assignees fall back to author so
 *  a self-only task still surfaces in the author's GT list. Empty
 *  approver / owner produces no expectation (we can't spawn for a
 *  blank email). */
function expectedRecipientsForRow(input: {
  status: string;
  assignees: string[];
  authorEmail: string;
  approverEmail: string;
  pmEmail: string;
}): { email: string; kind: GTaskKind }[] {
  const { status, assignees, authorEmail, approverEmail, pmEmail } = input;
  switch (status as ActiveStatus | string) {
    case "awaiting_handling":
    case "in_progress": {
      const list = assignees.filter(Boolean);
      const recipients = list.length > 0 ? list : authorEmail ? [authorEmail] : [];
      return recipients.map((email) => ({ email, kind: "todo" as const }));
    }
    case "awaiting_approval":
      return approverEmail ? [{ email: approverEmail, kind: "approve" }] : [];
    case "awaiting_clarification": {
      const owner = authorEmail || pmEmail;
      return owner ? [{ email: owner, kind: "clarify" }] : [];
    }
    default:
      return [];
  }
}

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
  // Fields needed for reconciliation (compute expected recipients).
  const I_TITLE = idx("title");
  const I_PROJECT = idx("project");
  const I_BODY = idx("body");
  const I_DRIVE_URL = idx("drive_folder_url");
  const I_REQUESTED = idx("requested_date");
  const I_AUTHOR = idx("author_email");
  const I_APPROVER = idx("approver_email");
  const I_PM = idx("project_manager_email");
  const I_MENTIONS = idx("mentions");
  if (I_ID < 0 || I_GT < 0) {
    throw new Error("Comments sheet missing required headers (id, google_tasks)");
  }
  // Build a header→colIdx map for the persistGoogleTasksCell helper
  // it expects an explicit Map.
  const headerIdx = new Map<string, number>();
  headers.forEach((h, i) => {
    if (h) headerIdx.set(h, i);
  });

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

  // Step 3: reconciliation pass. Walk every active task row (NOT just
  // those with refs) and ensure each expected recipient has both a
  // ref in cell + a visible GT in their tasklist. Heals drift like:
  //   - Empty cell on tasks created without explicit assignees
  //   - GTs in cell but the underlying GT was deleted / hidden by Tasks
  //     API (tasks.get says it exists, tasks.list doesn't return it)
  //   - Spawn that silently failed during the original transition
  //
  // Per-user GT id cache prevents re-listing the same tasklist for
  // each row with that recipient.
  const visibleGTsCache = new Map<string, Set<string>>();
  async function getVisibleGTs(email: string): Promise<Set<string>> {
    const lc = email.toLowerCase().trim();
    if (!lc) return new Set();
    const hit = visibleGTsCache.get(lc);
    if (hit) return hit;
    const ids = new Set<string>();
    try {
      const tasksApi = tasksApiClient(lc);
      const lists = await tasksApi.tasklists.list({ maxResults: 1 });
      const listId = lists.data.items?.[0]?.id;
      if (listId) {
        let pageToken: string | undefined;
        do {
          const r = await tasksApi.tasks.list({
            tasklist: listId,
            showCompleted: false,
            showHidden: false,
            maxResults: 100,
            pageToken,
          });
          for (const t of r.data.items ?? []) {
            if (t.id) ids.add(t.id);
          }
          pageToken = r.data.nextPageToken ?? undefined;
        } while (pageToken);
      }
    } catch (e) {
      // Listing failed for this user — skip reconciliation for them
      // this cycle; next cycle will try again. Log so transient
      // failures are diagnosable.
      console.log(
        `[pollTasks] reconcile: list GTs failed for ${lc}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
    visibleGTsCache.set(lc, ids);
    return ids;
  }

  let rowsHealed = 0;
  let gtsSpawned = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (I_KIND < 0 || String(row[I_KIND] ?? "").trim() !== "task") continue;
    const status = String(row[I_STATUS] ?? "").trim();
    // Only the four "active" statuses spawn GTs. Terminal + draft
    // skipped — leftover refs there are historical, not actionable.
    if (
      status !== "awaiting_handling" &&
      status !== "in_progress" &&
      status !== "awaiting_approval" &&
      status !== "awaiting_clarification"
    ) {
      continue;
    }
    const taskId = String(row[I_ID] ?? "").trim();
    if (!taskId) continue;
    const assignees = String(row[I_MENTIONS] ?? "")
      .split(/[,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const authorEmail = String(row[I_AUTHOR] ?? "").toLowerCase().trim();
    const approverEmail = String(row[I_APPROVER] ?? "").toLowerCase().trim();
    const pmEmail = String(row[I_PM] ?? "").toLowerCase().trim();
    const expected = expectedRecipientsForRow({
      status,
      assignees,
      authorEmail,
      approverEmail,
      pmEmail,
    });
    if (expected.length === 0) continue;

    const cellRefs = parseCell(I_GT < 0 ? "" : row[I_GT]);
    const missing: { email: string; kind: GTaskKind }[] = [];
    for (const exp of expected) {
      // Collect EVERY matching ref, not just the first. The original
      // implementation used `find` which checked only the first match;
      // when a cell had accumulated multiple refs for the same
      // (email, kind) — which it can after a single drift event — and
      // that first ref happened to be invisible in tasks.list, we'd
      // spawn another. Next cycle, same first ref → another spawn.
      // Endless loop. (Bug 2026-04-30; cron paused mid-day; fix
      // committed before resume.)
      const matchingRefs = cellRefs.filter(
        (r) =>
          (r.u || "").toLowerCase() === exp.email &&
          (r.kind ?? "todo") === exp.kind,
      );
      if (matchingRefs.length === 0) {
        missing.push(exp);
        continue;
      }
      // Defensive cap: if the cell already has ≥3 refs for the same
      // (email, kind), assume one of them is healthy enough and don't
      // pile on. Prevents runaway loops if the visibility check is
      // ever flaky again. Real-world cells should never exceed 1-2 per
      // (email, kind) — anything past that is leftover history.
      if (matchingRefs.length >= 3) continue;
      // Cell has refs — verify ANY matching ref's GT is visible in the
      // recipient's tasklist. If even one is healthy, the recipient
      // already has a usable GT for this stage; don't spawn another.
      const visible = await getVisibleGTs(exp.email);
      if (!matchingRefs.some((r) => visible.has(r.t))) {
        missing.push(exp);
      }
    }
    if (missing.length === 0) continue;

    // Spawn replacements. Build the task shape createGoogleTasks needs.
    const taskInput = {
      id: taskId,
      title: I_TITLE >= 0 ? String(row[I_TITLE] ?? "") : "",
      project: I_PROJECT >= 0 ? String(row[I_PROJECT] ?? "") : "",
      description: I_BODY >= 0 ? String(row[I_BODY] ?? "") : "",
      drive_folder_url: I_DRIVE_URL >= 0 ? String(row[I_DRIVE_URL] ?? "") : "",
      requested_date:
        I_REQUESTED >= 0 ? String(row[I_REQUESTED] ?? "") : "",
    };
    let mergedRefs: GTaskRef[] = [...cellRefs];
    let spawnedThisRow = 0;
    // Group by kind so each createGoogleTasks call is a single API
    // round-trip per kind.
    const byKind = new Map<GTaskKind, string[]>();
    for (const m of missing) {
      const list = byKind.get(m.kind) ?? [];
      list.push(m.email);
      byKind.set(m.kind, list);
    }
    for (const [kind, recipients] of byKind) {
      try {
        const fresh = await createGoogleTasks(taskInput, recipients, { kind });
        if (fresh.length > 0) {
          mergedRefs = [...mergedRefs, ...fresh];
          spawnedThisRow += fresh.length;
          // Update the visibility cache so subsequent rows in the
          // same cycle don't re-list the same user.
          for (const ref of fresh) {
            const set = visibleGTsCache.get(ref.u.toLowerCase()) ?? new Set();
            set.add(ref.t);
            visibleGTsCache.set(ref.u.toLowerCase(), set);
          }
        }
      } catch (e) {
        console.log(
          `[pollTasks] reconcile: spawn failed for ${taskId} kind=${kind}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    if (spawnedThisRow > 0) {
      try {
        await persistGoogleTasksCell(
          sheets,
          commentsSsId,
          headerIdx,
          i, // 0-based index into values; persistGoogleTasksCell adds 1
          mergedRefs,
        );
        rowsHealed++;
        gtsSpawned += spawnedThisRow;
        console.log(
          `[pollTasks] reconcile: healed ${taskId} — spawned ${spawnedThisRow} GT(s)`,
        );
      } catch (e) {
        console.log(
          `[pollTasks] reconcile: persist cell failed for ${taskId}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }

  return summary(
    start,
    rows.length - 1,
    rowsWithGTs,
    refsFetched,
    duesUpdated,
    dispatched,
    skipped,
    errored,
    rowsHealed,
    gtsSpawned,
  );
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
  rowsHealed = 0,
  gtsSpawned = 0,
): PollResult {
  return {
    rowsScanned,
    rowsWithGTs,
    refsFetched,
    duesUpdated,
    transitionsDispatched,
    transitionsSkipped,
    transitionsErrored,
    rowsHealed,
    gtsSpawned,
    durationMs: Date.now() - start,
  };
}
