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

export function bustBudgetCaches(): void {
  invalidateAllClientsCache(); // ALL CLIENTS (per-channel budget + spend)
  invalidateReportPlatformCache(); // daily platform rows (report spend charts)
  revalidateBudgetMaster(); // budget desk master (E3 + pacing)
  revalidateTag("morning-feed"); // home pills + /morning signals
}
