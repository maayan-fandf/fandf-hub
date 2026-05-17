/**
 * Tool-routing eval fixtures for the chat assistant.
 *
 * Each case is a representative user question + the tool(s) we expect
 * the model to reach for FIRST. The harness (app/api/admin/ai-eval)
 * replays these through the real persona + tool catalog and checks the
 * first tool call lands in `expectAnyOf`. This is the regression net
 * for the class of bug that prompted Phase 2 — the assistant answering
 * a CRM-funnel question from the wrong (media) tool, etc.
 *
 * Keep these provider-agnostic and data-light: we assert ROUTING, not
 * answer content (the harness breaks on the first tool call without
 * executing it, so no Sheets/Gmail access and no token cost beyond one
 * model turn per case). Add a case whenever a new tool ships or a real
 * mis-route is reported.
 */

export type AiEvalCase = {
  /** Stable id for trend tracking across runs. */
  id: string;
  /** The user message, phrased the way the team actually asks. */
  question: string;
  /** Pass if the model's first hub tool call is one of these. */
  expectAnyOf: string[];
  /** Optional note explaining the routing intent. */
  why?: string;
};

export const AI_EVAL_CASES: AiEvalCase[] = [
  {
    id: "crm-funnel-he",
    question: "מה מצב משפך ה-CRM של לוריא? כמה לידים תואמה להם פגישה?",
    expectAnyOf: ["getCrmFunnel"],
    why: "CRM funnel — must NOT route to getProjectMetrics (media data).",
  },
  {
    id: "crm-objections",
    question: "מה ההתנגדויות הכי נפוצות בלידים של לוריא ומאיזה מקור?",
    expectAnyOf: ["getCrmFunnel"],
    why: "Objections × source live only in the CRM funnel.",
  },
  {
    id: "media-spend",
    question: "כמה הוצאנו על קאזר החודש ומה ה-CPL לפי ערוץ?",
    expectAnyOf: ["getProjectMetrics"],
    why: "Media/ad spend + channel CPL — the dashboard metrics tool.",
  },
  {
    id: "tasks-awaiting-approval",
    question: "אילו משימות מחכות לאישור שלי?",
    expectAnyOf: ["searchTasks"],
    why: "Which-tasks query — not getTask (that's one task by id).",
  },
  {
    id: "tasks-person",
    question: "על מה נדב עובד עכשיו?",
    expectAnyOf: ["searchTasks", "getCompanyContacts"],
    why: "May resolve name→email first, then searchTasks.",
  },
  {
    id: "project-alerts",
    question: "יש משהו שדורש טיפול בלוריא? התראות?",
    expectAnyOf: ["getProjectAlerts"],
    why: "Needs-attention / alerts → morning-feed signals tool.",
  },
  {
    id: "project-pacing",
    question: "האם לוריא בקצב תקציבי תקין או שנחרוג?",
    expectAnyOf: ["getProjectPacing"],
    why: "Budget pacing + projection — the focused pacing tool.",
  },
  {
    id: "project-roster",
    question: "מי מנהל הקמפיינים של שיכון ובינוי ומי הלקוח?",
    expectAnyOf: ["getProject", "getCompanyContacts"],
    why: "Roster lookup.",
  },
];
