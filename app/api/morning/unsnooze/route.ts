import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { unsnoozeMorningSignal } from "@/lib/appsScript";
import { removeAlertDismissal } from "@/lib/alertDismissals";

/**
 * POST /api/morning/unsnooze
 *
 * Clears a morning-alert dismissal so the alert immediately re-fires.
 *
 * Why two stores: dismissals are persisted in BOTH
 *   - Firestore (alertDismissals collection — written by hub +
 *     by Apps Script's _dismissAlert_ via POST /api/alert-dismissals);
 *   - the report's legacy "Alert Dismissals" sheet (left in place for
 *     fallback + audit).
 *
 * Apps Script's `_unsnoozeAlert_` only deletes from the legacy SHEET
 * (see Code.js:3793 — comment explicitly notes this). If we only call
 * the Apps Script side, the Firestore record survives, the next morning-
 * feed render reads it back, and the alert stays dimmed — exactly the
 * "↺ בטל טיפול does nothing" symptom that surfaced after we started
 * auto-dismissing via send-to-chat (which writes Firestore).
 *
 * Fix: clear BOTH stores. Apps Script wipes the sheet copy + its memo;
 * removeAlertDismissal wipes the Firestore copy. Then revalidate the
 * morning-feed unstable_cache (60s window) so the next page render
 * doesn't return a stale cached payload that still flags the signal
 * as dismissed.
 *
 * Both side-stores are best-effort: a partial failure surfaces in the
 * response payload rather than nuking the whole call. The Firestore
 * clear is what actually matters for surface re-rendering today; the
 * Apps Script call is kept for sheet hygiene + so future renders that
 * fall back to the sheet (Firestore outage) still see the unsnooze.
 */
export async function POST(req: NextRequest) {
  let body: { signalKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { signalKey } = body;
  if (!signalKey) {
    return NextResponse.json({ error: "signalKey required" }, { status: 400 });
  }

  // Clear the Firestore record. This is the one the morning feed
  // actually reads on render — without it the alert keeps showing as
  // dismissed even after a "successful" Apps Script call.
  let firestore: { removed: boolean } | { error: string };
  try {
    firestore = await removeAlertDismissal(signalKey);
  } catch (err) {
    firestore = { error: err instanceof Error ? err.message : String(err) };
  }

  // Clear the legacy sheet copy + Apps Script's in-memory memo of the
  // dismissals map (so the next read from the report's side is clean).
  let appsScript: { ok: boolean; removed: boolean } | { error: string };
  try {
    appsScript = await unsnoozeMorningSignal(signalKey);
  } catch (err) {
    appsScript = { error: err instanceof Error ? err.message : String(err) };
  }

  // Bust the hub's 60s morning-feed cache so the next render re-fetches
  // and the user sees the alert re-appear immediately after refresh()
  // instead of waiting up to a minute for the cache to expire.
  try {
    revalidateTag("morning-feed");
  } catch {
    /* revalidateTag is best-effort; cache will lapse within 60s anyway */
  }

  // 200 only if at least one store actually responded. The frontend
  // treats !res.ok as failure and shows the bilingual error alert.
  const firestoreFailed = "error" in firestore;
  const appsScriptFailed = "error" in appsScript;
  if (firestoreFailed && appsScriptFailed) {
    return NextResponse.json(
      { error: "Both stores failed", firestore, appsScript },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    firestore,
    appsScript,
  });
}
