/**
 * Display helper for `task.kind`.
 *
 * Two value families coexist in the data:
 *
 *   1. Legacy enum keys ("ad_creative", "landing_page", "video", "copy",
 *      "campaign_launch", "revision", "other"). These were the
 *      hardcoded options in the original new-task form and persist on
 *      older rows. Mapped to Hebrew labels here so the queue / filter
 *      don't show snake_case identifiers to humans.
 *
 *   2. Schema-driven Hebrew labels (e.g. "דף נחיתה", "באנר", …) — the
 *      new-task form's schema-driven path stores the sheet's label
 *      verbatim. Pass-through.
 *
 * Anything else (unknown enum, free-text override) falls through
 * unchanged. Empty input returns "—" so the table cell never renders
 * a blank.
 */
const LEGACY_KIND_LABELS: Record<string, string> = {
  ad_creative: "קריאייטיב פרסומי",
  landing_page: "דף נחיתה",
  video: "וידאו",
  copy: "קופי",
  campaign_launch: "השקת קמפיין",
  revision: "סבב תיקונים",
  other: "אחר",
};

export function kindLabel(kind: string | undefined | null): string {
  const k = (kind || "").trim();
  if (!k) return "—";
  return LEGACY_KIND_LABELS[k] || k;
}
