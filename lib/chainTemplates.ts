/**
 * Chain templates — pre-baked sequences of steps for common F&F
 * marketing workflows. Picking a template in the create-form chain
 * mode populates the umbrella title + step rows so the user only
 * fills in assignees (and edits titles if they want).
 *
 * Why hardcoded (vs sheet-driven): the dominant use case is a small
 * number of stable workflow shapes that the team agrees on. A
 * sheet-driven editor adds complexity (admin UI, schema, validation)
 * without obvious payoff while there are only ~3-5 templates. When
 * the list grows past ~10, or when teams want per-project variants,
 * promote this to a TaskFormSchema-style sheet (see
 * `lib/taskFormSchema.ts` for the pattern).
 *
 * Phase 8 (post-shipped polish) of dependencies feature, 2026-05-03.
 */

export type ChainStepTemplate = {
  /** Step title pre-fill — user can edit before submit. */
  title: string;
  /** Optional Hebrew hint shown next to the assignee input ("e.g.
   *  copywriter") so the user knows what role to pick without having
   *  to remember the workflow's owner-per-step contract. Not used
   *  to filter the assignee dropdown — this is documentation only. */
  assigneeHint?: string;
};

export type ChainTemplate = {
  /** Stable ID — never displayed; used as the dropdown's `value`. */
  id: string;
  /** Display label shown in the picker dropdown (Hebrew). */
  label: string;
  /** Suggested umbrella title — the user typically tweaks per
   *  campaign ("Q1 visual update", "September visual update", etc.). */
  defaultUmbrellaTitle: string;
  /** Sequential steps. The chain orchestrator wires blocks/blocked_by
   *  in array order — first step starts immediately, the rest start
   *  blocked until cascade unblocks them in turn. */
  steps: ChainStepTemplate[];
};

/**
 * Curated F&F workflow templates. Add new entries here when a team
 * workflow stabilizes; the picker re-renders automatically.
 *
 * Template names must be in Hebrew (UI is RTL); IDs are kebab-case
 * English so they're URL-safe + grep-friendly without Hebrew encoding
 * issues.
 */
export const CHAIN_TEMPLATES: ChainTemplate[] = [
  {
    id: "fb-visual-update",
    label: "📷 עדכון ויזואל פייסבוק (קופי → אומנות → סטודיו → מדיה)",
    defaultUmbrellaTitle: "עדכון ויזואל",
    steps: [
      { title: "כתיבת קופי",       assigneeHint: "קופירייטר" },
      { title: "עיצוב + בחירת תמונה", assigneeHint: "אומן/אמנית" },
      { title: "ביצוע בסטודיו",     assigneeHint: "סטודיו" },
      { title: "העלאה למדיה",       assigneeHint: "מדיה" },
    ],
  },
  {
    id: "landing-page",
    label: "🌐 דף נחיתה (קופי → עיצוב → קוד → QA)",
    defaultUmbrellaTitle: "דף נחיתה חדש",
    steps: [
      { title: "כתיבת תוכן + CTAs",  assigneeHint: "קופירייטר" },
      { title: "עיצוב UI/UX",         assigneeHint: "מעצב/ת" },
      { title: "פיתוח + אינטגרציה",   assigneeHint: "מפתח/ת" },
      { title: "QA + העלאה",          assigneeHint: "QA / מדיה" },
    ],
  },
  {
    id: "campaign-launch",
    label: "🚀 השקת קמפיין (קופי → ויזואל → הקמה → אישור → לייב)",
    defaultUmbrellaTitle: "השקת קמפיין",
    steps: [
      { title: "כתיבת קופי לקמפיין",  assigneeHint: "קופירייטר" },
      { title: "ויזואלים + בנרים",    assigneeHint: "אומן/אמנית + סטודיו" },
      { title: "הקמת קמפיין במערכת",  assigneeHint: "מדיה" },
      { title: "אישור לקוח",          assigneeHint: "מנהל/ת קמפיין" },
      { title: "העלאה ללייב",          assigneeHint: "מדיה" },
    ],
  },
  {
    id: "monthly-report",
    label: "📊 דוח חודשי (איסוף → ניתוח → עיצוב → שליחה)",
    defaultUmbrellaTitle: "דוח חודשי",
    steps: [
      { title: "איסוף נתונים",         assigneeHint: "מדיה" },
      { title: "ניתוח + תובנות",       assigneeHint: "מנהל/ת קמפיין" },
      { title: "עיצוב הדוח",            assigneeHint: "אומן/אמנית" },
      { title: "שליחה ללקוח",          assigneeHint: "מנהל/ת קמפיין" },
    ],
  },
];

/** Lookup helper for the form: id → template, or undefined. */
export function findChainTemplate(id: string): ChainTemplate | undefined {
  return CHAIN_TEMPLATES.find((t) => t.id === id);
}
