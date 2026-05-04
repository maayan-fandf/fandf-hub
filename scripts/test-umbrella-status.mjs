/* eslint-disable */
/**
 * Smoke test for lib/umbrellaStatus.ts deriveUmbrellaStatus.
 * Run: node scripts/test-umbrella-status.mjs
 */
import { deriveUmbrellaStatus, deriveUmbrellaProgress } from "../lib/umbrellaStatus.ts";

let passed = 0;
let failed = 0;
function assertEq(label, got, want) {
  if (got === want) { console.log(`  ✓ ${label} → ${got}`); passed++; }
  else { console.log(`  ✗ ${label} → ${got}, expected ${want}`); failed++; }
}

// Status derivation matrix
assertEq("empty",                        deriveUmbrellaStatus([]),                              "awaiting_handling");
assertEq("all done",                     deriveUmbrellaStatus(["done","done","done"]),          "done");
assertEq("all cancelled",                deriveUmbrellaStatus(["cancelled","cancelled"]),       "cancelled");
assertEq("all blocked",                  deriveUmbrellaStatus(["blocked","blocked"]),           "awaiting_handling");
assertEq("all awaiting_handling",        deriveUmbrellaStatus(["awaiting_handling","awaiting_handling"]), "awaiting_handling");
assertEq("any in_progress",              deriveUmbrellaStatus(["blocked","in_progress","blocked"]), "in_progress");
assertEq("any awaiting_clarification",   deriveUmbrellaStatus(["done","awaiting_clarification"]), "in_progress");
assertEq("any awaiting_approval",        deriveUmbrellaStatus(["awaiting_approval","done"]),    "in_progress");
assertEq("done + cancelled mix",         deriveUmbrellaStatus(["done","cancelled","done"]),     "done");
assertEq("draft only",                   deriveUmbrellaStatus(["draft","draft"]),               "awaiting_handling");
assertEq("done + blocked",               deriveUmbrellaStatus(["done","blocked"]),              "awaiting_handling");
assertEq("done + awaiting_handling",     deriveUmbrellaStatus(["done","awaiting_handling"]),    "awaiting_handling");

// Progress
const p1 = deriveUmbrellaProgress(["done","done","blocked","awaiting_handling"]);
assertEq("progress done count",  p1.done, 2);
assertEq("progress total count", p1.total, 4);
assertEq("progress displayHe",   p1.displayHe, "2 / 4 ✓");

const p2 = deriveUmbrellaProgress([]);
assertEq("empty progress",       p2.displayHe, "אין שלבים");

const p3 = deriveUmbrellaProgress(["done","cancelled","done"]);
assertEq("done+cancelled count", p3.done, 2);
assertEq("done+cancelled cancelled", p3.cancelled, 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
