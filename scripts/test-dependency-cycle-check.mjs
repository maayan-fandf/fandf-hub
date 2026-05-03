/* eslint-disable */
/**
 * Smoke test for lib/dependencyCycleCheck.ts. Exercises the four
 * scenarios that matter:
 *   1. Adding A→B in an empty graph: OK
 *   2. Self-edge A→A: cycle
 *   3. Direct back-edge A→B existing, then proposed B→A: cycle
 *   4. Transitive A→B→C, then proposed C→A: cycle (multi-hop)
 *   5. Diamond A→B, A→C, B→D, C→D, then proposed D→A: cycle (single back edge through diamond)
 *
 * Run: node scripts/test-dependency-cycle-check.mjs
 *
 * Compiled-from-TS via tsx-on-the-fly is overkill for a one-file pure
 * function. We just inline-import the source via a tiny shim — this
 * file is throwaway and never ships to production.
 */
import { wouldCreateCycle, buildBlocksGraph } from "../lib/dependencyCycleCheck.ts";

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

// 1. Empty graph
{
  const g = buildBlocksGraph([]);
  const r = wouldCreateCycle("A", "B", g);
  assert("empty graph: A→B is OK", r.ok === true);
}

// 2. Self-edge
{
  const g = buildBlocksGraph([{ id: "A", blocks: [] }]);
  const r = wouldCreateCycle("A", "A", g);
  assert("self-edge: A→A is a cycle", r.ok === false);
}

// 3. Direct back-edge
{
  const g = buildBlocksGraph([
    { id: "A", blocks: ["B"] },
    { id: "B", blocks: [] },
  ]);
  const r = wouldCreateCycle("B", "A", g);
  assert("direct back-edge: B→A when A→B exists is a cycle", r.ok === false);
}

// 4. Transitive
{
  const g = buildBlocksGraph([
    { id: "A", blocks: ["B"] },
    { id: "B", blocks: ["C"] },
    { id: "C", blocks: [] },
  ]);
  const r = wouldCreateCycle("C", "A", g);
  assert(
    "transitive: C→A when A→B→C exists is a cycle",
    r.ok === false,
    r.ok ? "(no cycle reported)" : `cycle=${r.cycle.join("→")}`,
  );
}

// 5. Diamond — D→A would close two paths; we only need one detected
{
  const g = buildBlocksGraph([
    { id: "A", blocks: ["B", "C"] },
    { id: "B", blocks: ["D"] },
    { id: "C", blocks: ["D"] },
    { id: "D", blocks: [] },
  ]);
  const r = wouldCreateCycle("D", "A", g);
  assert("diamond: D→A through A→{B,C}→D is a cycle", r.ok === false);
}

// 6. Two disjoint chains — A→B, C→D — proposed B→C should NOT cycle
{
  const g = buildBlocksGraph([
    { id: "A", blocks: ["B"] },
    { id: "B", blocks: [] },
    { id: "C", blocks: ["D"] },
    { id: "D", blocks: [] },
  ]);
  const r = wouldCreateCycle("B", "C", g);
  assert("disjoint chains: B→C is OK (no path back to B)", r.ok === true);
}

// 7. Long chain — A→B→C→D→E, proposed E→A is a cycle
{
  const g = buildBlocksGraph([
    { id: "A", blocks: ["B"] },
    { id: "B", blocks: ["C"] },
    { id: "C", blocks: ["D"] },
    { id: "D", blocks: ["E"] },
    { id: "E", blocks: [] },
  ]);
  const r = wouldCreateCycle("E", "A", g);
  assert("5-deep chain: E→A is a cycle", r.ok === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
