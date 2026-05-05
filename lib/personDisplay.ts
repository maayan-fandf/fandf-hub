/**
 * Centralized employee display-name resolution.
 *
 * Single source of truth for "what name should we show for this person".
 * Use everywhere we render a chip / avatar / dropdown option / @-mention
 * for an F&F employee. Was scattered across files as an inline
 * `shortName(email)` helper that just trimmed the email's local part —
 * that fallback still applies, but only as the LAST resort after
 * Hebrew-name + English-full-name lookups.
 *
 * Resolution order:
 *   1. `he_name` (Hebrew display name from the names_to_emails sheet's
 *      `he name` column, added 2026-05-05) — preferred for parity with
 *      how the team actually addresses each other
 *   2. `name` (full English name from `Full Name` column) — fallback
 *      when the Hebrew column is empty for that row
 *   3. email-prefix (`maayan` from `maayan@fandf.co.il`) — last resort
 *      when the person isn't on the names_to_emails sheet at all
 *      (e.g. a one-off external collaborator on a comment thread)
 */

import type { TasksPerson } from "@/lib/appsScript";

/**
 * Resolve a display name for an email address, preferring Hebrew when
 * available. Either pass the people list (anywhere we already loaded
 * `tasksPeopleListDirect` results) or skip it to fall back to the
 * email-prefix shortname directly.
 */
export function personDisplayName(
  email: string | null | undefined,
  people?: TasksPerson[] | null,
): string {
  const e = (email || "").toLowerCase().trim();
  if (!e) return "";
  if (people && people.length > 0) {
    const p = people.find((x) => (x.email || "").toLowerCase() === e);
    if (p) return p.he_name || p.name || emailLocalPart(e);
  }
  return emailLocalPart(e);
}

/** Same as `personDisplayName` but takes a person directly when already
 *  resolved. Useful inside option-render loops where the person object
 *  is already in scope (e.g. PersonCombobox). */
export function displayNameOf(p: TasksPerson | null | undefined): string {
  if (!p) return "";
  return p.he_name || p.name || emailLocalPart(p.email);
}

/** Email local-part — e.g. "maayan" from "maayan@fandf.co.il". Exported
 *  for the rare case where a caller still wants the raw email shortname
 *  (debug surfaces, internal tooling). UI surfaces should prefer the
 *  two functions above. */
export function emailLocalPart(email: string | null | undefined): string {
  const e = (email || "").trim();
  if (!e) return "";
  const at = e.indexOf("@");
  return at > 0 ? e.slice(0, at) : e;
}
