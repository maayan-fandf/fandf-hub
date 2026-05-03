/**
 * Append a step to the end of an existing chain.
 *
 * Inserts a new task at the tail of the umbrella's child list:
 *   - new step's `umbrella_id` = umbrellaId
 *   - new step's `blocked_by` = [last_child_id] (always — preserves
 *     chain provenance even when last is terminal)
 *   - new step's status:
 *       * if last_child is in a terminal state → `awaiting_handling`
 *         (immediately actionable — cascade-equivalent semantics
 *         applied at insert time, not via the cascade hook)
 *       * otherwise → `blocked` (default from createTask when
 *         blocked_by is non-empty)
 *   - last_child's `blocks` cell gets the new step's id appended,
 *     so the cascade can find this new step when the upstream
 *     completes
 *
 * If the umbrella has NO existing children (rare — appending to an
 * empty umbrella), the new step has blocked_by=[] and starts at
 * `awaiting_handling`.
 *
 * Phase 9 of dependencies feature, 2026-05-03.
 */

import type { WorkTask } from "@/lib/appsScript";

export type AppendChainStepInput = {
  umbrellaId: string;
  title: string;
  description?: string;
  assignees?: string[];
  approver_email?: string;
  departments?: string[];
  requested_date?: string;
};

export type AppendChainStepResult = {
  ok: true;
  step: WorkTask;
  appendedAfter: string | null; // task id of the previous-tail child, null if umbrella was empty
};

export async function appendChainStepDirect(
  subjectEmail: string,
  payload: AppendChainStepInput,
): Promise<AppendChainStepResult> {
  if (!payload.umbrellaId) {
    throw new Error("appendChainStep: umbrellaId is required");
  }
  if (!payload.title?.trim()) {
    throw new Error("appendChainStep: title is required");
  }

  // Lazy imports — same probe-friendly pattern as the rest of the
  // dependency feature; avoids @/-alias-vs-strip-types friction.
  const { tasksGetDirect, tasksListDirect } = await import("@/lib/tasksDirect");
  const { tasksCreateDirect, genId } = await import("@/lib/tasksWriteDirect");
  const { sheetsClient } = await import("@/lib/sa");

  // 1. Fetch the umbrella + verify it IS an umbrella (defensive — UI
  //    wires this only on umbrella detail pages, but a stale URL or
  //    direct API call could attempt to append to a non-umbrella row).
  const umbrellaRes = await tasksGetDirect(subjectEmail, payload.umbrellaId);
  const umbrella = umbrellaRes.task;
  if (!umbrella.is_umbrella) {
    throw new Error(
      `appendChainStep: ${payload.umbrellaId} is not an umbrella (is_umbrella=false)`,
    );
  }

  // 2. Find the umbrella's existing children to identify the chain
  //    tail. tasksListDirect with include_umbrellas=true gives us all
  //    project rows including the umbrella itself; we filter to
  //    direct children. Tail = the child whose `blocks` is empty
  //    (no downstream — that's the last in chain). If multiple
  //    children have empty blocks (chain branched / malformed),
  //    we pick the latest-created as the most likely intended tail.
  const projectListing = await tasksListDirect(subjectEmail, {
    project: umbrella.project,
    include_umbrellas: true,
  });
  const children = (projectListing.tasks ?? []).filter(
    (t) => t.umbrella_id === umbrella.id,
  );

  let tailChild: WorkTask | null = null;
  if (children.length > 0) {
    const tailCandidates = children.filter((c) => (c.blocks?.length ?? 0) === 0);
    if (tailCandidates.length === 1) {
      tailChild = tailCandidates[0];
    } else if (tailCandidates.length > 1) {
      // Pick the most-recently-created candidate — best guess for
      // "intended tail" when the chain has multiple unblocked leaves.
      tailCandidates.sort((a, b) => b.created_at.localeCompare(a.created_at));
      tailChild = tailCandidates[0];
      console.log(
        `[appendChainStep] umbrella ${umbrella.id} has ${tailCandidates.length} tail candidates; picking newest (${tailChild.id}). Chain may be branched.`,
      );
    } else {
      // No tail candidate (every child blocks something) — chain
      // is fully closed cycle? Shouldn't happen given cycle check
      // at create time, but be defensive: pick the latest-created
      // child as the tail.
      const sorted = [...children].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      );
      tailChild = sorted[0];
      console.log(
        `[appendChainStep] umbrella ${umbrella.id} has no tail (every child blocks something); falling back to newest child ${tailChild.id}.`,
      );
    }
  }

  // 3. Pre-generate the new step's id so we can wire the tail's
  //    `blocks` cell to point at it BEFORE the new step exists. (The
  //    chain-creation orchestrator did the same trick.)
  const newStepId = genId();
  const tailIsTerminal =
    tailChild != null &&
    (tailChild.status === "done" || tailChild.status === "cancelled");
  const newStepStatus = tailIsTerminal || !tailChild ? "awaiting_handling" : "blocked";
  const newStepBlockedBy = tailChild ? [tailChild.id] : [];

  // 4. Create the new step row via the standard createTask path —
  //    this handles GT spawn (skipped because status=blocked when
  //    appropriate), Drive folder, notifications, umbrella recompute.
  const created = await tasksCreateDirect(subjectEmail, {
    id: newStepId,
    project: umbrella.project,
    company: umbrella.company,
    brief: umbrella.brief,
    campaign: umbrella.campaign,
    title: payload.title.trim(),
    description: payload.description ?? "",
    assignees: payload.assignees ?? [],
    approver_email: payload.approver_email,
    departments: payload.departments ?? umbrella.departments,
    requested_date: payload.requested_date,
    umbrella_id: umbrella.id,
    blocked_by: newStepBlockedBy,
    blocks: [],
    // Override the createTask default (which would pick `blocked` from
    // non-empty blocked_by) when the upstream is already terminal —
    // the new step is immediately actionable in that case.
    status: newStepStatus,
  });

  // 5. Append the new step's id to tailChild.blocks. Skip when the
  //    umbrella was empty (no tail) or when the tail is terminal
  //    (the cascade is already past that node — recording the edge
  //    is cosmetic; doing it anyway preserves the chain graph for
  //    audit + future "extend chain" UX).
  if (tailChild) {
    const newTailBlocks = Array.from(
      new Set([...(tailChild.blocks ?? []), newStepId]),
    );
    await updateTailBlocksCell(
      subjectEmail,
      tailChild.id,
      newTailBlocks,
      sheetsClient,
    );
  }

  return {
    ok: true,
    step: created.task,
    appendedAfter: tailChild?.id ?? null,
  };
}

/**
 * Targeted single-cell write to update one child's `blocks` cell.
 * Doesn't touch any other field on the row — keeps the surgical
 * footprint in case the user is concurrently editing the tail child
 * in another tab.
 *
 * Lazy-imports `sheetsClient` via the caller (so this module stays
 * dependency-injectable for tests, matching the cascade pattern).
 */
async function updateTailBlocksCell(
  subjectEmail: string,
  tailTaskId: string,
  newBlocks: string[],
  sheetsClientFactory: typeof import("@/lib/sa")["sheetsClient"],
): Promise<void> {
  const sheets = sheetsClientFactory(subjectEmail);
  const commentsSsId = process.env.SHEET_ID_COMMENTS;
  if (!commentsSsId) {
    throw new Error("SHEET_ID_COMMENTS not set");
  }

  // Read the Comments tab to find the tail row + the blocks column.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: commentsSsId,
    range: "Comments",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (values.length < 2) return;

  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const idx = new Map<string, number>();
  headers.forEach((h, i) => {
    if (h) idx.set(h, i);
  });
  const colId = idx.get("id");
  const colBlocks = idx.get("blocks");
  if (colId == null || colBlocks == null) {
    throw new Error("Comments missing id or blocks column");
  }

  let sheetRowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    if (String(row[colId] ?? "").trim() === tailTaskId) {
      sheetRowIndex = i + 1;
      break;
    }
  }
  if (sheetRowIndex < 0) {
    throw new Error(`tail row ${tailTaskId} not found in Comments`);
  }

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
  await sheets.spreadsheets.values.update({
    spreadsheetId: commentsSsId,
    range: `Comments!${colLetter(colBlocks + 1)}${sheetRowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[JSON.stringify(newBlocks)]] },
  });
}
