/**
 * Display-side helper for the personal-notes pseudo-project.
 *
 * Internally the hub uses two strings to identify "personal" rows:
 *   - `__personal__` as the project name (immutable, used as a routing
 *     key + access gate; see `isPseudoProject` in tasksWriteDirect.ts)
 *   - "Personal" as the company name (set by `resolveCompany` at
 *     write time before 2026-05-05; "אישי" after)
 *
 * Both should render as "אישי" in any user-facing surface — Hebrew UI
 * consistency. Use this helper at every display site instead of
 * spreading the mapping inline.
 */

export const PERSONAL_DISPLAY_LABEL = "אישי";

/** Returns "אישי" for the personal-notes pseudo-project's project /
 *  company values, else the input unchanged. Idempotent — already-
 *  Hebrew "אישי" passes through untouched. Empty input returns empty. */
export function displayProjectOrCompany(value: string): string {
  if (!value) return "";
  if (value === "__personal__") return PERSONAL_DISPLAY_LABEL;
  if (value === "Personal") return PERSONAL_DISPLAY_LABEL;
  return value;
}
