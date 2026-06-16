/**
 * Tool catalog exposed to Gemini in the chat assistant.
 *
 * Two-layer design mirrors the one in the Anthropic agent docs:
 *   1. Each tool ships a `FunctionDeclaration` (the JSON-Schema-style
 *      contract Gemini reads to decide when + how to call it).
 *   2. Each tool ships an `execute(subjectEmail, args)` function the
 *      chat route invokes when Gemini emits a function call.
 *
 * Subject email is the signed-in user — every tool runs as them via
 * the existing SA + DWD impersonation. There's no privilege
 * escalation: the chat can only read what the user could read by
 * navigating the hub or opening their own Gmail / Drive.
 *
 * Catalog (read-only):
 *   • Hub resolvers: getTask, getProject, getCompanyContacts
 *   • Project data: getProjectMetrics, getCrmFunnel, getProjectAlerts,
 *     getProjectPacing, getPriceCheck, getBudgetShift,
 *     diagnosePaidChannels, searchTasks
 *   • Portfolio: getMorningFeedPortfolio, getPortfolioBenchmarks
 *   • Workspace reads: searchGmail, readGmailThread, searchDrive,
 *     readDoc, readPdf
 *   • Sheet access: getSheetMetadata, readSheetTab, searchSheetRows
 *
 * Still deferred:
 *   • Write tools (createTask, updateTask) — safer to ship after we
 *     have a confirmation-flow UX in the drawer.
 *   • Calendar (calendar.events.readonly already in DWD).
 */

import { SchemaType, type FunctionDeclaration } from "@google-cloud/vertexai";
import { google } from "googleapis";
import {
  gmailReadClient,
  driveClient,
  getSAClient,
  sheetsClient,
} from "@/lib/sa";

export type ToolExecutor = (
  subjectEmail: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type Tool = {
  declaration: FunctionDeclaration;
  execute: ToolExecutor;
};

// ── Arg helpers ──────────────────────────────────────────────────────

function requireString(
  args: Record<string, unknown>,
  key: string,
): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`tool argument '${key}' is required (got ${typeof v})`);
  }
  return v.trim();
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) return undefined;
  return v.trim();
}

function optionalInt(
  args: Record<string, unknown>,
  key: string,
  defaultVal: number,
  cap: number,
): number {
  const v = args[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(Math.floor(n), cap);
}

// ── Hub resolvers ────────────────────────────────────────────────────

const getTaskTool: Tool = {
  declaration: {
    name: "getTask",
    description:
      "Fetch a hub task (work item) by its id. Returns the task with " +
      "its title, description, status, assignees, dates, comments, and " +
      "linked Drive folder. Use when the user references a task or when " +
      "the page context indicates the user is on a task page (path " +
      "starts with /tasks/).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        id: {
          type: SchemaType.STRING,
          description:
            "Task id, formatted like 'T-abc123-xyz'. Visible in URLs " +
            "(/tasks/T-abc123-xyz) and in the page-context label.",
        },
      },
      required: ["id"],
    },
  },
  execute: async (email, args) => {
    const id = requireString(args, "id");
    const { tasksGetDirect } = await import("@/lib/tasksDirect");
    return tasksGetDirect(email, id);
  },
};

const getProjectTool: Tool = {
  declaration: {
    name: "getProject",
    description:
      "Look up a hub project by name. Returns the project's company, " +
      "Chat space URL, and full roster (media manager, account manager, " +
      "client emails, internal team, client-facing team). Use when the " +
      "user asks about a specific project or wants to know who's on it.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: "Project name as it appears in the hub.",
        },
      },
      required: ["name"],
    },
  },
  execute: async (email, args) => {
    const name = requireString(args, "name");
    const { getMyProjectsDirect } = await import("@/lib/projectsDirect");
    const data = await getMyProjectsDirect(email);
    const lc = name.toLowerCase().trim();
    const match = data.projects.find(
      (p) => p.name.toLowerCase().trim() === lc,
    );
    if (!match) {
      return {
        ok: false,
        error: `no project named '${name}' is visible to ${email}`,
      };
    }
    return { ok: true, project: match };
  },
};

const getProjectMetricsTool: Tool = {
  declaration: {
    name: "getProjectMetrics",
    description:
      "Get the dashboard performance metrics for a project — totals " +
      "(budget, spend, leads, relevant, scheduled, meetings, sales, " +
      "CPL, CPS, CPM), per-channel breakdown (facebook, google-search, " +
      "google-pmax, etc.), monthly history, and creative aggregation. " +
      "This is the SAME data the project page's dashboard graphs render " +
      "from — one call replaces the manual Keys → slug → searchSheetRows " +
      "workflow. ALWAYS try this first when the user asks about a " +
      "project's spend / leads / channels / pacing / CPL. Falls back to " +
      "searchSheetRows only when the question is about a specific date " +
      "(yesterday's spend) or a specific creative / ad. Project name " +
      "can be Hebrew (אורנבך ראשון) OR slug (Orenbach-rishon-letzion).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        project: {
          type: SchemaType.STRING,
          description:
            "Project name as it appears in the hub (Hebrew) OR the " +
            "ASCII campaign-id slug from the Keys tab. Either works.",
        },
        monthOverride: {
          type: SchemaType.STRING,
          description:
            "Optional 'YYYY-MM' to rewind metrics to a specific month — " +
            "totals and channels reconstruct from that month's חודשי rows. " +
            "Omit for live (current period) data.",
        },
      },
      required: ["project"],
    },
  },
  execute: async (email, args) => {
    const project = requireString(args, "project");
    const monthOverride = optionalString(args, "monthOverride");
    const { getProjectMetrics } = await import("@/lib/appsScript");
    return getProjectMetrics(project, monthOverride, email);
  },
};

const getCrmFunnelTool: Tool = {
  declaration: {
    name: "getCrmFunnel",
    description:
      "Get the project's CRM SALES FUNNEL — the 'משפך CRM' card on the " +
      "project page. This is DIFFERENT from getProjectMetrics: " +
      "getProjectMetrics is media/ad-platform data (spend, channels, " +
      "CPL); getCrmFunnel is the sales-side funnel from the client's " +
      "CRM (BMBY / Sehel): leads → contacted → scheduled meetings " +
      "(תואמה פגישה) → meetings held (פגישות), the lead-source " +
      "breakdown, the objections (התנגדויות) breakdown, top " +
      "salespeople, and stale-lead detection. Use this for ANY question " +
      "about the CRM funnel / משפך / לידים שתואמה להם פגישה / " +
      "פגישות שהתקיימו / התנגדויות / מקורות לידים ב-CRM / שיעור המרה. " +
      "It applies the SAME per-project scoping the page uses (the " +
      "Keys CRM-account + platform join — BMBY exact-match, Sehel " +
      "prefix-with-word-boundary), so the numbers match the card " +
      "exactly. Do NOT try to reproduce CRM scoping with " +
      "searchSheetRows — only this tool knows the join. Returns " +
      "ok:false with a reason when the project has no CRM mapping in " +
      "Keys (e.g. כללי, or a project not yet onboarded) — relay that, " +
      "don't fabricate funnel numbers.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        project: {
          type: SchemaType.STRING,
          description:
            "Project name as it appears in the hub (Hebrew is fine).",
        },
        monthFilter: {
          type: SchemaType.STRING,
          description:
            "Optional 'YYYY-MM' to restrict the funnel to one calendar " +
            "month (against BMBY's תאריך כניסה / Sehel's תאריך רישום). " +
            "Omit for the current Asia/Jerusalem month — matches the " +
            "page's default 'live' view.",
        },
        allTime: {
          type: SchemaType.BOOLEAN,
          description:
            "Set true to disable the month filter and return all " +
            "available rows (~60 days). Use only when the user explicitly " +
            "asks for all-time / since-launch CRM numbers.",
        },
      },
      required: ["project"],
    },
  },
  execute: async (email, args) => {
    const projectQuery = requireString(args, "project");
    const monthFilter = optionalString(args, "monthFilter");
    const allTime = args.allTime === true;

    // Resolve project → company the same way getProject / getProjectMetrics
    // do, so getCrmFunnelForProject gets the (company, project) pair its
    // Keys join needs.
    const { getMyProjectsDirect } = await import("@/lib/projectsDirect");
    const data = await getMyProjectsDirect(email);
    const lc = projectQuery.toLowerCase().trim();
    const match = data.projects.find(
      (p) => p.name.toLowerCase().trim() === lc,
    );
    if (!match) {
      return {
        ok: false,
        error: `no project named '${projectQuery}' is visible to ${email}`,
      };
    }

    const { getCrmFunnelForProject } = await import("@/lib/crmData");
    const funnel = await getCrmFunnelForProject({
      company: match.company,
      project: match.name,
      monthFilter,
      noFilter: allTime,
    });
    if (!funnel) {
      return {
        ok: false,
        error:
          `no CRM funnel for '${match.name}' — the project has no CRM ` +
          `account/platform mapping in Keys, or zero CRM rows in the ` +
          `selected window. This is expected for catch-all (כללי) and ` +
          `not-yet-onboarded projects; report it rather than guessing.`,
      };
    }

    // Compact projection — the model needs the funnel narrative, NOT the
    // full sourceMatrices / dailyTimeSeries blobs (those exist for the
    // client card's chip re-aggregation and would blow the context
    // window). Aggregate the per-source matrices down to ranked totals.
    const sm = funnel.sourceMatrices;
    const sumRow = (rec: Record<string, number>) =>
      Object.values(rec).reduce((a, b) => a + (b || 0), 0);
    const topSources = sm.allSources
      .map((s) => ({
        source: s,
        leads: sm.leadsBySource[s] || 0,
        scheduledMeetings: sm.scheduledMeetingsBySource[s] || 0,
        meetings: sm.meetingsBySource[s] || 0,
      }))
      .sort((a, b) => b.leads - a.leads)
      .slice(0, 8);
    const statusFunnel = sm.statusFunnelOrder
      .map((status) => ({
        status,
        count: sumRow(sm.statusBySource[status] || {}),
      }))
      .filter((x) => x.count > 0);
    const topObjections = Object.entries(sm.objectionBySource)
      .map(([objection, bySource]) => ({
        objection,
        count: sumRow(bySource),
      }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    return {
      ok: true,
      project: match.name,
      company: match.company,
      platform: funnel.platform,
      crmAccount: funnel.crmAccount,
      monthFilter: funnel.monthFilter || funnel.windowLabel || "(all available data)",
      dateRange: funnel.dateRange,
      totals: {
        leads: funnel.leads,
        contacted: funnel.contacted,
        scheduledMeetings: funnel.scheduledMeetings,
        meetings: funnel.meetings,
        meetingRatePct: funnel.meetingRatePct,
      },
      statusFunnel,
      topSources,
      topObjections,
      topSellers: funnel.topSellers,
      staleLeads: funnel.staleLeads,
    };
  },
};

const searchTasksTool: Tool = {
  declaration: {
    name: "searchTasks",
    description:
      "Search hub WORK TASKS (the משימות board) by project / status / " +
      "person. Answers any 'which tasks…' question: 'what's awaiting my " +
      "approval?', 'open tasks on קאזר', 'what is Nadav working on?', " +
      "'מה תקוע בבירור?'. Access is automatically scoped to what the " +
      "signed-in user is allowed to see — no escalation. getTask is for " +
      "ONE task by id; this is for finding tasks by criteria. status is " +
      "one of: draft, awaiting_handling, in_progress, " +
      "awaiting_clarification, awaiting_approval, done, cancelled, " +
      "blocked. Person filters take an EMAIL (use getCompanyContacts / " +
      "getProject first to resolve a name → email). Done + cancelled " +
      "are excluded unless you pass that status explicitly or " +
      "includeClosed:true.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        project: {
          type: SchemaType.STRING,
          description: "Project name as it appears in the hub (Hebrew ok).",
        },
        status: {
          type: SchemaType.STRING,
          description:
            "Exact status key (e.g. 'awaiting_approval'). Omit for all " +
            "open statuses.",
        },
        assignee: {
          type: SchemaType.STRING,
          description: "Assignee EMAIL — tasks this person works on.",
        },
        approver: {
          type: SchemaType.STRING,
          description: "Approver EMAIL — tasks this person must approve.",
        },
        author: {
          type: SchemaType.STRING,
          description: "Author EMAIL — tasks this person opened.",
        },
        relevantToMe: {
          type: SchemaType.STRING,
          description:
            "EMAIL — OR-match across author/approver/PM/assignee. Use for " +
            "'my tasks' / 'tasks relevant to <person>'.",
        },
        priority: {
          type: SchemaType.STRING,
          description: "'1' (top) | '2' | '3'.",
        },
        includeClosed: {
          type: SchemaType.BOOLEAN,
          description:
            "Include done + cancelled tasks (default false: open work only).",
        },
        limit: {
          type: SchemaType.NUMBER,
          description: "Max tasks to return (default 25, cap 50).",
        },
      },
    },
  },
  execute: async (email, args) => {
    const project = optionalString(args, "project");
    const status = optionalString(args, "status");
    const assignee = optionalString(args, "assignee");
    const approver = optionalString(args, "approver");
    const author = optionalString(args, "author");
    const relevantToMe = optionalString(args, "relevantToMe");
    const priority = optionalString(args, "priority");
    const includeClosed = args.includeClosed === true;
    const limit = optionalInt(args, "limit", 25, 50);

    const { tasksListDirect } = await import("@/lib/tasksDirect");
    const res = await tasksListDirect(email, {
      project,
      // Free-text from the model; tasksListDirect does a plain equality
      // filter, so an unknown status simply yields no matches.
      status: (status ?? "") as "" ,
      assignee,
      approver,
      author,
      relevant_to_me: relevantToMe,
      priority,
    });
    const CLOSED = new Set(["done", "cancelled"]);
    let tasks = res.tasks;
    if (!includeClosed && !status) {
      tasks = tasks.filter((t) => !CLOSED.has(t.status));
    }
    const total = tasks.length;
    const projected = tasks.slice(0, limit).map((t) => ({
      id: t.id,
      title: t.title,
      project: t.project,
      company: t.company,
      status: t.status,
      sub_status: t.sub_status || "",
      priority: t.priority,
      assignees: t.assignees,
      approver_email: t.approver_email,
      author_email: t.author_email,
      requested_date: t.requested_date,
      updated_at: t.updated_at,
    }));
    return {
      ok: true,
      total,
      returned: projected.length,
      truncated: total > projected.length,
      tasks: projected,
    };
  },
};

// Shared morning-feed lookup for the alerts + pacing tools. Both read
// the SAME getMorningFeed call the home grid / top-nav use (cached +
// deduped), so a turn that calls both pays one fetch. Resolves the
// project case-insensitively; returns null when the project isn't in
// the viewer's morning scope (no access, or feed empty for clients).
async function findMorningProject(email: string, projectQuery: string) {
  const { getMorningFeed } = await import("@/lib/appsScript");
  const { morningScopeFor } = await import("@/lib/projectEnded");
  const feed = await getMorningFeed({
    scope: morningScopeFor(email),
    overrideEmail: email,
  });
  const lc = projectQuery.toLowerCase().trim();
  return (
    feed.projects.find((p) => p.name.toLowerCase().trim() === lc) || null
  );
}

const getProjectAlertsTool: Tool = {
  declaration: {
    name: "getProjectAlerts",
    description:
      "Get the live ALERTS / things-that-need-attention for a project — " +
      "the same signals the morning feed + dashboard surface (budget " +
      "pacing, CPL spikes, zero-lead channels, creative mismatch, stale " +
      "CRM leads, etc.). Use for 'what's wrong with X?', 'any problems " +
      "on X?', 'מה דורש טיפול ב-X?', 'יש התראות?'. Returns each signal's " +
      "severity (severe/warn/info), title and detail. Returns ok:false " +
      "when the project isn't in the viewer's morning scope — report " +
      "that rather than guessing.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        project: {
          type: SchemaType.STRING,
          description: "Project name as it appears in the hub (Hebrew ok).",
        },
      },
      required: ["project"],
    },
  },
  execute: async (email, args) => {
    const project = requireString(args, "project");
    const mp = await findMorningProject(email, project);
    if (!mp) {
      return {
        ok: false,
        error:
          `no morning-feed entry for '${project}' visible to ${email} — ` +
          `the project may be out of scope, ended, or have no signals.`,
      };
    }
    const signals = (mp.signals || []).map((s) => ({
      severity: s.severity,
      kind: s.kind,
      title: s.title,
      detail: s.detail,
      channel: s.channel || "",
      platform: s.platform || "",
      dismissed: !!s.dismissed,
    }));
    const counts = signals.reduce(
      (acc, s) => {
        acc[s.severity] = (acc[s.severity] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    return {
      ok: true,
      project: mp.name,
      company: mp.company,
      counts: {
        severe: counts.severe || 0,
        warn: counts.warn || 0,
        info: counts.info || 0,
      },
      signals,
    };
  },
};

const getProjectPacingTool: Tool = {
  declaration: {
    name: "getProjectPacing",
    description:
      "Is the project on budget? Returns budget vs. spend, % budget " +
      "used vs. % of the period elapsed, a pacing verdict (בקצב תקין / " +
      "יש לבדוק / מתחת לקצב / מעל הקצב — the same logic as the " +
      "dashboard's pacing pill), and an end-of-period spend projection " +
      "at the current daily rate. Use for 'is X pacing OK?', 'will X go " +
      "over budget?', 'כמה נשאר ל-X?', 'האם X בקצב?'. Distinct from " +
      "getProjectMetrics (full channel breakdown) — this is the focused " +
      "budget-pacing answer.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        project: {
          type: SchemaType.STRING,
          description: "Project name as it appears in the hub (Hebrew ok).",
        },
      },
      required: ["project"],
    },
  },
  execute: async (email, args) => {
    const project = requireString(args, "project");
    const mp = await findMorningProject(email, project);
    if (!mp) {
      return {
        ok: false,
        error:
          `no morning-feed entry for '${project}' visible to ${email} — ` +
          `the project may be out of scope or ended.`,
      };
    }
    // pctBudget / pctTime are 0..1 fractions (same as the home grid's
    // progress bars). ratio>1 = spending faster than time; <1 = behind.
    // Bands mirror the dashboard's computePacing_ verdict.
    const timeFrac = mp.pctTime || 0;
    const budgetFrac = mp.pctBudget || 0;
    const ratio = timeFrac > 0 ? budgetFrac / timeFrac : null;
    let verdict = "אין מספיק נתונים";
    if (ratio != null) {
      if (ratio >= 0.9 && ratio <= 1.1) verdict = "בקצב תקין";
      else if (ratio >= 0.7 && ratio <= 1.3) verdict = "יש לבדוק";
      else if (ratio < 0.7) verdict = "מתחת לקצב";
      else verdict = "מעל הקצב";
    }
    // Project end-of-period spend at the current daily burn.
    const projectedSpend =
      timeFrac > 0 ? Math.round(mp.spend / timeFrac) : null;
    return {
      ok: true,
      project: mp.name,
      company: mp.company,
      period: { startIso: mp.startIso, endIso: mp.endIso },
      budget: mp.budget,
      spend: mp.spend,
      pctBudgetUsed: Math.round(budgetFrac * 100),
      pctTimeElapsed: Math.round(timeFrac * 100),
      daysElapsed: mp.daysElapsed,
      daysRemaining: mp.daysRemaining,
      daysTotal: mp.daysTotal,
      pacingRatio: ratio == null ? null : Math.round(ratio * 100) / 100,
      verdict,
      projectedEndOfPeriodSpend: projectedSpend,
      projectedVsBudgetPct:
        projectedSpend != null && mp.budget > 0
          ? Math.round((projectedSpend / mp.budget) * 100)
          : null,
    };
  },
};

const getPriceCheckTool: Tool = {
  declaration: {
    name: "getPriceCheck",
    description:
      "Advertised-price check for a project across its 4 marketing " +
      "surfaces — landing page, Yad2, Google, Facebook. Returns the " +
      "detected 'החל מ-' headline price per surface (with the surface's " +
      "URL + live/ad status) plus a comparison: mismatched (do surfaces " +
      "disagree), driftPct (max-min spread), severe (drift > 5%, the " +
      "morning-feed threshold) and mismatchRoom (which room disagrees). " +
      "Use for 'מה המחירים על X?', 'יש פער מחירים?', 'המחיר תואם בכל " +
      "הערוצים?'. This is THE source for advertised prices — don't read " +
      "sheets for them. Returns ok:false when no price was detected yet.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        project: {
          type: SchemaType.STRING,
          description: "Project name as it appears in the hub (Hebrew ok).",
        },
      },
      required: ["project"],
    },
  },
  // Advertised prices aren't user-scoped (they're the public ad copy), so
  // this one tool doesn't need the subject email.
  execute: async (_email, args) => {
    const project = requireString(args, "project");
    const { getProjectPriceCheck } = await import("@/lib/appsScript");
    return getProjectPriceCheck(project);
  },
};

const getMorningFeedPortfolioTool: Tool = {
  declaration: {
    name: "getMorningFeedPortfolio",
    description:
      "Portfolio-wide morning briefing — 'what across ALL my projects " +
      "needs attention?'. Aggregates the daily morning feed over every " +
      "project the user can see: counts by severity (severe/warn/info) " +
      "plus the most-severe signals (budget pacing, CPL spikes, zero-lead " +
      "channels, price mismatch, stale CRM leads…) each tagged with its " +
      "project. Use for 'תן לי סיכום בוקר', 'מה דורש טיפול היום?', 'יש " +
      "בעיות בפרויקטים שלי?'. For ONE named project use getProjectAlerts. " +
      "Dismissed (snoozed) signals are excluded.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        scope: {
          type: SchemaType.STRING,
          description:
            "Optional 'all' (whole agency — admins/managers only) or " +
            "'mine' (just my projects). Omit to use the viewer's default.",
        },
      },
    },
  },
  execute: async (email, args) => {
    const scopeArg = optionalString(args, "scope");
    const { getMorningFeed } = await import("@/lib/appsScript");
    const { morningScopeFor } = await import("@/lib/projectEnded");
    const scope =
      scopeArg === "all" || scopeArg === "mine"
        ? scopeArg
        : morningScopeFor(email);
    const feed = await getMorningFeed({ scope, overrideEmail: email });
    const SEV_RANK: Record<string, number> = { severe: 0, warn: 1, info: 2 };
    const all: {
      project: string;
      company: string;
      severity: string;
      kind: string;
      title: string;
      detail: string;
    }[] = [];
    const perProject = (feed.projects || []).map((p) => {
      const live = (p.signals || []).filter((s) => !s.dismissed);
      for (const s of live) {
        all.push({
          project: p.name,
          company: p.company,
          severity: s.severity,
          kind: s.kind,
          title: s.title,
          detail: s.detail,
        });
      }
      const maxSeverity = live.reduce(
        (m, s) => ((SEV_RANK[s.severity] ?? 9) < (SEV_RANK[m] ?? 9) ? s.severity : m),
        "info",
      );
      return {
        project: p.name,
        company: p.company,
        signalCount: live.length,
        maxSeverity: live.length ? maxSeverity : "none",
      };
    });
    all.sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));
    const counts = all.reduce(
      (acc, s) => {
        acc[s.severity] = (acc[s.severity] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    return {
      ok: true,
      scope: feed.scope,
      generatedAt: feed.generatedAt,
      totalSignals: all.length,
      counts: {
        severe: counts.severe || 0,
        warn: counts.warn || 0,
        info: counts.info || 0,
      },
      topSignals: all.slice(0, 12),
      projects: perProject
        .filter((p) => p.signalCount > 0)
        .sort((a, b) => b.signalCount - a.signalCount),
    };
  },
};

const getBudgetShiftTool: Tool = {
  declaration: {
    name: "getBudgetShift",
    description:
      "Per-project BUDGET-SHIFT advice — the same rebalance/drift " +
      "suggestions the budget desk (/morning/budgets) shows. Returns " +
      "where to move budget between channels (₪ deltas + rationale) plus " +
      "per-channel performance (CPL / cost-per-scheduled / cost-per-meeting " +
      "/ spend / daily rate / CPL trend). Use for 'איפה להזיז תקציב ב-X?', " +
      "'אילו ערוצים מתת-ביצוע ב-X?', 'מה ההמלצה לתקציב של X?'. Advisory " +
      "only — it never changes budgets.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        project: {
          type: SchemaType.STRING,
          description: "Project name (Hebrew ok) or campaign-id slug.",
        },
      },
      required: ["project"],
    },
  },
  // Reads the full budget master (like the desk page), so mirror the
  // desk's access gate: budget-shift advice is for admins / managers /
  // the media team only — don't broaden it to all staff via chat.
  execute: async (email, args) => {
    const { canSeeCampaigns } = await import("@/lib/userRole");
    if (!(await canSeeCampaigns(email).catch(() => false))) {
      return {
        ok: false,
        error:
          "budget-shift advice is limited to admins, managers and the media team",
      };
    }
    const query = requireString(args, "project").toLowerCase();
    const { getBudgetMaster } = await import("@/lib/budgetMaster");
    const { getAllClientsAllRows } = await import("@/lib/allClients");
    const { groupAllClientsBySlug, computeBudgetShiftForProject, buildChannelPerf } =
      await import("@/lib/budgetShiftSuggestions");
    const { driveFolderOwner } = await import("@/lib/sa");
    const owner = driveFolderOwner();
    const master = await getBudgetMaster(owner);
    if (!master || !master.projects?.length) {
      return { ok: false, error: "budget master is unavailable" };
    }
    const proj = master.projects.find(
      (p) =>
        p.name.toLowerCase().trim() === query ||
        (p.tab || "").toLowerCase().trim() === query,
    );
    if (!proj) {
      return { ok: false, error: `no budget-desk project matches '${query}'` };
    }
    const bySlug = groupAllClientsBySlug(await getAllClientsAllRows(owner));
    const group = bySlug.get((proj.tab || "").toLowerCase().trim());
    if (!group) {
      return {
        ok: false,
        error: `no ALL CLIENTS rows for '${proj.name}' (slug ${proj.tab})`,
      };
    }
    const todayIso = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem",
    }).format(new Date());
    const shift = computeBudgetShiftForProject({
      project: proj,
      currentRows: group.current,
      monthlyRows: group.monthly,
      todayIso,
    });
    const perf = buildChannelPerf(group.current, group.monthly, todayIso);
    const channelPerf = Object.entries(perf).map(([channel, p]) => ({
      channel,
      ...p,
    }));
    if (!shift) {
      return {
        ok: true,
        project: proj.name,
        slug: proj.tab,
        mode: null,
        totalMove: 0,
        suggestions: [],
        note:
          "no budget-shift suggestion (drift < ₪100, no E3 budget, or too " +
          "little per-channel data to score)",
        channelPerf,
      };
    }
    return {
      ok: true,
      project: proj.name,
      slug: proj.tab,
      mode: shift.mode,
      totalMove: shift.totalMove,
      suggestions: shift.suggestions,
      channelPerf,
    };
  },
};

const getPortfolioBenchmarksTool: Tool = {
  declaration: {
    name: "getPortfolioBenchmarks",
    description:
      "Portfolio benchmarks — how the whole book distributes on CPL / " +
      "cost-per-scheduled / cost-per-meeting, both per-PROJECT and " +
      "per-CHANNEL, as P25 / median / P75 (+ mean, n). Use to answer 'מה " +
      "ה-CPL הטיפוסי בתיקייה?', 'איזה ערוץ יקר ביחס לממוצע?', or to judge " +
      "whether a project's number is good vs peers. For a ready-made " +
      "per-project verdict, prefer diagnosePaidChannels.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  execute: async (email) => {
    const { getPortfolioBenchmarks } = await import("@/lib/portfolioBenchmarks");
    const b = await getPortfolioBenchmarks(email);
    // Strip the heavy raw arrays (per-sample values, period-raw rows) — the
    // model only needs the distribution stats, not the underlying samples.
    const strip = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(strip);
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (k === "samples" || k === "projectPeriodRaw") continue;
          out[k] = strip(val);
        }
        return out;
      }
      return v;
    };
    return { ok: true, benchmarks: strip(b) };
  },
};

const diagnosePaidChannelsTool: Tool = {
  declaration: {
    name: "diagnosePaidChannels",
    description:
      "Diagnose a project's PAID channels against portfolio benchmarks and " +
      "return ranked, plain-language verdict cards (good / watch / warn / " +
      "bad) — budget waste, CPL outliers, winners to scale, quality leaks. " +
      "Use for 'אבחן את X', 'מה הטוב והרע בערוצים של X?', 'איפה שורפים " +
      "תקציב ב-X?'. It fetches the project's media metrics + the portfolio " +
      "benchmarks for you.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        project: {
          type: SchemaType.STRING,
          description: "Project name (Hebrew ok) or slug.",
        },
      },
      required: ["project"],
    },
  },
  execute: async (email, args) => {
    const project = requireString(args, "project");
    const { getProjectMetrics } = await import("@/lib/appsScript");
    const { getPortfolioBenchmarks } = await import("@/lib/portfolioBenchmarks");
    const { diagnosePaidChannels } = await import("@/lib/paidDiagnosis");
    const [metricsRes, benchmarks] = await Promise.all([
      getProjectMetrics(project, undefined, email),
      getPortfolioBenchmarks(email).catch(() => null),
    ]);
    if (!metricsRes.ok) {
      return {
        ok: false,
        error: `couldn't load metrics for '${project}': ${metricsRes.error}`,
      };
    }
    const channels = metricsRes.project.channels || [];
    const cards = diagnosePaidChannels(channels, benchmarks);
    return {
      ok: true,
      project: metricsRes.project.name,
      cardCount: cards.length,
      cards: cards.map((c) => ({
        priority: c.priority,
        tone: c.tone,
        head: c.head,
        body: c.body,
        sample: c.sample,
        tip: c.tip,
      })),
    };
  },
};

const getCompanyContactsTool: Tool = {
  declaration: {
    name: "getCompanyContacts",
    description:
      "List the contacts (people + their emails + roles) associated " +
      "with a company across all projects under that company. Useful " +
      "for resolving a person's name to an email so other tools " +
      "(searchGmail, searchDrive) can be called with the right query. " +
      "Returns the union of every project's roster under that company.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        company: {
          type: SchemaType.STRING,
          description: "Company name as it appears in the hub.",
        },
      },
      required: ["company"],
    },
  },
  execute: async (email, args) => {
    const company = requireString(args, "company");
    const { getMyProjectsDirect } = await import("@/lib/projectsDirect");
    const data = await getMyProjectsDirect(email);
    const lc = company.toLowerCase().trim();
    const matches = data.projects.filter(
      (p) => (p.company || "").toLowerCase().trim() === lc,
    );
    if (matches.length === 0) {
      return { ok: false, error: `no projects found for company '${company}'` };
    }
    // Aggregate the rosters across every matching project.
    const clientEmails = new Set<string>();
    const internalNames = new Set<string>();
    const clientFacingNames = new Set<string>();
    const accountManagers = new Set<string>();
    const mediaManagers = new Set<string>();
    for (const p of matches) {
      for (const e of p.roster.clientEmails || []) clientEmails.add(e);
      for (const n of p.roster.internalOnly || []) internalNames.add(n);
      for (const n of p.roster.clientFacing || []) clientFacingNames.add(n);
      if (p.roster.projectManagerFull)
        accountManagers.add(p.roster.projectManagerFull);
      if (p.roster.mediaManager) mediaManagers.add(p.roster.mediaManager);
    }
    return {
      ok: true,
      company,
      projects: matches.map((p) => p.name),
      clientEmails: Array.from(clientEmails),
      accountManagers: Array.from(accountManagers),
      mediaManagers: Array.from(mediaManagers),
      internalTeam: Array.from(internalNames),
      clientFacingTeam: Array.from(clientFacingNames),
    };
  },
};

// ── Gmail read tools ────────────────────────────────────────────────

const searchGmailTool: Tool = {
  declaration: {
    name: "searchGmail",
    description:
      "Search the user's own Gmail. Pass a Gmail-style query (e.g. " +
      "'from:lora@example.com', 'subject:campaign Q3', " +
      "'has:attachment newer_than:7d'). Returns up to maxResults " +
      "thread summaries (subject, sender, snippet, threadId). Call " +
      "readGmailThread with a threadId to read the full thread.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            "Gmail search query in Gmail's standard syntax — same as " +
            "the search box in gmail.com.",
        },
        maxResults: {
          type: SchemaType.INTEGER,
          description: "Max threads to return (1-25, default 10).",
        },
      },
      required: ["query"],
    },
  },
  execute: async (email, args) => {
    const q = requireString(args, "query");
    const maxResults = optionalInt(args, "maxResults", 10, 25);
    const gmail = gmailReadClient(email);
    const list = await gmail.users.threads.list({
      userId: "me",
      q,
      maxResults,
    });
    const threads = list.data.threads || [];
    if (threads.length === 0) return { ok: true, threads: [] };
    // For each thread, pull the metadata of the LAST message (most
    // recent) to surface a useful summary without N round trips.
    // Vertex's tool-result size is generous but we still want compact
    // results — drop snippets > 250 chars.
    const summaries = await Promise.all(
      threads.map(async (t) => {
        try {
          const detail = await gmail.users.threads.get({
            userId: "me",
            id: t.id!,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          });
          const msgs = detail.data.messages || [];
          const last = msgs[msgs.length - 1];
          const headers = last?.payload?.headers || [];
          const get = (name: string) =>
            headers.find(
              (h) => (h.name || "").toLowerCase() === name.toLowerCase(),
            )?.value || "";
          const snippet = (last?.snippet || "").slice(0, 250);
          return {
            threadId: t.id,
            messageCount: msgs.length,
            subject: get("Subject"),
            from: get("From"),
            date: get("Date"),
            snippet,
          };
        } catch {
          return { threadId: t.id, error: "failed to load thread metadata" };
        }
      }),
    );
    return { ok: true, threads: summaries };
  },
};

const readGmailThreadTool: Tool = {
  declaration: {
    name: "readGmailThread",
    description:
      "Read the full body of every message in a Gmail thread. Returns " +
      "an ordered list of messages with sender, date, and body text. " +
      "Use after searchGmail returns a relevant threadId.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        threadId: {
          type: SchemaType.STRING,
          description: "Gmail thread id from searchGmail's result.",
        },
      },
      required: ["threadId"],
    },
  },
  execute: async (email, args) => {
    const threadId = requireString(args, "threadId");
    const gmail = gmailReadClient(email);
    const detail = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });
    const msgs = (detail.data.messages || []).map((m) => {
      const headers = m.payload?.headers || [];
      const get = (name: string) =>
        headers.find(
          (h) => (h.name || "").toLowerCase() === name.toLowerCase(),
        )?.value || "";
      const body = extractGmailBody(m.payload);
      return {
        id: m.id,
        from: get("From"),
        to: get("To"),
        date: get("Date"),
        subject: get("Subject"),
        body: body.slice(0, 5000), // cap per message
      };
    });
    return { ok: true, threadId, messageCount: msgs.length, messages: msgs };
  },
};

/** Walk a Gmail message payload tree to find the best plain-text body.
 *  Prefers text/plain; falls back to text/html with tags stripped.
 *  Returns "" when neither part exists. */
function extractGmailBody(
  payload: import("googleapis").gmail_v1.Schema$MessagePart | undefined,
): string {
  if (!payload) return "";
  // Direct body text on the part itself.
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, "base64").toString("utf8");
    if ((payload.mimeType || "").includes("text/html")) {
      return stripHtml(decoded);
    }
    return decoded;
  }
  // Recurse into multipart parts. Prefer text/plain.
  const parts = payload.parts || [];
  let plain = "";
  let html = "";
  for (const p of parts) {
    if ((p.mimeType || "") === "text/plain" && !plain) {
      plain = extractGmailBody(p);
    } else if ((p.mimeType || "") === "text/html" && !html) {
      html = extractGmailBody(p);
    } else if ((p.mimeType || "").startsWith("multipart/")) {
      const inner = extractGmailBody(p);
      if (!plain) plain = inner;
    }
  }
  return plain || html;
}

function stripHtml(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Drive read tools ────────────────────────────────────────────────

const searchDriveTool: Tool = {
  declaration: {
    name: "searchDrive",
    description:
      "Search the user's accessible Drive files (My Drive + Shared " +
      "drives the user is a member of). Returns id, name, mimeType, " +
      "modifiedTime, owner, and webViewLink. Call readDoc with a file " +
      "id to read the full text of a Google Doc.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            "Drive search query in Drive's API syntax — e.g. " +
            "\"name contains 'campaign'\", \"'lora@example.com' in owners\", " +
            "\"mimeType='application/vnd.google-apps.document'\". For a " +
            "free-text search, use \"fullText contains 'WORDS'\" — that " +
            "matches against the indexed text inside docs/sheets/PDFs.",
        },
        maxResults: {
          type: SchemaType.INTEGER,
          description: "Max files to return (1-25, default 10).",
        },
      },
      required: ["query"],
    },
  },
  execute: async (email, args) => {
    const q = requireString(args, "query");
    const maxResults = optionalInt(args, "maxResults", 10, 25);
    const drive = driveClient(email);
    const res = await drive.files.list({
      q,
      pageSize: maxResults,
      // Search across both My Drive and shared drives the user belongs
      // to. Without these flags the API only searches My Drive — which
      // would miss virtually every collaborative file in F&F.
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: "allDrives",
      fields:
        "files(id, name, mimeType, modifiedTime, owners(emailAddress, displayName), webViewLink, parents)",
    });
    return { ok: true, files: res.data.files || [] };
  },
};

const readDocTool: Tool = {
  declaration: {
    name: "readDoc",
    description:
      "Read the plain-text content of a Google Doc OR Google Slides " +
      "deck. Pass the file id from searchDrive — works for mimeType " +
      "'application/vnd.google-apps.document' (Docs) and " +
      "'application/vnd.google-apps.presentation' (Slides). For raw " +
      "PDF files (פריסות, PDF exports from Figma, etc.) use readPdf " +
      "instead. Returns up to ~30KB of text — long docs are truncated.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        documentId: {
          type: SchemaType.STRING,
          description:
            "Drive file id of a Google Doc or Google Slides file.",
        },
      },
      required: ["documentId"],
    },
  },
  execute: async (email, args) => {
    const documentId = requireString(args, "documentId");
    // Use Drive's `files.export` to get text/plain — avoids needing
    // the docs.readonly scope (we already have /auth/drive in DWD).
    // Works for both Docs and Slides; Drive picks the right exporter
    // based on the source mimeType. Returns a string body in res.data
    // when alt=media.
    const drive = driveClient(email);
    const res = await drive.files.export(
      { fileId: documentId, mimeType: "text/plain" },
      { responseType: "text" },
    );
    const text = String(res.data || "");
    const cap = 30_000;
    return {
      ok: true,
      documentId,
      truncated: text.length > cap,
      text: text.length > cap ? text.slice(0, cap) + "\n…" : text,
    };
  },
};

// PDF text-layer extraction. Designed for the project pages' פריסה
// preview (Drive PDF exports from Figma / Photoshop / Illustrator that
// retain a selectable text layer). When the PDF is image-only / scanned
// (no text layer), returns ok:true with an empty `text` and a hint —
// callers should treat that as "we'd need OCR" rather than retrying.
//
// Pulls bytes via files.get(alt:'media'); pdf-parse runs entirely in
// the Next.js server process (Buffer-based, no headless browser).
const readPdfTool: Tool = {
  declaration: {
    name: "readPdf",
    description:
      "Read the text-layer content of a raw PDF file on Drive. Use this " +
      "for פריסה files (landing-page mockups exported as PDF), client " +
      "briefs uploaded as PDF, and any other application/pdf entry " +
      "from searchDrive. Returns up to ~30KB of extracted text + a " +
      "page count + a `hasTextLayer` flag. When `hasTextLayer` is " +
      "false the PDF is image-only / scanned and the text field will " +
      "be empty — don't retry, surface that fact and tell the user " +
      "OCR isn't wired yet. For Google Docs / Slides use readDoc " +
      "instead (this tool only handles raw PDFs).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        fileId: {
          type: SchemaType.STRING,
          description:
            "Drive file id of a PDF file (mimeType 'application/pdf').",
        },
      },
      required: ["fileId"],
    },
  },
  execute: async (email, args) => {
    const fileId = requireString(args, "fileId");
    const drive = driveClient(email);
    // Fetch metadata first so we can refuse non-PDFs cleanly + surface
    // a useful error to the model instead of letting pdf-parse choke
    // on whatever bytes Drive returned.
    const meta = await drive.files.get({
      fileId,
      fields: "id, name, mimeType, size, webViewLink",
    });
    const mimeType = String(meta.data.mimeType || "");
    if (mimeType !== "application/pdf") {
      return {
        ok: false,
        error:
          `file ${fileId} has mimeType '${mimeType}', not 'application/pdf'. ` +
          `Use readDoc for Google Docs / Slides.`,
        name: meta.data.name || "",
      };
    }
    // Download bytes. arraybuffer + Buffer keeps pdf-parse happy.
    const dl = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" },
    );
    const buf = Buffer.from(dl.data as ArrayBuffer);
    // Lazy-load pdf-parse so non-PDF chat turns don't pay its module-
    // resolve cost. v2 of the package exposes a PDFParse class (was a
    // default function in v1) — call `getText()` and stitch pages.
    const { PDFParse } = await import("pdf-parse");
    let textResult: { text: string; pages?: { text: string }[] };
    let pages = 0;
    try {
      const parser = new PDFParse({
        data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      });
      const info = await parser.getInfo();
      pages = Number(info.total ?? info.pages?.length ?? 0);
      textResult = (await parser.getText()) as {
        text: string;
        pages?: { text: string }[];
      };
      await parser.destroy();
    } catch (e) {
      return {
        ok: false,
        error: `pdf-parse failed: ${e instanceof Error ? e.message : String(e)}`,
        name: meta.data.name || "",
      };
    }
    const text = String(textResult.text || "").trim();
    const cap = 30_000;
    const truncated = text.length > cap;
    const hasTextLayer = text.length > 0;
    return {
      ok: true,
      fileId,
      name: meta.data.name || "",
      pages,
      hasTextLayer,
      truncated,
      text: hasTextLayer
        ? truncated
          ? text.slice(0, cap) + "\n…"
          : text
        : "",
      ...(hasTextLayer
        ? {}
        : {
            note:
              "PDF has no extractable text layer (image-only / scanned). " +
              "OCR isn't wired into this tool yet — surface that fact to the user.",
          }),
    };
  },
};

// ── Sheet introspection tools ───────────────────────────────────────
//
// Used to dig into the four spreadsheets that hold the hub + dashboard
// data when the user asks something the structured hub resolvers don't
// answer ("how many leads did גוהרי have last week?", "show me the
// archive of two months ago", etc.). Two tools:
//
//   - getSheetMetadata(spreadsheetId) — list tabs + headers without
//     reading rows. Lets the model orient before pulling a big range.
//   - readSheetTab(spreadsheetId, tab, range?) — read up to ~200 rows
//     from a tab (or specified A1 range). Output is capped to ~50KB
//     so even noisy tabs stay tractable in the chat context.

const getSheetMetadataTool: Tool = {
  declaration: {
    name: "getSheetMetadata",
    description:
      "List every tab in a Google Sheet, with the first-row headers and " +
      "row/column counts for each tab. Cheap orientation read — call " +
      "this BEFORE readSheetTab to know which tab + columns to fetch. " +
      "The four hub/dashboard spreadsheet IDs are listed in the system " +
      "prompt under DATA SOURCES; you can also pass any other " +
      "spreadsheet id the user is authorized to read.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        spreadsheetId: {
          type: SchemaType.STRING,
          description:
            "Google Sheets spreadsheet id (the long alphanumeric string " +
            "in the sheet URL after /d/).",
        },
      },
      required: ["spreadsheetId"],
    },
  },
  execute: async (email, args) => {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const sheets = sheetsClient(email);
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields:
        "properties.title,sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))",
    });
    const tabs = meta.data.sheets || [];
    if (tabs.length === 0) {
      return { ok: true, title: meta.data.properties?.title, tabs: [] };
    }
    // Pull headers in one batchGet — single round trip vs. one per tab.
    const headerRanges = tabs
      .map((s) => s.properties?.title || "")
      .filter(Boolean)
      .map((t) => `'${t.replace(/'/g, "''")}'!1:1`);
    let headerRows: (string[] | undefined)[] = [];
    if (headerRanges.length > 0) {
      try {
        const headersRes = await sheets.spreadsheets.values.batchGet({
          spreadsheetId,
          ranges: headerRanges,
          valueRenderOption: "UNFORMATTED_VALUE",
        });
        headerRows = (headersRes.data.valueRanges || []).map((vr) =>
          (vr.values?.[0] as string[] | undefined)?.map((h) => String(h ?? "")),
        );
      } catch {
        // Some tabs might be hidden / inaccessible — fall through with
        // empty headers rather than failing the whole call.
        headerRows = tabs.map(() => undefined);
      }
    }
    return {
      ok: true,
      title: meta.data.properties?.title,
      tabs: tabs.map((s, i) => ({
        title: s.properties?.title,
        index: s.properties?.index,
        rowCount: s.properties?.gridProperties?.rowCount,
        columnCount: s.properties?.gridProperties?.columnCount,
        headers: headerRows[i] || [],
      })),
    };
  },
};

const readSheetTabTool: Tool = {
  declaration: {
    name: "readSheetTab",
    description:
      "Read rows from a tab in a Google Sheet. Returns up to 200 rows " +
      "by default (or the rows in the explicit `range` you pass). " +
      "Output is capped to ~50KB; if a tab is bigger, narrow the " +
      "range or filter ahead via getSheetMetadata. Use after " +
      "getSheetMetadata so you know the tab name + headers.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        spreadsheetId: {
          type: SchemaType.STRING,
          description: "Google Sheets spreadsheet id.",
        },
        tab: {
          type: SchemaType.STRING,
          description:
            "Tab name as listed by getSheetMetadata (e.g. 'Keys', " +
            "'ALL CLIENTS', 'Comments').",
        },
        range: {
          type: SchemaType.STRING,
          description:
            "Optional A1 range scoped to the tab (e.g. 'A1:F50'). When " +
            "omitted, reads the first 200 rows × all columns of the tab.",
        },
      },
      required: ["spreadsheetId", "tab"],
    },
  },
  execute: async (email, args) => {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const tab = requireString(args, "tab");
    const localRange = optionalString(args, "range");
    const sheets = sheetsClient(email);
    // Resolve the actual tab name. Sheets API is strict about tab
    // names — `'גוגל'` and `'גוגל '` (trailing space) are different
    // tabs. The model often gets the visual name right but misses
    // trailing whitespace. Look up the real titles and find a
    // case-insensitive trimmed match before quoting.
    const actualTab = await resolveTabName(sheets, spreadsheetId, tab);
    const quotedTab = `'${actualTab.replace(/'/g, "''")}'`;
    const fullRange = localRange
      ? `${quotedTab}!${localRange}`
      : `${quotedTab}!A1:ZZ200`;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: fullRange,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const values = (res.data.values || []) as unknown[][];
    // Cap output size. Stringify, truncate, return as `rows` array
    // (with truncation flag) so the model doesn't choke on a giant
    // payload. 50KB ≈ 12k tokens of value text — plenty for a typical
    // tab read but small enough not to blow the context.
    const cap = 50_000;
    const serialized = JSON.stringify(values);
    if (serialized.length <= cap) {
      return {
        ok: true,
        spreadsheetId,
        tab,
        range: fullRange,
        rowCount: values.length,
        truncated: false,
        rows: values,
      };
    }
    // Binary-search for how many rows fit under the cap.
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (JSON.stringify(values.slice(0, mid)).length > cap) hi = mid - 1;
      else lo = mid;
    }
    return {
      ok: true,
      spreadsheetId,
      tab,
      range: fullRange,
      rowCount: values.length,
      truncated: true,
      truncationNote: `output capped at ${cap} bytes — returning first ${lo}/${values.length} rows. Re-call with a narrower range if you need later rows.`,
      rows: values.slice(0, lo),
    };
  },
};

/** Look up the canonical tab title in a spreadsheet given a name the
 *  caller provided. Tolerates trailing/leading whitespace + case
 *  differences (Hebrew sheet names sometimes carry a trailing space —
 *  e.g. 'גוגל ' vs 'גוגל' — that's the most common cause of a
 *  "tab not found" error from the Sheets API). Falls back to the
 *  caller's input verbatim when no match is found, so the original
 *  Sheets-API error surfaces naturally. */
async function resolveTabName(
  sheets: ReturnType<typeof sheetsClient>,
  spreadsheetId: string,
  requested: string,
): Promise<string> {
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties.title",
    });
    const titles = (meta.data.sheets || [])
      .map((s) => s.properties?.title || "")
      .filter(Boolean);
    const norm = requested.trim().toLowerCase();
    const exact = titles.find((t) => t === requested);
    if (exact) return exact;
    const fuzzy = titles.find((t) => t.trim().toLowerCase() === norm);
    if (fuzzy) return fuzzy;
  } catch {
    // Best-effort — fall through to the caller's input.
  }
  return requested;
}

// ── searchSheetRows: filter+sum tool that handles full-sheet queries ─
//
// Replaces the common "readSheetTab → filter client-side → discover
// the row I want is past the 200-row cap" failure mode. Reads the
// ENTIRE sheet server-side, applies caller-provided filters by
// column name (resolved fuzzily), and returns matching rows + a
// pre-computed sum for every numeric column. Pre-computed sums make
// "how much did X spend?" answers structurally correct — the model
// can't pick a single row's value because the sums are right there.

const searchSheetRowsTool: Tool = {
  declaration: {
    name: "searchSheetRows",
    description:
      "Filter rows in a Google Sheet tab by column-value matches and " +
      "return ONLY matching rows + pre-computed sums for every numeric " +
      "column. Reads the WHOLE tab (no 200-row cap), so use this for " +
      "any 'find rows for project X' / 'sum cost for slug Y on date Z' " +
      "question. Tab name + filter column names are resolved fuzzily " +
      "(case-insensitive, trim whitespace) so 'גוגל' matches 'גוגל '. " +
      "Filter values support exact match (single string) or 'any of' " +
      "(string array). Returns up to 100 sample rows + the count of " +
      "all matches. ALWAYS use this for metrics queries instead of " +
      "readSheetTab + manual filtering.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        spreadsheetId: {
          type: SchemaType.STRING,
          description: "Google Sheets spreadsheet id.",
        },
        tab: {
          type: SchemaType.STRING,
          description:
            "Tab name (e.g. 'Facebook-adsets', 'ALL CLIENTS', 'גוגל').",
        },
        filters: {
          type: SchemaType.OBJECT,
          description:
            "Object mapping COLUMN HEADER → expected value(s). Example: " +
            "{ \"Campaign match\": \"cazar\", \"Date\": \"2026-05-06\" }. " +
            "Pass an array as the value to mean 'any of'. Column header " +
            "names are case-insensitive trimmed. Pass an empty object " +
            "to read every row (capped at 100 sample rows + sums).",
        },
      },
      required: ["spreadsheetId", "tab", "filters"],
    },
  },
  execute: async (email, args) => {
    const spreadsheetId = requireString(args, "spreadsheetId");
    const tabRequested = requireString(args, "tab");
    const filtersRaw = (args.filters || {}) as Record<string, unknown>;
    const sheets = sheetsClient(email);
    const tab = await resolveTabName(sheets, spreadsheetId, tabRequested);
    const quotedTab = `'${tab.replace(/'/g, "''")}'`;
    // Read the whole tab. No row limit — we'll filter then cap output.
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quotedTab}!A1:ZZ`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const values = (res.data.values || []) as unknown[][];
    if (values.length < 2) {
      return {
        ok: true,
        tab,
        headers: [],
        matchCount: 0,
        rows: [],
        columnSums: {},
        note: "tab is empty or has only a header row",
      };
    }
    const headers = (values[0] as unknown[]).map((h) =>
      String(h ?? "").trim(),
    );
    const headerIdx = (name: string): number => {
      const norm = name.trim().toLowerCase();
      return headers.findIndex((h) => h.trim().toLowerCase() === norm);
    };

    // Resolve filter column names to indices. Filters whose column
    // doesn't exist are reported as warnings (not errors) so the
    // model can correct itself on the next call.
    const activeFilters: { col: number; values: string[]; header: string }[] = [];
    const unknownFilters: string[] = [];
    for (const [col, val] of Object.entries(filtersRaw)) {
      const idx = headerIdx(col);
      if (idx < 0) {
        unknownFilters.push(col);
        continue;
      }
      const vals = (Array.isArray(val) ? val : [val]).map((v) =>
        String(v ?? "").trim().toLowerCase(),
      );
      activeFilters.push({ col: idx, values: vals, header: headers[idx] });
    }

    // Walk every row applying filters. Slugs / dates / etc. compare
    // case-insensitive and trimmed so "Cazar" and " cazar " both match.
    const matchingRows: unknown[][] = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      let ok = true;
      for (const f of activeFilters) {
        const cell = String(row[f.col] ?? "").trim().toLowerCase();
        if (!f.values.includes(cell)) {
          ok = false;
          break;
        }
      }
      if (ok) matchingRows.push(row);
    }

    // Pre-compute SUM for every column where the matching values look
    // numeric. This is the killer feature — model can NEVER pick one
    // row as the project total, because the sums are computed from
    // every match. Falls through gracefully when a column isn't
    // numeric (skip).
    const columnSums: Record<string, number> = {};
    if (matchingRows.length > 0) {
      for (let c = 0; c < headers.length; c++) {
        let sum = 0;
        let numericCount = 0;
        for (const r of matchingRows) {
          const raw = r[c];
          if (raw === undefined || raw === null || raw === "") continue;
          const n = typeof raw === "number" ? raw : Number(String(raw).trim());
          if (Number.isFinite(n)) {
            sum += n;
            numericCount++;
          }
        }
        // Only report sums for columns where AT LEAST 50% of matching
        // rows had numeric values — avoids reporting "Date" or
        // "Campaign match" as if they had numeric sums.
        if (numericCount >= matchingRows.length * 0.5 && numericCount > 0) {
          columnSums[headers[c]] = Number(sum.toFixed(4));
        }
      }
    }

    return {
      ok: true,
      tab,
      headers,
      filtersApplied: activeFilters.map((f) => ({
        column: f.header,
        values: f.values,
      })),
      ...(unknownFilters.length > 0
        ? {
            unknownFilters,
            warning: `These filter columns weren't found in the headers: ${unknownFilters.join(", ")}. Available headers: ${headers.join(", ")}`,
          }
        : {}),
      matchCount: matchingRows.length,
      columnSums,
      rows: matchingRows.slice(0, 100),
      ...(matchingRows.length > 100
        ? {
            rowsTruncated: true,
            rowsNote: `${matchingRows.length} rows matched; showing first 100. Sums above are over ALL ${matchingRows.length} matches.`,
          }
        : {}),
    };
  },
};

// ── Catalog ──────────────────────────────────────────────────────────

export const TOOL_CATALOG: Tool[] = [
  getTaskTool,
  getProjectTool,
  getProjectMetricsTool,
  getCrmFunnelTool,
  searchTasksTool,
  getProjectAlertsTool,
  getProjectPacingTool,
  getPriceCheckTool,
  getMorningFeedPortfolioTool,
  getBudgetShiftTool,
  getPortfolioBenchmarksTool,
  diagnosePaidChannelsTool,
  getCompanyContactsTool,
  searchGmailTool,
  readGmailThreadTool,
  searchDriveTool,
  readDocTool,
  readPdfTool,
  getSheetMetadataTool,
  readSheetTabTool,
  searchSheetRowsTool,
];

export const TOOL_DECLARATIONS = TOOL_CATALOG.map((t) => t.declaration);

export function getTool(name: string): Tool | undefined {
  return TOOL_CATALOG.find((t) => t.declaration.name === name);
}

/** Suppress an "unused" lint complaint on `getSAClient` + `google` —
 *  re-exported here in case future tools need to construct a custom
 *  client. Currently unused but cheap to keep available. */
export const _internalAuthHelpers = { getSAClient, google };
