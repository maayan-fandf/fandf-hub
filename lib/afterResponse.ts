import { after } from "next/server";

/**
 * Run best-effort side-effect work AFTER the HTTP response is flushed,
 * isolating errors so a failure can never crash the route handler. Thin
 * wrapper over Next's `after()` — a shared twin of the local helper in
 * lib/commentsWriteDirect.ts, so the tasks write-path can defer its
 * notification / recompute side-effects off the response critical path
 * the same way.
 *
 * Use ONLY for work that does NOT gate the user-visible response and is
 * not read-after-write on the immediate next render (notifications,
 * Chat webhooks, best-effort recomputes). Anything the response payload
 * or the destination page depends on must stay awaited inline.
 */
export function deferAfterResponse(fn: () => Promise<void>): void {
  after(async () => {
    try {
      await fn();
    } catch (e) {
      console.log("[afterResponse] deferred work failed:", e);
    }
  });
}
