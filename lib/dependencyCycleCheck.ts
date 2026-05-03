/**
 * Cycle detection for task dependency graphs.
 *
 * Used by phase-2 (auto-transition status logic) and phase-5 (chain
 * creation drawer) to refuse `A.blocks=[B]` edges that would close a
 * loop. Without this, a chain like A→B→A leaves both tasks permanently
 * blocked since each waits for the other to flip to `done`.
 *
 * Design: pure function over an in-memory adjacency map. Caller fetches
 * the relevant subgraph (typically all tasks reachable forward from the
 * candidate downstream) and passes it in. Keeps this module free of
 * side effects + Sheets API dependencies — easy to unit-test and easy
 * to call from any code path (server actions, write helpers, scripts).
 *
 * Cost analysis: BFS is O(V+E) over reachable subgraph. In F&F's
 * workflow, chains rarely span more than ~10 tasks, so this is O(10s)
 * per add — negligible compared to the Sheets read itself.
 */

export type DependencyEdge = {
  /** Task ID */
  id: string;
  /** Task IDs this task BLOCKS (its `blocks` cell) */
  blocks: string[];
};

export type CycleCheckResult =
  | { ok: true }
  | { ok: false; cycle: string[] };

/**
 * Check whether adding `from.blocks=[..., to]` would create a cycle.
 *
 * `from` is the upstream task gaining a new downstream edge; `to` is
 * the downstream candidate. Returns `ok:false` with the cyclic path
 * `[to, ..., from]` when the edge would close a loop, so callers can
 * surface a useful error message ("would create cycle: A → B → A").
 *
 * `graph` is the full dependency adjacency: every task ID this caller
 * cares about → its `blocks` array. Tasks not in `graph` are treated
 * as terminal (no downstream edges) — safe default since unknown IDs
 * can't extend a cycle through known ones.
 *
 * The check is a forward-BFS from `to`. If we ever reach `from`, the
 * proposed edge `from → to` closes the loop `from → to → … → from`.
 */
export function wouldCreateCycle(
  fromId: string,
  toId: string,
  graph: ReadonlyMap<string, ReadonlyArray<string>>,
): CycleCheckResult {
  if (!fromId || !toId) return { ok: true };
  // Self-edge is trivially a cycle (`A.blocks=[A]`).
  if (fromId === toId) return { ok: false, cycle: [fromId, fromId] };

  // BFS forward from `to`, tracking parent pointers so we can
  // reconstruct the path if we hit `from`.
  const parent = new Map<string, string>();
  const visited = new Set<string>([toId]);
  const queue: string[] = [toId];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const downstream = graph.get(cur) ?? [];
    for (const next of downstream) {
      if (!next) continue;
      if (next === fromId) {
        // Cycle found. Reconstruct: to → … → cur → from.
        const path: string[] = [next, cur];
        let p = parent.get(cur);
        while (p) {
          path.push(p);
          p = parent.get(p);
        }
        path.push(toId); // explicit terminal at the start of the path
        // Reverse to read in dependency order: to → … → from.
        // Then prepend `from` to make the displayed cycle clearer:
        // from → to → … → from.
        path.reverse();
        return { ok: false, cycle: [fromId, ...path] };
      }
      if (visited.has(next)) continue;
      visited.add(next);
      parent.set(next, cur);
      queue.push(next);
    }
  }
  return { ok: true };
}

/**
 * Build the adjacency map needed by `wouldCreateCycle` from a task
 * list. Each task's `id` maps to its `blocks` array; tasks with empty
 * `blocks` still appear in the map (as empty arrays) so callers can
 * tell "known but terminal" from "unknown ID".
 */
export function buildBlocksGraph(
  tasks: ReadonlyArray<{ id: string; blocks: ReadonlyArray<string> }>,
): Map<string, ReadonlyArray<string>> {
  const m = new Map<string, ReadonlyArray<string>>();
  for (const t of tasks) {
    if (t.id) m.set(t.id, t.blocks ?? []);
  }
  return m;
}
