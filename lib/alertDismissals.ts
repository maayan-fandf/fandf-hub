/**
 * Firestore-backed store for morning-alert dismissals (team-wide snoozes).
 *
 * This replaces the Apps Script report's "Alert Dismissals" sheet. The
 * report (Client Dashboard) now reads/writes these via the
 * /api/alert-dismissals endpoint instead of the sheet; the Hub's own
 * dismiss UI continues to flow through the report. One doc per
 * `signal_key` (doc id = base64url of the key) so the latest dismissal
 * for a key wins — matching the sheet's "one row per signal_key" rule.
 *
 * Server-only (uses the Firestore admin client from lib/firestore).
 */

import { getDb, FS_COLLECTIONS } from "@/lib/firestore";
import type { MorningSignal } from "@/lib/appsScript";

export type AlertDismissal = {
  user_email: string;
  signal_key: string;
  dismissed_at: string;
  snooze_until: string;
  reason: string;
};

/** Firestore doc ids can't contain "/" and have other limits — base64url
 *  the signal_key for a safe, deterministic, collision-free id. */
function keyToDocId(signalKey: string): string {
  return Buffer.from(String(signalKey), "utf8").toString("base64url");
}

/**
 * All dismissals as a map keyed by signal_key:
 *   { [signal_key]: { user_email, signal_key, dismissed_at, snooze_until, reason } }
 * One doc per key, so no "most recent wins" reconciliation is needed.
 */
export async function listAlertDismissals(): Promise<Record<string, AlertDismissal>> {
  const db = getDb();
  const snap = await db.collection(FS_COLLECTIONS.alertDismissals).get();
  const out: Record<string, AlertDismissal> = {};
  snap.forEach((doc) => {
    const d = doc.data() as Partial<AlertDismissal>;
    const key = String(d.signal_key || "").trim();
    if (!key) return;
    out[key] = {
      user_email: String(d.user_email || "").toLowerCase().trim(),
      signal_key: key,
      dismissed_at: String(d.dismissed_at || ""),
      snooze_until: String(d.snooze_until || ""),
      reason: String(d.reason || ""),
    };
  });
  return out;
}

/**
 * Upsert one dismissal. doc id is derived from signal_key, so this is a
 * team-wide replace (the user_email column is audit only, matching the
 * sheet's semantics). `dismissed_at` defaults to now when not supplied.
 */
export async function upsertAlertDismissal(input: {
  user_email: string;
  signal_key: string;
  snooze_until: string;
  reason?: string;
  dismissed_at?: string;
}): Promise<AlertDismissal> {
  const key = String(input.signal_key || "").trim();
  if (!key) throw new Error("signal_key is required");
  const rec: AlertDismissal = {
    user_email: String(input.user_email || "").toLowerCase().trim(),
    signal_key: key,
    dismissed_at: String(input.dismissed_at || new Date().toISOString()),
    snooze_until: String(input.snooze_until || ""),
    reason: String(input.reason || ""),
  };
  const db = getDb();
  await db
    .collection(FS_COLLECTIONS.alertDismissals)
    .doc(keyToDocId(key))
    .set(rec);
  return rec;
}

/**
 * Apply the dismissal store to hub-generated signals (e.g. crmAlerts),
 * which — unlike the report's own morning signals — don't get dismissal
 * state applied server-side. Mirrors the report's dismissalStateFor:
 *   - active snooze (snooze_until >= today, Asia/Jerusalem) → dismissed
 *   - expired snooze → revisit (resurfaced, flagged as previously handled)
 *   - none → unchanged
 * Pure + synchronous; the caller fetches the dismissals map once.
 */
export function applyDismissalsToSignals(
  signals: MorningSignal[],
  dismissals: Record<string, AlertDismissal>,
): MorningSignal[] {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
  }).format(new Date());
  return signals.map((s) => {
    const d = s.key ? dismissals[s.key] : undefined;
    if (!d) return s;
    const until = String(d.snooze_until || "").slice(0, 10);
    if (until && until >= today) {
      return {
        ...s,
        dismissed: true,
        dismissedAt: d.dismissed_at || "",
        dismissedUntil: d.snooze_until || "",
        dismissedBy: d.user_email || "",
      };
    }
    return {
      ...s,
      revisit: true,
      previouslyDismissedAt: d.dismissed_at || "",
      previouslySnoozedUntil: d.snooze_until || "",
    };
  });
}
