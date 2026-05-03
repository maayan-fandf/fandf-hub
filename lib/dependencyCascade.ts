/**
 * Dependency cascade — when a task transitions to a terminal state
 * (`done` or `cancelled`), check every downstream task that was waiting
 * on it. If ALL of a downstream task's blockers are now terminal, flip
 * it `blocked → awaiting_handling` and append a status_history entry.
 *
 * Wired into `tasksUpdateDirect` (lib/tasksWriteDirect.ts) right
 * before its return — fires-and-forgets on best-effort basis. A
 * failure here MUST NOT break the user's transition that triggered
 * the cascade; we surface errors via console.log only.
 *
 * IMPORTANT: this module DOES NOT spawn personal Google Tasks for
 * the just-unblocked downstream assignees. Phase 3 of the dependency
 * feature will rework GT spawning to fire from this module's
 * unblock event (currently GT spawn happens at task creation, which
 * is wrong for blocked tasks — they get GTs prematurely). Until
 * phase 3 lands, the cascade transitions the row but the assignee's
 * personal GT is still the create-time spawn, and notification
 * delivery is the separate notifyTaskAssigned path the caller of
 * tasksUpdateDirect already invokes.
 *
 * Phase 2 of dependencies feature, 2026-05-03.
 * See memory/project_dependencies_chains_pending.md.
 */

import type { WorkTaskStatus } from "@/lib/appsScript";
import type { sheets_v4 } from "googleapis";
// `sheetsClient` is dynamically imported below — the @/ path alias
// is fine for Next.js bundling but breaks `node --experimental-strip-
// types` execution of probe scripts that import this module. Lazy
// import lets probes inject their own sheets client without ever
// touching `@/lib/sa`.

/** Sheets client used by the cascade — the real googleapis v4 type so
 *  callers (incl. probes that inject their own auth) get full type
 *  safety on .get() / .batchUpdate() params. */
type SheetsClient = sheets_v4.Sheets;

/** A status counts as "terminal for cascade purposes" when it can no
 *  longer block downstream — i.e. the upstream is finished (done) or
 *  abandoned (cancelled). Both unblock the chain. */
export function isTerminalForCascade(status: string): boolean {
  return status === "done" || status === "cancelled";
}

export type CascadeUnblock = {
  /** Downstream task ID that just transitioned blocked → awaiting_handling */
  taskId: string;
  /** Title (for logging only) */
  title: string;
  /** Upstream blocker IDs that were waiting on the just-completed task */
  unblockedBy: string[];
};

export type CascadeResult = {
  /** Tasks the cascade transitioned out of `blocked` */
  unblocked: CascadeUnblock[];
  /** Downstream tasks examined that remain blocked (other blockers
   *  still non-terminal) — useful for logging + future "stuck chain"
   *  diagnostics. */
  stillBlocked: { taskId: string; remainingBlockerIds: string[] }[];
  /** Errors collected during the cascade — best-effort surface so
   *  the caller can decide whether to escalate. Empty in the happy
   *  path. */
  errors: string[];
};

/**
 * Read the Comments sheet, find every task whose `blocked_by`
 * contains `completedTaskId`, and for each downstream task whose
 * remaining blockers are all terminal, flip it `blocked →
 * awaiting_handling` with a status_history entry crediting the
 * cascade.
 *
 * One sheet read + N targeted cell writes (status, status_history,
 * updated_at). N is small in practice (chains rarely fan out to
 * more than 2-3 immediate downstream tasks).
 */
export async function cascadeAfterTerminal(args: {
  /** Subject email used to read the sheet — typically the admin
   *  identity passed by the caller in tasksUpdateDirect. The cascade
   *  is system-attributed, not user-attributed; we just need any
   *  identity that can read+write Comments. */
  subjectEmail: string;
  /** ID of the task that just transitioned to a terminal status. */
  completedTaskId: string;
  /** Status the upstream task just landed in — for the cascade
   *  history note ("auto-unblocked: T-X done" vs "T-X cancelled"). */
  upstreamFinalStatus: WorkTaskStatus;
  /** ISO timestamp of the upstream transition — used as the cascade's
   *  status_history entry timestamp + updated_at. Passing this in
   *  (rather than recomputing) keeps the cascade's stamp consistent
   *  with the upstream's, which makes debugging easier. */
  nowIso: string;
  /** Spreadsheet ID for Comments tab — passed in to avoid re-reading
   *  env vars and to make the function unit-testable with a fake
   *  spreadsheet. Use the same SHEET_ID_COMMENTS the caller used. */
  commentsSpreadsheetId: string;
  /** Optional sheets client override. Production callers omit it and
   *  the cascade builds one via `sheetsClient(subjectEmail)`. Probe
   *  scripts inject their own (the @/ path alias prevents direct
   *  Node execution otherwise). */
  sheets?: SheetsClient;
}): Promise<CascadeResult> {
  const { subjectEmail, completedTaskId, upstreamFinalStatus, nowIso, commentsSpreadsheetId } =
    args;
  const result: CascadeResult = { unblocked: [], stillBlocked: [], errors: [] };
  if (!completedTaskId) return result;

  const sheets =
    args.sheets ??
    (await (async () => {
      const { sheetsClient } = await import("@/lib/sa");
      return sheetsClient(subjectEmail);
    })());

  // Step 1 — read the full Comments tab. Only path that gives us:
  //   (a) every row's blocked_by/status to identify downstream candidates
  //   (b) the row indices we need for targeted writes
  // We can't use the cached read in tasksDirect.ts because that's
  // wrapped in React's per-request `cache()` — not available outside
  // a render. Direct fetch is fine; cascade only fires on actual state
  // changes which are themselves Sheets writes (1 read per write is
  // cheap relative to the write itself).
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: commentsSpreadsheetId,
    range: "Comments",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = (readRes.data.values ?? []) as unknown[][];
  if (values.length < 2) return result;

  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const idx = new Map<string, number>();
  headers.forEach((h, i) => {
    if (h) idx.set(h, i);
  });

  const colId = idx.get("id");
  const colTitle = idx.get("title");
  const colStatus = idx.get("status");
  const colBlockedBy = idx.get("blocked_by");
  const colStatusHistory = idx.get("status_history");
  const colUpdatedAt = idx.get("updated_at");
  if (
    colId == null ||
    colStatus == null ||
    colBlockedBy == null ||
    colStatusHistory == null ||
    colUpdatedAt == null
  ) {
    result.errors.push(
      `cascadeAfterTerminal: missing required columns on Comments header (need id, status, blocked_by, status_history, updated_at)`,
    );
    return result;
  }

  // Step 2 — index every row's id → row data so we can lookup
  // blocker statuses without a second read. Skip rows whose id is
  // empty (defensive — empty-id rows are write bugs we already guard
  // against in createTask, but legacy rows might exist).
  type IndexedRow = { id: string; sheetRowIndex: number; row: unknown[] };
  const byId = new Map<string, IndexedRow>();
  const dataRows: IndexedRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    const id = String(row[colId] ?? "").trim();
    if (!id) continue;
    const indexed: IndexedRow = { id, sheetRowIndex: i + 1, row };
    byId.set(id, indexed);
    dataRows.push(indexed);
  }

  // Step 3 — find downstream candidates: rows whose blocked_by JSON
  // includes the just-completed task ID. Cheap parse-and-test loop.
  const candidates: IndexedRow[] = [];
  for (const r of dataRows) {
    const raw = r.row[colBlockedBy];
    if (!raw) continue;
    let arr: string[] = [];
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) arr = parsed.map(String);
      } catch {
        continue;
      }
    } else if (Array.isArray(raw)) {
      arr = (raw as unknown[]).map(String);
    }
    if (arr.includes(completedTaskId)) candidates.push(r);
  }

  if (candidates.length === 0) return result;

  // Step 4 — for each candidate, check whether ALL of its blockers
  // are now terminal. If yes and its current status is `blocked`, mark
  // for unblock. Otherwise log as still-blocked for visibility.
  type Update = {
    candidate: IndexedRow;
    unblockedByIds: string[];
    newStatusHistory: unknown[];
  };
  const updates: Update[] = [];

  for (const c of candidates) {
    const currentStatus = String(c.row[colStatus] ?? "");
    if (currentStatus !== "blocked") {
      // Already moved by a hand-edit, by a previous cascade for a
      // sibling completion in the same chain, or by an admin script.
      // Don't double-write; skip.
      continue;
    }
    const blockedByRaw = c.row[colBlockedBy];
    let blockerIds: string[] = [];
    if (typeof blockedByRaw === "string") {
      try {
        const parsed = JSON.parse(blockedByRaw);
        if (Array.isArray(parsed)) blockerIds = parsed.map(String);
      } catch {
        /* unreachable — already parsed once in Step 3, but guard for safety */
      }
    } else if (Array.isArray(blockedByRaw)) {
      blockerIds = (blockedByRaw as unknown[]).map(String);
    }

    // Check every blocker's status. Unknown blocker IDs (rows we
    // don't have or whose row was deleted) are treated as terminal —
    // they can no longer block. This matches the "can't block what
    // doesn't exist" intuition and avoids leaving chains stuck after
    // upstream rows get archived/deleted.
    const remainingBlockerIds: string[] = [];
    for (const blockerId of blockerIds) {
      if (blockerId === completedTaskId) continue; // we know this is terminal
      const blocker = byId.get(blockerId);
      if (!blocker) continue; // unknown → treat as terminal
      const blockerStatus = String(blocker.row[colStatus] ?? "");
      if (!isTerminalForCascade(blockerStatus)) {
        remainingBlockerIds.push(blockerId);
      }
    }

    if (remainingBlockerIds.length > 0) {
      result.stillBlocked.push({
        taskId: c.id,
        remainingBlockerIds,
      });
      continue;
    }

    // All blockers terminal — schedule the unblock.
    const existingHistoryRaw = c.row[colStatusHistory];
    let existingHistory: unknown[] = [];
    if (typeof existingHistoryRaw === "string") {
      try {
        const parsed = JSON.parse(existingHistoryRaw);
        if (Array.isArray(parsed)) existingHistory = parsed;
      } catch {
        existingHistory = [];
      }
    } else if (Array.isArray(existingHistoryRaw)) {
      existingHistory = existingHistoryRaw;
    }
    const newEntry = {
      at: nowIso,
      by: "system",
      from: "blocked",
      to: "awaiting_handling",
      note: `auto-unblocked (upstream ${completedTaskId} ${upstreamFinalStatus})`,
    };
    updates.push({
      candidate: c,
      unblockedByIds: blockerIds,
      newStatusHistory: [...existingHistory, newEntry],
    });
  }

  if (updates.length === 0) return result;

  // Step 5 — apply updates. Each candidate gets:
  //   status        := awaiting_handling
  //   status_history += { at, by:"system", from:"blocked", to:"...", note }
  //   updated_at    := nowIso
  // Use one batchUpdate per candidate to keep semantics atomic at the
  // candidate level (3 cells in 1 round-trip per candidate).
  for (const u of updates) {
    const sheetRow = u.candidate.sheetRowIndex;
    const ranges = [
      {
        range: `Comments!${columnLetter(colStatus + 1)}${sheetRow}`,
        values: [["awaiting_handling"]],
      },
      {
        range: `Comments!${columnLetter(colStatusHistory + 1)}${sheetRow}`,
        values: [[JSON.stringify(u.newStatusHistory)]],
      },
      {
        range: `Comments!${columnLetter(colUpdatedAt + 1)}${sheetRow}`,
        values: [[nowIso]],
      },
    ];
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: commentsSpreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: ranges,
        },
      });
      result.unblocked.push({
        taskId: u.candidate.id,
        title: colTitle != null ? String(u.candidate.row[colTitle] ?? "") : "",
        unblockedBy: u.unblockedByIds,
      });
    } catch (e) {
      result.errors.push(
        `cascade unblock failed for ${u.candidate.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return result;
}

/**
 * Convert 1-indexed column number to A1 letters. Local copy to keep
 * this module dependency-free from the rest of tasksWriteDirect.
 *
 *   1 → A, 27 → AA, 53 → BA
 */
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
