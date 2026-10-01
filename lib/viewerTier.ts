import { readKeysCached, rosterEmailsOf } from "@/lib/keys";
import { driveFolderOwner } from "@/lib/sa";

/**
 * Who is this signed-in Google account, as far as the hub is concerned?
 *
 *   staff    — an @fandf.co.il address. The service account can act as them
 *              (domain-wide delegation), so "their" Gmail / Calendar / Tasks
 *              really are theirs.
 *   team     — an outside address listed in Keys "Access — internal only" or
 *              "Client-facing": someone on the team whose address is not on
 *              the company domain. INTERNAL in every sense of what they may
 *              SEE and DO in the hub (owner's rule, 2026-10-01: "Access —
 *              internal only" people see everything; the column's one
 *              meaning is that clients can't tag them). The single thing
 *              that separates them from staff is technical: delegation
 *              can't impersonate a personal Gmail account, so lib/sa swaps
 *              them for DRIVE_FOLDER_OWNER — a "personal" mailbox, calendar
 *              or Google Tasks list opened as them is the OWNER's. Those
 *              stay staff-only; nothing else does.
 *   client   — an outside address in Keys "Email Client".
 *   stranger — signed in with Google, on no roster. Gets nothing.
 *
 * WHY THIS EXISTS. Sign-in admits any Google account and the middleware only
 * checks that someone is logged in, so for a year "logged in" was the whole
 * gate on most API routes — and those routes then run as the owner identity.
 * An authorization audit (2026-10-01) confirmed 54 holes with that one root.
 * The door is now `auth()` in "@/auth", which asks this file.
 *
 * Matching is by EXACT address (rosterEmailsOf), never substring: the old
 * `cell.includes(email)` let the account "cohen1984@gmail.com" inherit
 * everything listed for "yossi.cohen1984@gmail.com".
 *
 * Hub admins (HUB_ADMIN_EMAILS) are all @fandf.co.il, so they are staff here
 * without this file importing the task layer.
 */
export type ViewerTier = "staff" | "team" | "client" | "stranger";

/**
 * IDENTITY test — "can the service account act as this address?". Use it
 * only where the code goes to Google AS the person (their Gmail, Calendar,
 * Google Tasks, a Chat message under their name). For "may this viewer see
 * internal things" use isInternalViewer below — the two differ for exactly
 * the team members whose address is off the company domain.
 */
export function isStaffEmail(email: string): boolean {
  return String(email || "").toLowerCase().trim().endsWith("@fandf.co.il");
}

/**
 * VISIBILITY test — is this viewer internal (staff or team)? This is what
 * every "internal only" decision in the hub should ask: the F&F-only
 * discussion channel, the tasks surface, alerts, internal report chrome.
 * Deciding those by the e-mail domain shut out the team members Keys lists
 * as internal under a non-company address.
 *
 * Fails closed with viewerTier: an account whose roster can't be read is
 * not internal.
 */
export async function isInternalViewer(email: string): Promise<boolean> {
  const tier = await viewerTier(email);
  return tier === "staff" || tier === "team";
}

// A roster answer is reused for a while per instance: `auth()` runs on every
// request, often several times. Known viewers are remembered longer than
// strangers, so someone just added to Keys gets in within a minute, and a
// real client is not thrown out by one failed read.
const KNOWN_TTL_MS = 10 * 60 * 1000;
const STRANGER_TTL_MS = 60 * 1000;
const tierCache = new Map<string, { tier: ViewerTier; expiresAt: number }>();

async function tierFromKeys(lc: string): Promise<ViewerTier> {
  const { headers, rows } = await readKeysCached(driveFolderOwner());
  const iClients = headers.indexOf("Email Client");
  const iInternal = headers.indexOf("Access — internal only");
  const iCf = headers.indexOf("Client-facing");
  // A Keys read with no roster columns is a broken read, not an empty roster.
  if (iClients < 0 && iInternal < 0 && iCf < 0) {
    throw new Error("Keys roster columns not found");
  }
  let client = false;
  for (const row of rows) {
    for (const ci of [iInternal, iCf]) {
      if (ci >= 0 && rosterEmailsOf(row[ci]).includes(lc)) return "team";
    }
    if (!client && iClients >= 0 && rosterEmailsOf(row[iClients]).includes(lc)) {
      client = true;
    }
  }
  return client ? "client" : "stranger";
}

/**
 * FAILS CLOSED, with one cushion: if Keys can't be read, an account this
 * instance has already recognised keeps its last tier (lib/keys also serves
 * a last-good snapshot, so this needs a cold instance AND a Sheets failure
 * to matter). An account never seen before is a stranger until the roster
 * can be read.
 */
export async function viewerTier(email: string): Promise<ViewerTier> {
  const lc = String(email || "").toLowerCase().trim();
  if (!lc) return "stranger";
  if (isStaffEmail(lc)) return "staff";
  const hit = tierCache.get(lc);
  const now = Date.now();
  if (hit && hit.expiresAt > now) return hit.tier;
  try {
    const tier = await tierFromKeys(lc);
    tierCache.set(lc, {
      tier,
      expiresAt: now + (tier === "stranger" ? STRANGER_TTL_MS : KNOWN_TTL_MS),
    });
    return tier;
  } catch (e) {
    console.warn(
      `[viewerTier] roster unreadable — ${hit ? `keeping last tier (${hit.tier})` : "treating as stranger"}: ${String((e as Error)?.message ?? e).slice(0, 140)}`,
    );
    return hit?.tier ?? "stranger";
  }
}
