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
  /** Names-to-emails Role value the step's assignee MUST belong to.
   *  When set, the per-step assignee picker filters the dropdown
   *  to people whose role matches (case-insensitive). Empty / absent
   *  means "any role" — useful for steps that span teams or for
   *  workflows where role isn't a hard constraint.
   *
   *  Real role values from the names-to-emails sheet (2026-05-03):
   *    media | client manager | copywriter | art | manager | designer
   *
   *  When you add a new template here, use one of these values
   *  exactly (lowercase). The Role column on the sheet is the
   *  authoritative source — promote new roles there first, then
   *  reference them from templates.
   */
  department?: string;
  /** Optional Hebrew hint shown in the assignee input placeholder
   *  ("e.g. copywriter") for users who'd rather see a friendly
   *  description than the raw role name. Doc-only; doesn't affect
   *  filtering. */
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
      { title: "כתיבת קופי",         department: "copywriter", assigneeHint: "קופירייטר" },
      { title: "עיצוב + בחירת תמונה", department: "art",        assigneeHint: "אומן/אמנית" },
      { title: "ביצוע בסטודיו",       department: "art",        assigneeHint: "סטודיו" },
      { title: "העלאה למדיה",         department: "media",      assigneeHint: "מדיה" },
    ],
  },
  {
    id: "landing-page",
    label: "🌐 דף נחיתה (קופי → עיצוב → העלאה)",
    defaultUmbrellaTitle: "דף נחיתה חדש",
    steps: [
      { title: "כתיבת תוכן + CTAs", department: "copywriter", assigneeHint: "קופירייטר" },
      { title: "עיצוב UI/UX",        department: "designer",   assigneeHint: "מעצב/ת" },
      { title: "העלאה + בדיקה",       department: "media",      assigneeHint: "מדיה" },
    ],
  },
  {
    id: "campaign-launch",
    label: "🚀 השקת קמפיין (קופי → ויזואל → הקמה → אישור → לייב)",
    defaultUmbrellaTitle: "השקת קמפיין",
    steps: [
      { title: "כתיבת קופי לקמפיין", department: "copywriter",     assigneeHint: "קופירייטר" },
      { title: "ויזואלים + בנרים",   department: "art",            assigneeHint: "אומן/אמנית" },
      { title: "הקמת קמפיין במערכת", department: "media",          assigneeHint: "מדיה" },
      { title: "אישור לקוח",         department: "client manager", assigneeHint: "מנהל/ת קמפיין" },
      { title: "העלאה ללייב",         department: "media",          assigneeHint: "מדיה" },
    ],
  },
  {
    id: "monthly-report",
    label: "📊 דוח חודשי (איסוף → ניתוח → עיצוב → שליחה)",
    defaultUmbrellaTitle: "דוח חודשי",
    steps: [
      { title: "איסוף נתונים",  department: "media",          assigneeHint: "מדיה" },
      { title: "ניתוח + תובנות", department: "client manager", assigneeHint: "מנהל/ת קמפיין" },
      { title: "עיצוב הדוח",     department: "art",            assigneeHint: "אומן/אמנית" },
      { title: "שליחה ללקוח",    department: "client manager", assigneeHint: "מנהל/ת קמפיין" },
    ],
  },
];

/** Lookup helper for the form: id → template, or undefined. */
export function findChainTemplate(id: string): ChainTemplate | undefined {
  return CHAIN_TEMPLATES.find((t) => t.id === id);
}
