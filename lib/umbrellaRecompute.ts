/**
 * Umbrella status recompute — when a child task transitions, fetch
 * its sibling children, derive the umbrella's new status via
 * deriveUmbrellaStatus, and persist if different.
 *
 * Wired into `tasksUpdateDirect` (post-cascade) and `createTask`
 * (when a new child is born under an existing umbrella). Best-effort
 * — failures log but don't bubble.
 *
 * Phase 4 of dependencies feature, 2026-05-03.
 */

import type { sheets_v4 } from "googleapis";
import type { WorkTaskStatus } from "@/lib/appsScript";
// `deriveUmbrellaStatus` is dynamically imported in the function
// body — top-level `import { deriveUmbrellaStatus } from "@/lib/..."`
// breaks `node --experimental-strip-types` execution of probe scripts
// since Next.js path aliases aren't resolved by the runtime. Type-
// only imports above are erased, so they're fine.
//
// (Probe-script support is the whole reason for this dance — once
// the codebase has a proper test runner that respects path aliases
// we can revert to a top-level value import.)

type SheetsClient = sheets_v4.Sheets;

export type UmbrellaRecomputeResult =
  | { ok: true; changed: false; reason: string }
  | { ok: true; changed: true; previous: WorkTaskStatus; next: WorkTaskStatus }
  | { ok: false; error: string };

/**
 * Re-derive an umbrella's status from its children. The caller passes
 * the umbrella's ID; we look up every row whose `umbrella_id` matches,
 * collect their statuses, derive, and write the umbrella's status +
 * updated_at if changed.
 *
 * NOTE: this function reads the entire Comments tab — same shape as
 * cascadeAfterTerminal. In the steady state we'd have a children
 * index keyed by umbrella_id, but the dataset is small enough today
 * that a linear scan once per child-mutation is acceptable. Optimize
 * when umbrellas exceed ~100 in the live sheet.
 */
export async function recomputeUmbrellaStatus(args: {
  subjectEmail: string;
  umbrellaId: string;
  commentsSpreadsheetId: string;
  nowIso: string;
  /** Optional injected sheets client — same pattern as cascade,
   *  lets probes sidestep `@/lib/sa` path-alias issues under
   *  `node --experimental-strip-types`. */
  sheets?: SheetsClient;
}): Promise<UmbrellaRecomputeResult> {
  const { subjectEmail, umbrellaId, commentsSpreadsheetId, nowIso } = args;
  if (!umbrellaId) return { ok: true, changed: false, reason: "no umbrella_id" };

  const sheets =
    args.sheets ??
    (await (async () => {
      const { sheetsClient } = await import("@/lib/sa");
      return sheetsClient(subjectEmail);
    })());

  let values: unknown[][];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: commentsSpreadsheetId,
      range: "Comments",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    values = (res.data.values ?? []) as unknown[][];
  } catch (e) {
    return {
      ok: false,
      error: `read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (values.length < 2) return { ok: true, changed: false, reason: "empty sheet" };

  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const idx = new Map<string, number>();
  headers.forEach((h, i) => {
    if (h) idx.set(h, i);
  });

  const colId = idx.get("id");
  const colStatus = idx.get("status");
  const colUmbrellaId = idx.get("umbrella_id");
  const colIsUmbrella = idx.get("is_umbrella");
  const colUpdatedAt = idx.get("updated_at");
  const colRowKind = idx.get("row_kind");
  if (
    colId == null ||
    colStatus == null ||
    colUmbrellaId == null ||
    colIsUmbrella == null ||
    colUpdatedAt == null ||
    colRowKind == null
  ) {
    return { ok: false, error: "missing required columns on Comments header" };
  }

  // Find the umbrella row + collect every child's status in one pass.
  let umbrellaRowIndex = -1;
  let umbrellaCurrentStatus: WorkTaskStatus | "" = "";
  const childStatuses: WorkTaskStatus[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    if (String(row[colRowKind] ?? "").trim() !== "task") continue;
    const id = String(row[colId] ?? "").trim();
    if (id === umbrellaId) {
      umbrellaRowIndex = i + 1; // 1-indexed sheet row
      umbrellaCurrentStatus = String(row[colStatus] ?? "") as WorkTaskStatus;
      continue;
    }
    const ui = String(row[colUmbrellaId] ?? "").trim();
    if (ui === umbrellaId) {
      childStatuses.push(String(row[colStatus] ?? "") as WorkTaskStatus);
    }
  }

  if (umbrellaRowIndex < 0) {
    return { ok: false, error: `umbrella row ${umbrellaId} not found` };
  }

  // Inline the small derivation rather than fight the loader. The
  // logic is duplicated from lib/umbrellaStatus.ts deriveUmbrellaStatus
  // — keep the two in sync, OR refactor by removing this duplicate
  // once the codebase has a probe runner that respects @/ aliases.
  // Pure function, ~15 lines; cheaper than another lazy-import dance.
  const derived: WorkTaskStatus = (() => {
    if (childStatuses.length === 0) return "awaiting_handling";
    let allDone = true, allCancelled = true, anyActive = false;
    for (const s of childStatuses) {
      if (s !== "done") allDone = false;
      if (s !== "cancelled") allCancelled = false;
      if (s === "in_progress" || s === "awaiting_clarification" || s === "awaiting_approval") anyActive = true;
    }
    if (allDone) return "done";
    if (allCancelled) return "cancelled";
    if (anyActive) return "in_progress";
    let anyPending = false;
    for (const s of childStatuses) {
      if (s === "blocked" || s === "awaiting_handling" || s === "draft") { anyPending = true; break; }
    }
    if (anyPending) return "awaiting_handling";
    return "done";
  })();
  if (derived === umbrellaCurrentStatus) {
    return { ok: true, changed: false, reason: `already ${derived}` };
  }

  // Persist via batchUpdate — same pattern as cascadeAfterTerminal.
  // Updates status + updated_at; status_history is intentionally NOT
  // touched (it's derived state, not a user/system event worth
  // recording on the umbrella's own audit log).
  const colLetter = (n: number) => {
    let s = "";
    let x = n;
    while (x > 0) {
      const r = (x - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      x = Math.floor((x - 1) / 26);
    }
    return s;
  };

  try {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: commentsSpreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          {
            range: `Comments!${colLetter(colStatus + 1)}${umbrellaRowIndex}`,
            values: [[derived]],
          },
          {
            range: `Comments!${colLetter(colUpdatedAt + 1)}${umbrellaRowIndex}`,
            values: [[nowIso]],
          },
        ],
      },
    });
  } catch (e) {
    return {
      ok: false,
      error: `write failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return {
    ok: true,
    changed: true,
    previous: (umbrellaCurrentStatus || "awaiting_handling") as WorkTaskStatus,
    next: derived,
  };
}
