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

const FAST_SYNC_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

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
  const cutoff = new Date(start - FAST_SYNC_WINDOW_MS).toISOString();
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
