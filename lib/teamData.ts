/**
 * Team roster + per-person workload aggregator for `/team`.
 *
 * Single-purpose entrypoint: `getTeamRoster(viewerEmail)`. Pulls the
 * names-to-emails sheet (people directory), enriches each person via
 * Workspace Directory (job title, department, mobile / work phone),
 * and counts their open / pending-approval / stuck / shipped-this-week
 * tasks from one whole-collection tasksList read.
 *
 * Why one big read instead of N per-person reads: tasksList is the
 * same Sheets call that powers /tasks, so it's heavily cached. Reading
 * it ONCE and aggregating in memory is dramatically cheaper than
 * issuing one filtered tasksList per teammate (which would melt the
 * Sheets read quota the moment more than a few people show up).
 *
 * Client users (role === "client") are filtered out — `/team` is the
 * internal staff directory; clients live in the CRM. External
 * collaborators with no `@fandf.co.il` email are also filtered out
 * because they're a freelancer / contractor concern we don't model
 * yet (lower-priority, see the Phase 2 list).
 */

import { tasksListDirect, tasksPeopleListDirect } from "@/lib/tasksDirect";
import { getDirectoryUser } from "@/lib/userDirectory";
import type { TasksPerson, WorkTask } from "@/lib/appsScript";

export type TeamMember = {
  /** Lower-cased, trimmed. Stable key across the app. */
  email: string;
  /** Full English name from names-to-emails (or Directory fallback). */
  fullName: string;
  /** Optional Hebrew display name from names-to-emails. */
  heName?: string;
  /** Raw role text from names-to-emails — e.g. "media", "client manager". */
  role: string;
  /** Workspace Directory job title (e.g. "Motion Graphics Designer"). */
  jobTitle: string;
  /** Workspace Directory department (e.g. "Video", "Operations"). */
  department: string;
  /** E.164 mobile (e.g. +972501234567). Empty when not on the profile. */
  mobilePhoneE164: string;
  /** Raw mobile string for display (preserves the local 05X-… format). */
  mobilePhone: string;
  /** Work phone (only set if it's NOT the same number as mobile). */
  workPhone: string;

  /** Active tasks ASSIGNED to this person (awaiting_handling + in_progress).
   *  Excludes blocked/done/cancelled — the headline "what's on their plate". */
  openTasks: number;
  /** Tasks waiting for THIS person to approve (status=awaiting_approval AND
   *  they're the approver). 0 means nothing to approve right now. */
  pendingApproval: number;
  /** Tasks in awaiting_clarification where this person is either the
   *  assignee (they bounced it back) or the approver (they raised the
   *  question). Either way they're on the hook to unstick it. */
  awaitingClarification: number;
  /** Tasks they shipped (status=done) in the last 7 days. Approximate —
   *  uses updated_at as the proxy for "moved to done". Good enough for
   *  a velocity hint; the detail page can do a more accurate
   *  status_history-aware count if we ever need it. */
  doneThisWeek: number;

  /** Top 5 projects they have open tasks in, ranked by count. */
  topProjects: string[];
};

const ROLE_CLIENT = /^client$|לקוח/i;

function isStaff(p: TasksPerson): boolean {
  // Filter out clients (CRM concern) and anyone without a fandf.co.il
  // address (freelancers/external — Phase 2 will model them separately).
  const role = (p.role || "").trim();
  if (ROLE_CLIENT.test(role)) return false;
  const email = (p.email || "").toLowerCase().trim();
  return email.endsWith("@fandf.co.il");
}

function inLastNDays(iso: string, n: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < n * 24 * 60 * 60 * 1000;
}

/** Empty workload — used as the initial accumulator AND when a person
 *  has zero matching tasks (saves a null check at every consumer). */
function emptyWorkload(): Pick<
  TeamMember,
  | "openTasks"
  | "pendingApproval"
  | "awaitingClarification"
  | "doneThisWeek"
  | "topProjects"
> {
  return {
    openTasks: 0,
    pendingApproval: 0,
    awaitingClarification: 0,
    doneThisWeek: 0,
    topProjects: [],
  };
}

export async function getTeamRoster(
  viewerEmail: string,
): Promise<TeamMember[]> {
  // 1. People list (names-to-emails) — the source of truth for who's
  //    internal and what their role is.
  const peopleRes = await tasksPeopleListDirect(viewerEmail).catch(() => ({
    ok: true as const,
    people: [] as TasksPerson[],
  }));
  const staff = peopleRes.people.filter(isStaff);
  if (staff.length === 0) return [];

  // Pre-build a Set of staff emails so the workload pass can short-circuit
  // tasks tied to people we don't surface (clients, freelancers, ex-staff).
  const staffEmails = new Set(staff.map((p) => p.email.toLowerCase().trim()));

  // 2. Whole-collection tasks read. tasksListDirect honors the viewer's
  //    access scope, but staff get the @fandf.co.il blanket pass, so we
  //    effectively get every internal task here. include_umbrellas=false
  //    keeps the count clean — umbrellas aren't real work.
  const tasksRes = await tasksListDirect(viewerEmail, {
    include_umbrellas: false,
  }).catch(() => ({ ok: true as const, tasks: [] as WorkTask[], count: 0 }));
  const tasks: WorkTask[] = tasksRes.tasks ?? [];

  // 3. Aggregate workload per person in one pass. Map keyed by lc email.
  const workload = new Map<string, ReturnType<typeof emptyWorkload>>();
  // Per-person project-count tallies — converted to ranked topProjects at the end.
  const projectCounts = new Map<string, Map<string, number>>();

  const bump = (email: string, key: keyof ReturnType<typeof emptyWorkload>) => {
    const lc = email.toLowerCase().trim();
    if (!staffEmails.has(lc)) return;
    let w = workload.get(lc);
    if (!w) {
      w = emptyWorkload();
      workload.set(lc, w);
    }
    if (key !== "topProjects") {
      (w[key] as number) += 1;
    }
  };
  const bumpProject = (email: string, project: string) => {
    if (!project) return;
    const lc = email.toLowerCase().trim();
    if (!staffEmails.has(lc)) return;
    let m = projectCounts.get(lc);
    if (!m) {
      m = new Map();
      projectCounts.set(lc, m);
    }
    m.set(project, (m.get(project) ?? 0) + 1);
  };

  for (const t of tasks) {
    const status = t.status;

    // Open tasks — counted per assignee (a task can be assigned to
    // multiple people; each gets credit on their card).
    if (status === "awaiting_handling" || status === "in_progress") {
      for (const a of t.assignees || []) {
        bump(a, "openTasks");
        bumpProject(a, t.project);
      }
    }

    // Pending-approval — only the approver gets the chip.
    if (status === "awaiting_approval" && t.approver_email) {
      bump(t.approver_email, "pendingApproval");
    }

    // Awaiting-clarification — assignees AND approver are both on the
    // hook to unstick the thread.
    if (status === "awaiting_clarification") {
      for (const a of t.assignees || []) bump(a, "awaitingClarification");
      if (t.approver_email) bump(t.approver_email, "awaitingClarification");
    }

    // Shipped this week — credit goes to the assignees who actually
    // delivered. updated_at is the proxy for "moved to done"; status
    // can only be `done` once per task so the timestamp window is
    // reliable enough for a velocity hint.
    if (status === "done" && inLastNDays(t.updated_at, 7)) {
      for (const a of t.assignees || []) bump(a, "doneThisWeek");
    }
  }

  // 4. Enrich every staff member with Workspace Directory data in
  //    parallel. getDirectoryUser is internally cached (24h positive,
  //    1h negative) so this is cheap on a warm process and bounded
  //    by the Admin SDK rate limit on cold starts.
  const enriched = await Promise.all(
    staff.map(async (p) => {
      const lc = p.email.toLowerCase().trim();
      const dir = await getDirectoryUser(p.email).catch(() => null);
      const w = workload.get(lc) ?? emptyWorkload();
      const projMap = projectCounts.get(lc);
      const topProjects = projMap
        ? Array.from(projMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name]) => name)
        : [];
      return {
        email: lc,
        fullName: dir?.fullName || p.name || "",
        ...(p.he_name ? { heName: p.he_name } : {}),
        role: p.role || "",
        jobTitle: dir?.jobTitle || "",
        department: dir?.department || "",
        mobilePhoneE164: dir?.mobilePhoneE164 || "",
        mobilePhone: dir?.mobilePhone || "",
        workPhone: dir?.workPhone || "",
        ...w,
        topProjects,
      } satisfies TeamMember;
    }),
  );

  // Sort: most-busy first within each card-grid row, so the team
  // members who are actively carrying the most surface at the top.
  // Ties broken by Hebrew/English name so the order is stable on
  // refresh.
  enriched.sort((a, b) => {
    const aBusy =
      a.openTasks + a.pendingApproval + a.awaitingClarification;
    const bBusy =
      b.openTasks + b.pendingApproval + b.awaitingClarification;
    if (aBusy !== bBusy) return bBusy - aBusy;
    return (a.heName || a.fullName || a.email).localeCompare(
      b.heName || b.fullName || b.email,
      "he",
    );
  });

  return enriched;
}
