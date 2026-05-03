/**
 * Chain creation orchestrator — creates 1 umbrella container row + N
 * sequential child tasks linked by `blocks` / `blocked_by` edges in
 * a single API call.
 *
 * Usage:
 *   tasksCreateChainDirect(subject, {
 *     project: "אפרידר",
 *     umbrella: { title: "Q1 visual update" },
 *     steps: [
 *       { title: "Copy",   assignees: ["copy@..."] },
 *       { title: "Art",    assignees: ["art@..."] },
 *       { title: "Studio", assignees: ["studio@..."] },
 *       { title: "Media",  assignees: ["media@..."] },
 *     ],
 *   });
 *
 * After this returns:
 *   - Umbrella row exists (is_umbrella=true, no GTs, no Drive folder,
 *     status auto-derived from children = "awaiting_handling" since
 *     step 1 is awaiting_handling and steps 2..N are blocked)
 *   - Step 1 is in `awaiting_handling` with a personal GT in its
 *     assignees' Tasks lists (immediately actionable)
 *   - Steps 2..N are `blocked` with NO GTs (defer until cascade)
 *   - Each step's `blocks`, `blocked_by`, `umbrella_id` cells are
 *     wired correctly
 *
 * The cascade auto-unblocks each next step when the previous step
 * reaches `done` (lib/dependencyCascade.ts). The umbrella's status
 * recomputes on every child mutation (lib/umbrellaRecompute.ts).
 *
 * IDs are pre-generated locally so we can wire the dep edges in
 * one pass (no second sheet write to set blocks/blocked_by after
 * children exist). The TasksCreateInput.id override added in
 * phase 5 makes this work without touching the existing genId path.
 *
 * Cycle detection: a sequential chain can't cycle by construction
 * (1 → 2 → 3 → … → N has no back-edges). Cycle check is run anyway
 * as a defensive guard against future API misuse.
 *
 * Phase 5 of dependencies feature, 2026-05-03.
 */

// Imports for tasksCreateDirect / cycle helpers are lazy (in the
// function body) — same probe-script-friendly pattern as
// lib/dependencyCascade.ts and lib/umbrellaRecompute.ts. The @/
// path alias isn't resolved by `node --experimental-strip-types`
// at module load, so any top-level value import from `@/lib/*`
// breaks probe scripts that import this module directly. Type-only
// imports below are erased and stay as-is.
import type { WorkTask } from "@/lib/appsScript";

export type TasksCreateChainInput = {
  project: string;
  /** Optional company override; resolves from Keys when absent. */
  company?: string;
  brief?: string;
  campaign?: string;
  /** Departments inherited by every child step that doesn't set its own. */
  departments?: string[];
  /** The umbrella container row that rolls everything up. */
  umbrella: {
    title: string;
    description?: string;
  };
  /** Sequential pipeline. First entry's blocked_by is empty (it
   *  starts immediately); each subsequent entry's blocked_by is
   *  the previous entry's ID. Must contain at least 1 step. */
  steps: Array<{
    title: string;
    description?: string;
    assignees?: string[];
    /** Optional approver per step — same semantics as the standalone
     *  task. When set, the step transitions through awaiting_approval
     *  before reaching done. */
    approver_email?: string;
    /** Optional per-step departments override; defaults to chain
     *  departments. */
    departments?: string[];
    /** Optional per-step due date (YYYY-MM-DD). */
    requested_date?: string;
  }>;
};

export type TasksCreateChainResult = {
  ok: true;
  umbrella: WorkTask;
  children: WorkTask[];
};

export async function tasksCreateChainDirect(
  subjectEmail: string,
  payload: TasksCreateChainInput,
): Promise<TasksCreateChainResult> {
  if (!payload.project) {
    throw new Error("tasksCreateChain: project is required");
  }
  if (!payload.umbrella?.title?.trim()) {
    throw new Error("tasksCreateChain: umbrella.title is required");
  }
  if (!Array.isArray(payload.steps) || payload.steps.length === 0) {
    throw new Error("tasksCreateChain: at least one step is required");
  }
  for (const [i, s] of payload.steps.entries()) {
    if (!s?.title?.trim()) {
      throw new Error(`tasksCreateChain: step ${i + 1} title is required`);
    }
  }

  // Lazy imports — see top-of-file note on the @/-alias-vs-strip-types
  // friction. Resolved on first call; Node caches the module object.
  const { tasksCreateDirect, genId } = await import("@/lib/tasksWriteDirect");
  const { buildBlocksGraph, wouldCreateCycle } = await import(
    "@/lib/dependencyCycleCheck"
  );

  // Pre-generate IDs so we can wire the dep edges in one pass.
  const umbrellaId = genId();
  const childIds = payload.steps.map(() => genId());

  // Defensive cycle check on the chain's edge set. A linear chain
  // can't cycle by construction, but if we ever extend to non-linear
  // chains (DAGs) the same code path catches misuse.
  const edges: Array<{ from: string; to: string; blocks: string[] }> = [];
  for (let i = 0; i < childIds.length; i++) {
    const blocks = i < childIds.length - 1 ? [childIds[i + 1]] : [];
    edges.push({ from: childIds[i], to: blocks[0] || "", blocks });
  }
  // Build the proposed graph and validate every new edge.
  const proposedGraph = buildBlocksGraph(
    edges.map((e) => ({ id: e.from, blocks: e.blocks })),
  );
  for (const e of edges) {
    if (!e.to) continue;
    const r = wouldCreateCycle(e.from, e.to, proposedGraph);
    if (!r.ok) {
      throw new Error(
        `tasksCreateChain: would create cycle ${r.cycle.join(" → ")}`,
      );
    }
  }

  // Step 1 — create the umbrella container. is_umbrella=true so the
  // createTask flow skips Drive folder; assignees=[] so GT spawn +
  // notification both no-op naturally. Status starts at
  // awaiting_handling; the umbrella recompute hook fires on each
  // child create below to converge the umbrella's derived status.
  const umbrellaRes = await tasksCreateDirect(subjectEmail, {
    id: umbrellaId,
    project: payload.project,
    company: payload.company,
    brief: payload.brief,
    campaign: payload.campaign,
    departments: payload.departments,
    title: payload.umbrella.title.trim(),
    description: payload.umbrella.description ?? "",
    is_umbrella: true,
    // Explicit status so the createTask defaulting (which would
    // otherwise leave it at awaiting_handling) is unambiguous.
    status: "awaiting_handling",
  });

  // Step 2 — create each child sequentially. Each child carries:
  //   umbrella_id  → the umbrella's pre-known ID
  //   blocks       → next child's ID (empty for the last step)
  //   blocked_by   → previous child's ID (empty for the first step)
  // First child starts in awaiting_handling (createTask spawns its GT);
  // subsequent children start in blocked (createTask skips GT spawn
  // per phase 3). Cascade in lib/dependencyCascade.ts will flip each
  // next step out of blocked when the previous reaches done.
  const childTasks: WorkTask[] = [];
  for (let i = 0; i < payload.steps.length; i++) {
    const step = payload.steps[i];
    const blocks = i < childIds.length - 1 ? [childIds[i + 1]] : [];
    const blockedBy = i > 0 ? [childIds[i - 1]] : [];
    const res = await tasksCreateDirect(subjectEmail, {
      id: childIds[i],
      project: payload.project,
      company: payload.company,
      brief: payload.brief,
      campaign: payload.campaign,
      departments: step.departments ?? payload.departments,
      title: step.title.trim(),
      description: step.description ?? "",
      assignees: step.assignees ?? [],
      approver_email: step.approver_email,
      requested_date: step.requested_date,
      umbrella_id: umbrellaId,
      blocks,
      blocked_by: blockedBy,
      // Status defaulting in createTask: empty blocked_by → awaiting_handling
      // (first step), non-empty blocked_by → blocked (downstream steps).
      // We don't pass `status` so the default kicks in.
    });
    childTasks.push(res.task);
  }

  return {
    ok: true,
    umbrella: umbrellaRes.task,
    children: childTasks,
  };
}
