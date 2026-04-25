/**
 * Pure helpers for role classification — no server-only imports so they
 * can be reused in client components (the names-to-emails editor uses
 * `defaultViewLabel` to preview each row's resolved default).
 *
 * Keep `classifyRoleText` in lockstep with the actual text values that
 * appear in the `names to emails` Role column. Current observed values
 * (2026-04-25): "media", "client manager", "copywriter", "art" plus
 * the canonical Hebrew values "מנהל", "קריאייטיב", "לקוח".
 */

export type UserRole =
  | "admin"
  | "manager"
  | "creative"
  | "client"
  | "unknown";

/** Canonical role values offered as a datalist on the editor. Storing
 *  any of these lights up its corresponding default view immediately;
 *  free-text fallbacks still classify via `classifyRoleText`. */
export const CANONICAL_ROLE_OPTIONS: ReadonlyArray<{
  value: string;
  /** Short hint shown next to the value in the editor. */
  hint: string;
  classification: UserRole;
}> = [
  { value: "מנהל", hint: "ברירת מחדל: ממתין לאישורי", classification: "manager" },
  { value: "קריאייטיב", hint: "ברירת מחדל: משימות שמשובצות אצלי", classification: "creative" },
  { value: "מדיה", hint: "ברירת מחדל: משימות שמשובצות אצלי", classification: "creative" },
  { value: "לקוח", hint: "ברירת מחדל: בלי סינון אישי", classification: "client" },
];

/**
 * Map a free-text role label (Hebrew or English, current or canonical)
 * to one of our role families. Returns "unknown" if nothing matches —
 * the page falls back to scanning Keys columns.
 */
export function classifyRoleText(roleText: string): UserRole {
  const r = (roleText || "").trim().toLowerCase();
  if (!r) return "unknown";
  // Manager — campaign / account / project / agency-side ops.
  if (
    /\bmanag/.test(r) ||
    /מנהל/.test(r) ||
    /אקאונט/.test(r) ||
    /account/.test(r) ||
    /\bcampaign/.test(r) ||
    /קמפיינ/.test(r)
  ) {
    return "manager";
  }
  // Creative — design / copy / video / motion / illustration / media buyers.
  if (
    /\bdesign|graphic|art\b|illustr|אומנ/.test(r) ||
    /מעצב|מעצבת|איור/.test(r) ||
    /\bcopy\b|copywriter|קופי/.test(r) ||
    /video|וידאו|אנימצ|motion|מוצר/.test(r) ||
    /creative|קריאייטיב/.test(r) ||
    /\bui\b|\bux\b/.test(r) ||
    /\bmedia\b|מדיה/.test(r) // "media" buyers / internal team — assignee-driven
  ) {
    return "creative";
  }
  if (/\bclient\b|לקוח/.test(r)) return "client";
  return "unknown";
}

/** UI label for "what default filter will this user see on /tasks?". */
export function defaultViewLabel(role: UserRole): string {
  switch (role) {
    case "admin":
      return "אדמין · ברירת מחדל: משימות שיצרת";
    case "manager":
      return "מנהל · ברירת מחדל: משימות שמחכות לאישורך";
    case "creative":
      return "קריאייטיב · ברירת מחדל: משימות שמשובצות אצלך";
    case "client":
      return "לקוח · ברירת מחדל: ללא סינון אישי";
    case "unknown":
    default:
      return "לא מזוהה — ברירת מחדל: משימות שיצרת";
  }
}
