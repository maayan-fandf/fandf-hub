/**
 * Deferred mention/reply email flusher (the 30s grace period).
 *
 * `notifyOnce` with `deferEmailUntil` set writes the in-hub bell row
 * immediately but stamps `emailed_at = "defer:<iso>"` instead of
 * sending the email. This module — invoked best-effort from the
 * every-minute `poll-tasks` cron — is what actually sends (or cancels)
 * those held emails:
 *
 *   - `defer:<iso>` and the iso has passed → eligible.
 *   - claim the row (`sending:<iso>`) + re-read to win exactly one
 *     flusher (poll-tasks can run on >1 instance; the in-flight guard
 *     only covers one container).
 *   - if the underlying comment doc no longer exists in Firestore →
 *     the message was deleted within the window → CANCEL (emailed_at
 *     back to "", terminal; the bell row stays — only the email is
 *     suppressed).
 *   - re-check the recipient's email pref (they may have toggled it
 *     during the window — the create-time check is intentionally
 *     skipped for deferred rows).
 *   - send via the SAME builder/sender `notifyOnce` uses (parity), as
 *     the stored actor; stamp `emailed_at = <iso now>`.
 *   - send failure → revert to the original `defer:` for the next tick,
 *     unless it's been stuck > GIVE_UP_MS (then drop it, terminal "").
 *
 * Storage is the existing Sheets `Notifications` tab (NOT in the
 * Firestore migration). `emailed_at` is referenced only in
 * lib/notifications.ts (no UI parses it), so the `defer:`/`sending:`
 * sentinels are inert to every other consumer.
 *
 * Never throws — returns counters; the poll-tasks call site logs them.
 */

import { sheetsClient, driveFolderOwner } from "@/lib/sa";
import {
  TAB,
  columnLetter,
  emailDefaultOn,
  buildNotificationEmail,
  sendNotificationEmail,
  type NotificationKind,
} from "@/lib/notifications";

/** Stale `sending:` claim age after which a row is reclaimable (the
 *  flusher that claimed it crashed/was frozen mid-send). */
const STUCK_CLAIM_MS = 5 * 60_000;
/** A row that keeps failing to send for this long is dropped so it
 *  doesn't get retried forever (terminal "" = never emailed). */
const GIVE_UP_MS = 15 * 60_000;

type FlushResult = {
  scanned: number;
  sent: number;
  cancelledDeleted: number;
  cancelledPref: number;
  gaveUp: number;
  reclaimed: number;
  errors: number;
};

function isoNow(): string {
  return new Date().toISOString();
}

export async function flushDeferredNotificationEmails(): Promise<FlushResult> {
  const r: FlushResult = {
    scanned: 0,
    sent: 0,
    cancelledDeleted: 0,
    cancelledPref: 0,
    gaveUp: 0,
    reclaimed: 0,
    errors: 0,
  };
  try {
    const ssId = process.env.SHEET_ID_COMMENTS;
    if (!ssId) return r;
    // Single admin identity for ALL ops — the per-recipient
    // sheetsClient(forEmail) pattern the rest of notifications.ts uses
    // is wrong here (one cron context patching many recipients' rows).
    // The SA only impersonates within @fandf.co.il; the bot owner has
    // edit access to the whole spreadsheet. Same identity poll-tasks
    // itself uses.
    const subjectEmail = driveFolderOwner();
    const sheets = sheetsClient(subjectEmail);

    let res;
    try {
      res = await sheets.spreadsheets.values.get({
        spreadsheetId: ssId,
        range: TAB,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
    } catch {
      // Tab missing / unreadable → nothing to flush this tick.
      return r;
    }
    const values = (res.data.values ?? []) as unknown[][];
    if (values.length < 2) return r;

    const headers = (values[0] as unknown[]).map((h) =>
      String(h ?? "").trim().toLowerCase(),
    );
    const idx = (h: string) => headers.indexOf(h);
    const iEmailed = idx("emailed_at");
    const iFor = idx("for_email");
    const iKind = idx("kind");
    const iComment = idx("comment_id");
    const iActor = idx("actor_email");
    const iProject = idx("project");
    const iTitle = idx("title");
    const iBody = idx("body");
    const iLink = idx("link");
    if (iEmailed < 0) return r; // schema unexpected — do nothing
    const emailedCol = columnLetter(iEmailed + 1);

    const now = Date.now();

    // Patch a single emailed_at cell. RAW so the sentinel string is
    // stored verbatim (not coerced to a date).
    const setCell = async (sheetRow: number, val: string): Promise<void> => {
      await sheets.spreadsheets.values.update({
        spreadsheetId: ssId,
        range: `${TAB}!${emailedCol}${sheetRow}`,
        valueInputOption: "RAW",
        requestBody: { values: [[val]] },
      });
    };
    const readCell = async (sheetRow: number): Promise<string> => {
      const g = await sheets.spreadsheets.values.get({
        spreadsheetId: ssId,
        range: `${TAB}!${emailedCol}${sheetRow}`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      return String(g.data.values?.[0]?.[0] ?? "");
    };

    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const sheetRow = i + 1; // sheet is 1-based, header is row 1
      const ea = String(row[iEmailed] ?? "");

      // Determine eligibility + the original due time.
      let due: number;
      let reclaiming = false;
      if (ea.startsWith("sending:")) {
        const claimedAt = Date.parse(ea.slice("sending:".length));
        if (!Number.isFinite(claimedAt) || now - claimedAt < STUCK_CLAIM_MS) {
          continue; // freshly claimed by someone else
        }
        reclaiming = true;
        due = claimedAt; // stuck — process now
      } else if (ea.startsWith("defer:")) {
        const d = Date.parse(ea.slice("defer:".length));
        if (!Number.isFinite(d)) continue; // corrupt sentinel — leave it
        if (d > now) continue; // still inside the grace window
        due = d;
      } else {
        continue; // "" (immediate path / cancelled) or ISO (sent) — skip
      }

      r.scanned++;
      const originalEa = ea;

      // ── Claim ────────────────────────────────────────────────────
      // Win exactly one flusher: stamp `sending:`, then re-read that
      // one cell. Last-writer-wins + verify closes the cross-instance
      // double-send race.
      const claim = "sending:" + isoNow();
      try {
        await setCell(sheetRow, claim);
        const back = await readCell(sheetRow);
        if (back !== claim) continue; // another flusher owns it
      } catch (e) {
        r.errors++;
        console.log(
          "[deferredEmails] claim failed (non-fatal):",
          e instanceof Error ? e.message : String(e),
        );
        continue;
      }
      if (reclaiming) r.reclaimed++;

      try {
        const forEmail = String(row[iFor] ?? "").toLowerCase().trim();
        const actor = String(row[iActor] ?? "").toLowerCase().trim();
        const cid = String(row[iComment] ?? "").trim();
        const kind = String(row[iKind] ?? "") as NotificationKind;

        // (a) Comment deleted within the window → cancel the email.
        if (cid) {
          const { getDb, FS_COLLECTIONS } = await import("@/lib/firestore");
          const snap = await getDb()
            .collection(FS_COLLECTIONS.comments)
            .doc(cid)
            .get();
          if (!snap.exists) {
            await setCell(sheetRow, ""); // terminal: never emailed
            r.cancelledDeleted++;
            continue;
          }
        }

        // (b) Recipient pref rechecked here (skipped at create for
        // deferred rows — the user may have toggled during the window).
        if (!forEmail) {
          await setCell(sheetRow, "");
          continue;
        }
        const { getUserPrefs } = await import("@/lib/userPrefs");
        const prefs = await getUserPrefs(forEmail).catch(() => null);
        if (!prefs?.email_notifications || !emailDefaultOn(kind)) {
          await setCell(sheetRow, "");
          r.cancelledPref++;
          continue;
        }

        // (c) Actor is the Gmail `From` (sendNotificationEmail
        // impersonates it); the sync path also requires it.
        if (!actor) {
          await setCell(sheetRow, "");
          continue;
        }

        const mail = buildNotificationEmail({
          kind,
          actorEmail: actor,
          project: iProject >= 0 ? String(row[iProject] ?? "") : "",
          title: iTitle >= 0 ? String(row[iTitle] ?? "") : "",
          body: iBody >= 0 ? String(row[iBody] ?? "") : "",
          link: iLink >= 0 ? String(row[iLink] ?? "") : "",
        });
        try {
          await sendNotificationEmail({
            fromEmail: actor,
            toEmail: forEmail,
            ...mail,
          });
          await setCell(sheetRow, isoNow()); // terminal: sent
          r.sent++;
        } catch (sendErr) {
          // Bound retries: drop a row that's been stuck too long,
          // otherwise revert to the original `defer:` for next tick.
          const age = now - due;
          if (age > GIVE_UP_MS) {
            await setCell(sheetRow, "");
            r.gaveUp++;
          } else {
            await setCell(sheetRow, originalEa);
          }
          console.log(
            "[deferredEmails] send failed (will " +
              (age > GIVE_UP_MS ? "give up" : "retry") +
              "):",
            sendErr instanceof Error ? sendErr.message : String(sendErr),
          );
        }
      } catch (e) {
        // Any unexpected error after the claim: revert so the row
        // isn't stranded on `sending:`.
        r.errors++;
        try {
          await setCell(sheetRow, originalEa);
        } catch {
          /* best-effort revert */
        }
        console.log(
          "[deferredEmails] row processing failed (non-fatal):",
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  } catch (e) {
    r.errors++;
    console.log(
      "[deferredEmails] flush failed (non-fatal):",
      e instanceof Error ? e.message : String(e),
    );
  }
  return r;
}
