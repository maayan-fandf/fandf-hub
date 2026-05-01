/**
 * Fast in-band GT → hub sync for the active user.
 *
 * Fired from /api/tasks/pending-count (which the top-nav badge re-runs
 * on every navigation), so any time the user opens the hub or switches
 * pages, we get a sub-second-feel sync of their personal Tasks list.
 * The 1-min Cloud Scheduler poller still catches the offline case
 * (user marks GT done, doesn't open the hub for a while).
 *
 * Cost: one Tasks API list call per render. Filtered with `updatedMin`
 * + `showCompleted=true` so we only fetch entries the user actually
 * touched recently. Typical payload is empty or 1-2 items.
 *
 * Window sizing: bootstrap is 5 minutes. After the first call for a
 * user we track the high-water `updated` timestamp we've seen and
 * use it as the floor for subsequent cutoffs (with a 30s overlap to
 * tolerate clock skew). This prevents the original "every nav-poll
 * re-checks the last 60 minutes of GTs" pattern that pushed the
 * applyAutoTransition fan-out into 30-60s territory under steady
 * activity. The cron poller covers anything older than the bootstrap
 * window inside its 1-minute cadence.
 *
 * Side effect: applyAutoTransition for every completed hub-spawned GT
 * (notes carrying the hub deep-link) since the cutoff. Idempotent —
 * re-firing within the same window is a no-op because the hub task's
 * status will have already moved past the GT's stage.
 */

import { tasksApiClient } from "@/lib/sa";
import { applyAutoTransition } from "@/lib/autoTransition";
import type { GTaskKind } from "@/lib/appsScript";

const HUB_TASK_URL_PATTERN =
  /https:\/\/hub\.fandf\.co\.il\/tasks\/([A-Za-z0-9_-]+)/;

const KIND_PREFIX_TO_KIND: Record<string, GTaskKind> = {
  "📋 לבצע": "todo",
  "✅ לאישור": "approve",
  "❓ לבירור": "clarify",
};

/** Bootstrap window for users we haven't seen this process lifetime.
 *  Was 60 min (covered "user marked GT done an hour ago, opens hub
 *  now") but every badge poll re-evaluated the entire hour, costing
 *  one full Comments-sheet read per candidate. The cron polls every
 *  minute so anything beyond a few minutes is the cron's job; 5
 *  minutes leaves enough headroom for "user does GT then keeps
 *  scrolling" without the redundant fan-out. */
const FAST_SYNC_BOOTSTRAP_WINDOW_MS = 5 * 60 * 1000;

/** Overlap to absorb clock skew between this server, the Tasks API,
 *  and the user's device when their device updated the GT. Never
 *  shrink below ~10s; 30s is comfortable. */
const FAST_SYNC_OVERLAP_MS = 30 * 1000;

/** Per-user high-water mark of the most recent `updated` timestamp we
 *  successfully processed. In-process Map; lost on container restart,
 *  which is fine — the next call falls back to the bootstrap window
 *  and re-evaluates 5 minutes worth of GTs (idempotent). The Map
 *  grows by one entry per active user, which is bounded by the
 *  organization size. */
const lastProcessedByEmail = new Map<string, number>();

export type FastSyncResult = {
  scanned: number;
  dispatched: number;
  skipped: number;
  errored: number;
  durationMs: number;
};

/** Find a hub task id in the GT's notes. Hub-spawned GTs always carry
 *  the deep-link near the top; non-hub GTs (Gmail-origin or manual)
 *  return "". */
function extractHubTaskId(notes: string | null | undefined): string {
  if (!notes) return "";
  const m = String(notes).match(HUB_TASK_URL_PATTERN);
  return m ? m[1] : "";
}

/** Infer the GT's `kind` from its title prefix. Fallback to `todo`
 *  when no prefix matches — same default applyAutoTransition uses
 *  for legacy refs without a stored kind. */
function inferKind(title: string | null | undefined): GTaskKind {
  const t = String(title ?? "").trim();
  // Reissued todos start with "🔄 " — strip before matching.
  const stripped = t.replace(/^🔄\s+/, "");
  for (const [prefix, kind] of Object.entries(KIND_PREFIX_TO_KIND)) {
    if (stripped.startsWith(prefix)) return kind;
  }
  return "todo";
}

export async function syncUserCompletions(
  subjectEmail: string,
): Promise<FastSyncResult> {
  const start = Date.now();

  // Cutoff = max(start - bootstrap, lastProcessed - overlap). On the
  // first call for a user the Map miss falls through to bootstrap; on
  // subsequent calls we only re-fetch GTs updated since the high-water
  // mark (with a small overlap to tolerate skew). Idempotent under
  // race: applyAutoTransition itself skips when the hub task already
  // moved past the GT's stage, so even an over-wide cutoff is safe.
  const subjectKey = subjectEmail.toLowerCase().trim();
  const lastProcessed = lastProcessedByEmail.get(subjectKey);
  const cutoffMs = Math.max(
    start - FAST_SYNC_BOOTSTRAP_WINDOW_MS,
    lastProcessed != null ? lastProcessed - FAST_SYNC_OVERLAP_MS : 0,
  );
  const cutoff = new Date(cutoffMs).toISOString();
  const tasksApi = tasksApiClient(subjectEmail);

  // Find the user's default tasklist. Same convention as
  // tasksWriteDirect.createGoogleTasks (impersonated subject's first
  // list = "@default").
  const lists = await tasksApi.tasklists.list({ maxResults: 1 });
  const listId = lists.data.items?.[0]?.id;
  if (!listId) {
    return summary(start, 0, 0, 0, 0);
  }

  // Pull every entry updated since `cutoff` — completed or not. We
  // filter to status=completed below; the API returns both because we
  // need showCompleted=true so completed entries aren't hidden.
  const res = await tasksApi.tasks.list({
    tasklist: listId,
    showCompleted: true,
    showHidden: false,
    updatedMin: cutoff,
    maxResults: 100,
  });
  const items = res.data.items ?? [];

  // Track the highest `updated` timestamp we observed in THIS pull so
  // the next call can use it as a floor — even items we skip (status
  // != completed, no hub link) count, because they shouldn't be
  // re-pulled either.
  let highWaterMs = lastProcessed ?? 0;
  for (const t of items) {
    if (!t.updated) continue;
    const ms = Date.parse(t.updated);
    if (Number.isFinite(ms) && ms > highWaterMs) highWaterMs = ms;
  }

  const candidates = items
    .filter((t) => t.status === "completed")
    .map((t) => ({
      id: t.id || "",
      title: t.title || "",
      notes: t.notes || "",
      hubTaskId: extractHubTaskId(t.notes),
    }))
    .filter((c) => c.hubTaskId);

  let dispatched = 0;
  let skipped = 0;
  let errored = 0;

  for (const c of candidates) {
    const kind = inferKind(c.title);
    try {
      const result = await applyAutoTransition({
        taskId: c.hubTaskId,
        kind,
        completedBy: subjectEmail,
      });
      if ("error" in result) {
        errored++;
      } else if (result.skipped) {
        skipped++;
      } else {
        dispatched++;
      }
    } catch (e) {
      errored++;
      console.log(
        `[userFastSync] auto-transition failed for ${c.hubTaskId}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // Commit the high-water mark only after a successful run (errors in
  // applyAutoTransition shouldn't block advancement — those entries
  // are already past the GT-list cutoff and the cron will retry).
  if (highWaterMs > 0) {
    lastProcessedByEmail.set(subjectKey, highWaterMs);
  }

  return summary(start, candidates.length, dispatched, skipped, errored);
}

function summary(
  start: number,
  scanned: number,
  dispatched: number,
  skipped: number,
  errored: number,
): FastSyncResult {
  return { scanned, dispatched, skipped, errored, durationMs: Date.now() - start };
}
