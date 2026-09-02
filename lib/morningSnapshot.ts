import { getDb } from "@/lib/firestore";
import type { MorningFeed } from "@/lib/appsScript";

/**
 * Precomputed portfolio morning feed, so no user request ever waits on
 * Apps Script's `_morningFeed_`.
 *
 * ── Why ──
 * That call is the slowest thing the hub does by an order of magnitude.
 * Measured cold: 110.4s (2026-08-04) → 112s median over 9 samples
 * (2026-08-16) → 124s median over 3 samples (2026-09-01), against a
 * fixed 170s abort ceiling. The median is still inside budget but the
 * variance is ±20s and the drift is monotonic, so the tail already
 * crosses: a local session on 2026-09-01 logged several consecutive
 * `FAILED after 170.0s`, and one run exceeded 230s.
 *
 * Every previous fix was a mitigation of the symptom — raise the
 * timeout 45s→170s, raise the TTL 60s→300s, add a serve-stale floor,
 * take the feed off the home page. None of them removed a single
 * second from the call, which is why it keeps coming back. Reading a
 * snapshot instead is the first change that makes the duration stop
 * mattering: at 124s or at 400s, nobody is waiting on it.
 *
 * ── Why ONE global doc is correct ──
 * Not an assumption — `getMorningFeed` already shares a single cache
 * entry for scope=all among all internal callers, and the argument is
 * spelled out there: in `_morningFeed_` (Code.js L5838) scope='all'
 * never populates `allowedSet`, `scoped = allProjects` with no per-user
 * filtering, and dismissals come from the global
 * `_getAllAlertDismissals_()`. Only the echoed envelope (email /
 * isAdmin / isInternal) varies by caller, and the reader below
 * overwrites those three fields with the actual caller's.
 *
 * Per-person narrowing still happens, one layer up: /morning filters
 * the feed through `scopedProjectNames` against the Keys roster. So the
 * snapshot is the portfolio, never somebody's private view.
 *
 * scope=mine and project-scoped feeds are NOT snapshotted — they are
 * roster-scoped per caller, and one shared slot there would leak
 * another user's projects. They keep the existing live path.
 */

const DOC = "morningFeedAll";

/** Older than this and the reader ignores it and goes live, so a dead
 *  cron degrades to today's behaviour instead of pinning stale alerts.
 *  Generous relative to any sane cron cadence — the point is to catch a
 *  cron that stopped, not to expire a healthy snapshot. */
export const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type MorningSnapshot = {
  feed: MorningFeed;
  fetchedAt: string;
  /** Seconds the underlying Apps Script call took, for the trend log. */
  tookSeconds: number;
};

function col() {
  return getDb().collection("systemSnapshots");
}

/**
 * The stored portfolio feed, or null when there is none, it is too old,
 * or Firestore is unreachable. Never throws: every caller has a working
 * live path to fall back to, and a snapshot problem must not be able to
 * take the page down.
 */
export async function readMorningSnapshot(): Promise<MorningSnapshot | null> {
  try {
    const snap = await col().doc(DOC).get();
    if (!snap.exists) return null;
    const v = snap.data() as MorningSnapshot | undefined;
    if (!v?.feed || !Array.isArray(v.feed.projects)) return null;
    const age = Date.now() - (Date.parse(v.fetchedAt) || 0);
    if (!Number.isFinite(age) || age > SNAPSHOT_MAX_AGE_MS) return null;
    return v;
  } catch {
    return null;
  }
}

export async function writeMorningSnapshot(
  feed: MorningFeed,
  tookSeconds: number,
): Promise<void> {
  // Same guard the in-process last-good floor uses: `scope: 'none'` is
  // Apps Script's refusal envelope and passes every structural test
  // intact. Storing one would pin "no alerts" for every viewer until the
  // next successful run.
  if (!feed || !Array.isArray(feed.projects) || feed.scope === "none") {
    throw new Error(
      `refusing to snapshot a non-feed (scope=${feed?.scope ?? "?"})`,
    );
  }
  await col()
    .doc(DOC)
    .set({ feed, fetchedAt: new Date().toISOString(), tookSeconds });
}

/**
 * Drop the snapshot so the next read goes live.
 *
 * Called wherever `revalidateTag("morning-feed")` already fires — a
 * dismissal or an unsnooze changes which signals should show, and
 * waiting out the cron would make the button look broken. This
 * deliberately restores today's cost profile for exactly that one
 * request (one slow live call, then cached again), rather than
 * inventing an optimistic-update path that could disagree with what
 * Apps Script computes next.
 */
export async function invalidateMorningSnapshot(): Promise<void> {
  try {
    await col().doc(DOC).delete();
  } catch {
    /* best-effort: the tag revalidation alongside it still applies */
  }
}
