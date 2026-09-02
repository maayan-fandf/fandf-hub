/**
 * One place to drop every budget/report-facing cross-request cache. Cheap —
 * each call just marks a tag stale so the NEXT read re-fetches; no Sheet I/O.
 *
 * Called from two sides so budget edits feel instant either way:
 *   • /api/revalidate-budgets — the Apps Script onEdit webhook (Sheet → Hub).
 *   • the budget desk apply route — after the Hub writes G (Hub → Sheet → Hub).
 */
import { revalidateTag } from "next/cache";
import { invalidateAllClientsCache } from "./allClients";
import { invalidateReportPlatformCache } from "./reportData";
import { revalidateBudgetMaster } from "./budgetMaster";

export async function bustBudgetCaches(): Promise<void> {
  invalidateAllClientsCache(); // ALL CLIENTS (per-channel budget + spend)
  invalidateReportPlatformCache(); // daily platform rows (report spend charts)
  revalidateBudgetMaster(); // budget desk master (E3 + pacing)
  revalidateTag("morning-feed"); // home pills + /morning signals
  // The precomputed portfolio feed too — it is a Firestore doc, so the
  // tag above does not reach it, and its max-age is hours rather than
  // the 5-minute TTL. Dropping it makes the next read go live once and
  // the cron refill it. Awaited (hence the async signature) because a
  // floating promise in a route handler can be cut off at response.
  const { invalidateMorningSnapshot } = await import("./morningSnapshot");
  await invalidateMorningSnapshot();
}
