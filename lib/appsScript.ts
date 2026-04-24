/**
 * Server-side helper for calling the Apps Script hub API.
 *
 * Runs only in Server Components / route handlers — never expose the
 * shared token or the raw exec URL to the browser.
 *
 * The API expects a verified user email. We pull it from the NextAuth
 * session; in early-setup environments (before OAuth creds are ready)
 * we fall back to DEV_USER_EMAIL so the app still runs.
 */

import { auth } from "@/auth";
import { unstable_cache } from "next/cache";

type ApiOk<T> = T;
type ApiError = { error: string; status: number };

function assertEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export async function currentUserEmail(): Promise<string> {
  try {
    const session = await auth();
    if (session?.user?.email) return session.user.email;
  } catch {
    // auth() can throw before NextAuth is fully configured; fall through to fallback.
  }
  const fallback = process.env.DEV_USER_EMAIL;
  if (fallback) return fallback;
  throw new Error("Not authenticated — sign in or set DEV_USER_EMAIL in .env.local");
}

/**
 * Call the Apps Script API with an explicit user email. Use this from inside
 * an `unstable_cache` wrapper where the cached function body MUST be free of
 * dynamic request-scoped reads (cookies, headers) — Next.js errors out if
 * you try to read a session inside cache. Callers pass email as a cache key
 * arg and forward it to this helper.
 */
async function callApiAs<T>(
  user: string,
  action: string,
  params: Record<string, string> = {},
): Promise<T> {
  const base = assertEnv("APPS_SCRIPT_API_URL");
  const token = assertEnv("APPS_SCRIPT_API_TOKEN");

  const url = new URL(base);
  url.searchParams.set("api", "1");
  url.searchParams.set("action", action);
  url.searchParams.set("token", token);
  url.searchParams.set("user", user);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }

  // Apps Script exec URLs 302-redirect to googleusercontent.com — fetch follows by default.
  const res = await fetch(url.toString(), {
    method: "GET",
    // Per-request `cache: "no-store"` by default — the caller (`callApi` or
    // a `unstable_cache` wrapper) is responsible for any caching layer.
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Apps Script API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as ApiOk<T> | ApiError;
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    "status" in data
  ) {
    const err = data as ApiError;
    throw new Error(`Apps Script API error ${err.status}: ${err.error}`);
  }
  return data as T;
}

async function callApi<T>(
  action: string,
  params: Record<string, string> = {},
): Promise<T> {
  const user = await currentUserEmail();
  return callApiAs<T>(user, action, params);
}

async function postApi<T>(
  action: string,
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const base = assertEnv("APPS_SCRIPT_API_URL");
  const token = assertEnv("APPS_SCRIPT_API_TOKEN");
  const user = await currentUserEmail();

  const body: Record<string, string> = { action, token, user, api: "1" };
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") body[k] = String(v);
  }

  // Apps Script quirk: POST across its 302 redirect chain is finicky. We instead
  // send query-string + empty body; Apps Script merges query params into e.parameter.
  const url = new URL(base);
  for (const [k, v] of Object.entries(body)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Apps Script API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as ApiOk<T> | ApiError;
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    "status" in data
  ) {
    const err = data as ApiError;
    throw new Error(`Apps Script API error ${err.status}: ${err.error}`);
  }
  return data as T;
}

/* ─── Typed call sites ───────────────────────────────────────────── */

/** Keys-sheet roster subset used for the "my projects" default filter —
 *  mirror of the fields the dashboard uses so both clients agree on what
 *  "a project this person is on" means. Empty fields when the Keys cell
 *  is empty or the column is missing. */
export type ProjectRoster = {
  mediaManager: string;         // col C — campaign manager full name
  projectManagerFull: string;   // col D — account manager full name
  internalOnly: string[];       // col J — creative team (internal only)
  clientFacing: string[];       // col K — creative team (client-facing)
};

export type Project = {
  name: string;
  company: string; // "" when the Keys tab has no company for this project
  chatSpaceUrl: string; // "" when no Chat webhook is configured for the project
  roster: ProjectRoster;
};

export type MyProjects = {
  projects: Project[];
  isAdmin: boolean;
  isInternal: boolean;
  isStaff: boolean;
  isClient: boolean;
  /** User's display name (full) if resolved via names-to-emails. Used to
   *  default-filter the home page to their own projects on first render. */
  person: string;
  email: string;
};

/**
 * Raw shape the Apps Script hub API might return. The old API (pre-company)
 * returns `projects: string[]`; newer versions return object entries with
 * snake_case fields. We normalize at the boundary so callers only ever see
 * the camelCase `Project` shape.
 */
type MyProjectsRaw = {
  projects: (
    | string
    | {
        name: string;
        company?: string;
        chat_space_url?: string;
        roster?: Partial<ProjectRoster>;
      }
  )[];
  isAdmin: boolean;
  isInternal?: boolean;
  isStaff?: boolean;
  isClient?: boolean;
  person?: string;
  email: string;
};

export type TaskItem = {
  comment_id: string;
  project: string;
  anchor: string;
  assignee_email: string;
  assignee_name: string;
  due: string; // "" or YYYY-MM-DD
  title: string;
  body: string;
  author_name: string;
  author_email: string;
  parent_id: string;
  created_at: string;
  resolved: boolean;
  /** ISO timestamp of the last body edit on the source comment. Empty
   *  / undefined when never edited. */
  edited_at?: string;
  /** Number of replies on the comment this task was created from — lets the
   *  task card surface a "💬 N" chip so the user sees there's a discussion. */
  reply_count?: number;
  deep_link: string;
};

export type ProjectTasks = {
  project: string;
  tasks: TaskItem[];
  me: { email: string; isAdmin: boolean };
  today: string; // YYYY-MM-DD
};

const EMPTY_ROSTER: ProjectRoster = {
  mediaManager: "",
  projectManagerFull: "",
  internalOnly: [],
  clientFacing: [],
};

// Cache the myProjects fetch per-user for 60s. This call feeds BOTH the
// home page AND the top-nav projects dropdown (via app/layout.tsx), so it
// runs on every page render — an obvious place to short-circuit with a
// cache. The key is the user's email so different users get separate
// entries; the body of the wrapped fn must be free of dynamic reads
// (cookies / headers) so we forward email explicitly via callApiAs.
//
// Invalidate with: revalidateTag("my-projects") — currently nothing in the
// hub mutates project membership, so the 60s TTL handles the rare "user
// was just added to a project" case on its own.
const fetchMyProjectsCached = unstable_cache(
  async (email: string): Promise<MyProjects> => {
    const raw = await callApiAs<MyProjectsRaw>(email, "myProjects");
    const projects: Project[] = (raw.projects ?? []).map((p) =>
      typeof p === "string"
        ? { name: p, company: "", chatSpaceUrl: "", roster: EMPTY_ROSTER }
        : {
            name: p.name,
            company: p.company ?? "",
            chatSpaceUrl: p.chat_space_url ?? "",
            roster: {
              mediaManager: p.roster?.mediaManager ?? "",
              projectManagerFull: p.roster?.projectManagerFull ?? "",
              internalOnly: p.roster?.internalOnly ?? [],
              clientFacing: p.roster?.clientFacing ?? [],
            },
          },
    );
    return {
      projects,
      isAdmin: raw.isAdmin,
      isInternal: !!raw.isInternal,
      isStaff: !!raw.isStaff,
      isClient: !!raw.isClient,
      person: raw.person ?? "",
      email: raw.email,
    };
  },
  ["myProjects"],
  { revalidate: 60, tags: ["my-projects"] },
);

// Parallel cache for the direct-SA path. Keyed separately so flipping
// USE_SA_PROJECTS_READS doesn't serve stale Apps-Script data. Same
// 60s TTL; the Keys tab is effectively append-only so this rarely bites.
const fetchMyProjectsDirectCached = unstable_cache(
  async (email: string): Promise<MyProjects> => {
    const { getMyProjectsDirect } = await import("@/lib/projectsDirect");
    return getMyProjectsDirect(email);
  },
  ["myProjectsDirect"],
  { revalidate: 60, tags: ["my-projects"] },
);

export async function getMyProjects(): Promise<MyProjects> {
  const email = await currentUserEmail();
  const { useSAProjectsReads } = await import("@/lib/sa");
  if (useSAProjectsReads()) return fetchMyProjectsDirectCached(email);
  return fetchMyProjectsCached(email);
}

export async function getProjectTasks(project: string): Promise<ProjectTasks> {
  // Feature-flagged direct path. When USE_SA_COMMENTS_READS=1, read the
  // Comments sheet directly and reconstruct the mention-task feed in
  // Node — one Sheets call replaces an Apps Script round-trip.
  const { useSACommentsReads } = await import("@/lib/sa");
  if (useSACommentsReads()) {
    const { projectMentionTasksDirect } = await import("@/lib/commentsDirect");
    const user = await currentUserEmail();
    return projectMentionTasksDirect(user, project);
  }
  return callApi<ProjectTasks>("projectTasks", { project });
}

export type MentionItem = {
  comment_id: string;
  project: string;
  anchor: string;
  parent_id: string;
  /**
   * ID of the thread root — same as comment_id when this mention lives on a
   * top-level comment, or the parent when the mention is on a reply. Use this
   * as the target when resolving (only top-level threads are resolvable).
   * Falls back to comment_id for older API responses that don't send it.
   */
  thread_root_id?: string;
  author_email: string;
  author_name: string;
  body: string;
  timestamp: string; // ISO
  /**
   * Resolved state of the thread root (not just this row). The API side now
   * propagates this so a reply-mention disappears from the inbox when its
   * parent thread is resolved.
   */
  resolved: boolean;
  /** ISO timestamp of the last body edit. Empty string / undefined when never edited. */
  edited_at?: string;
  /** Number of replies on the thread root — drives the inline "💬 N" expand
   *  indicator in the inbox. */
  reply_count?: number;
  deep_link: string;
};

export type MyMentions = {
  mentions: MentionItem[];
  me: { email: string; isAdmin: boolean };
  total: number;
};

export async function getMyMentions(): Promise<MyMentions> {
  const { useSACommentsReads } = await import("@/lib/sa");
  if (useSACommentsReads()) {
    const { myMentionsDirect } = await import("@/lib/commentsDirect");
    const user = await currentUserEmail();
    return myMentionsDirect(user);
  }
  return callApi<MyMentions>("myMentions");
}

export type MyCountsPerProject = {
  openTasks: number;
  openMentions: number;
};

export type MyCounts = {
  me: { email: string; isAdmin: boolean };
  total: { openTasks: number; openMentions: number };
  /** Map of project-name → counts. Only projects with >0 of either are included. */
  byProject: Record<string, MyCountsPerProject>;
};

export function getMyCounts(): Promise<MyCounts> {
  return callApi<MyCounts>("myCounts");
}

export type CommentItem = {
  comment_id: string;
  project: string;
  anchor: string;
  parent_id: string;
  author_email: string;
  author_name: string;
  body: string;
  mentions: string[];
  timestamp: string;
  resolved: boolean;
  reply_count: number;
  /** ISO timestamp of the last body edit. Empty / undefined when never edited. */
  edited_at?: string;
  deep_link: string;
};

export type ProjectComments = {
  project: string;
  comments: CommentItem[];
  total: number;
  me: { email: string; isAdmin: boolean };
};

/** Replies under a single parent comment, oldest-first. Returned by
 *  `commentReplies` for the inline thread-expansion UI. */
export type CommentReplies = {
  project: string;
  parent_id: string;
  replies: CommentItem[];
  total: number;
  me: { email: string; isAdmin: boolean };
};

export function getCommentReplies(
  parentCommentId: string,
  project: string,
): Promise<CommentReplies> {
  return callApi<CommentReplies>("commentReplies", {
    parentCommentId,
    project,
  });
}

export async function getProjectComments(
  project: string,
  limit = 20,
): Promise<ProjectComments> {
  const { useSACommentsReads } = await import("@/lib/sa");
  if (useSACommentsReads()) {
    const { projectCommentsDirect } = await import("@/lib/commentsDirect");
    const user = await currentUserEmail();
    return projectCommentsDirect(user, project, limit);
  }
  return callApi<ProjectComments>("projectComments", {
    project,
    limit: String(limit),
  });
}

export type ReassignResult = {
  ok: boolean;
  noop?: boolean;
  comment_id?: string;
  old_assignee?: string;
  new_assignee?: string;
  new_task_id?: string;
};

export function reassignTask(args: {
  commentId: string;
  fromEmail: string;
  toEmail: string;
}): Promise<ReassignResult> {
  return postApi<ReassignResult>("reassignTask", args);
}

export type SetDueResult = {
  ok: boolean;
  comment_id: string;
  assignee: string;
  due: string;
};

export function setTaskDue(args: {
  commentId: string;
  assigneeEmail: string;
  due: string; // YYYY-MM-DD, or "" to clear
}): Promise<SetDueResult> {
  return postApi<SetDueResult>("setTaskDue", args);
}

export type ResolveCommentResult = {
  ok: boolean;
  comment_id: string;
  resolved: boolean;
};

export function resolveComment(args: {
  commentId: string;
  resolved: boolean;
}): Promise<ResolveCommentResult> {
  // Apps Script coerces everything to string; pass "true"/"false" explicitly.
  return postApi<ResolveCommentResult>("resolveComment", {
    commentId: args.commentId,
    resolved: args.resolved ? "true" : "false",
  });
}

export type PostReplyResult = {
  ok: boolean;
  comment_id: string;
  parent_id: string;
  project: string;
  body: string;
  timestamp: string;
};

export function postReply(args: {
  parentCommentId: string;
  body: string;
}): Promise<PostReplyResult> {
  return postApi<PostReplyResult>("postReply", {
    parentCommentId: args.parentCommentId,
    body: args.body,
  });
}

export type Assignee = {
  email: string;
  name: string;
  /** 'admin' | 'manager' | 'account' | 'client' — freeform string from Keys */
  role: string;
};

export type ProjectAssignees = {
  project: string;
  assignees: Assignee[];
  me: { email: string; isAdmin: boolean };
};

export function getProjectAssignees(project: string): Promise<ProjectAssignees> {
  return callApi<ProjectAssignees>("projectAssignees", { project });
}

export type CreateTaskResult = {
  ok: boolean;
  comment_id: string;
  project: string;
  body: string;
  /** Emails that were valid + accepted. Unrecognized emails are silently dropped. */
  assignees: string[];
  /** Sanitized YYYY-MM-DD, or "" if no due date. */
  due: string;
  timestamp: string;
};

export function createTask(args: {
  project: string;
  body: string;
  /** Emails to @-mention (triggers Google Tasks creation for internal emails). */
  assignees: string[];
  /** YYYY-MM-DD, or "" / omit for no due date. */
  due?: string;
}): Promise<CreateTaskResult> {
  return postApi<CreateTaskResult>("createTask", {
    project: args.project,
    body: args.body,
    assignees: args.assignees.join(","),
    due: args.due ?? "",
  });
}

export type DeleteCommentResult = {
  ok: boolean;
  comment_id: string;
  deleted_replies: number;
  deleted_tasks: number;
};

export function deleteComment(commentId: string): Promise<DeleteCommentResult> {
  return postApi<DeleteCommentResult>("deleteComment", { commentId });
}

export type EditCommentResult = {
  ok: boolean;
  noop?: boolean;
  comment_id: string;
  body: string;
  edited_at: string;
  synced_tasks?: number;
};

export function editComment(args: {
  commentId: string;
  body: string;
}): Promise<EditCommentResult> {
  return postApi<EditCommentResult>("editComment", {
    commentId: args.commentId,
    body: args.body,
  });
}

export type SearchResult = {
  comment_id: string;
  project: string;
  body: string;
  timestamp: string;
  parent_id: string;
  author_email: string;
  author_name: string;
  resolved: boolean;
  has_tasks: boolean;
  deep_link: string;
};

export type SearchResponse = {
  query: string;
  results: SearchResult[];
  total: number;
  truncated?: boolean;
};

export function searchContent(q: string, limit = 30): Promise<SearchResponse> {
  return callApi<SearchResponse>("search", { q, limit: String(limit) });
}

/* ─── Admin: names to emails ──────────────────────────────────────── */

export type NameEmailRow = { full_name: string; email: string; role?: string };
export type NamesToEmailsList = { rows: NameEmailRow[] };

export function adminListNamesToEmails(): Promise<NamesToEmailsList> {
  return callApi<NamesToEmailsList>("adminListNamesToEmails");
}

export type UpsertNameToEmailResult = {
  ok: boolean;
  created?: boolean;
  updated?: boolean;
  full_name: string;
  email: string;
  role?: string;
};

export function adminUpsertNameToEmail(args: {
  fullName: string;
  email: string;
  role?: string;
}): Promise<UpsertNameToEmailResult> {
  return postApi<UpsertNameToEmailResult>("adminUpsertNameToEmail", {
    fullName: args.fullName,
    email: args.email,
    role: args.role ?? "",
  });
}

export type DeleteNameToEmailResult = {
  ok: boolean;
  deleted: boolean;
  full_name?: string;
  removed_rows?: number;
};

export function adminDeleteNameToEmail(
  fullName: string,
): Promise<DeleteNameToEmailResult> {
  return postApi<DeleteNameToEmailResult>("adminDeleteNameToEmail", { fullName });
}

/* ─── Morning dashboard ─────────────────────────────────────────── */

export type MorningSignalKind =
  | "pacing-variance"
  | "rising-cpl"
  | "high-cpl"
  | "high-cps"
  | "pixel-tracking-low"
  | "pixel-overcount"
  | "project-budget"
  | "deadline"
  | "paused-budget";

export type MorningSeverity = "severe" | "warn" | "info";

export type MorningSignal = {
  kind: MorningSignalKind;
  severity: MorningSeverity;
  title: string;
  detail: string;
  channel?: string;
  copy?: string | null;
  url?: string;
  platform?: "google" | "facebook" | "";
  key: string;
  revisit?: boolean;
  previouslyDismissedAt?: string;
  previouslySnoozedUntil?: string;
  // Active dismissal (still within snooze window). When true the alert is
  // rendered faded to show it's been addressed but kept visible for
  // continuity. dismissed* fields only populated when dismissed=true.
  dismissed?: boolean;
  dismissedAt?: string;
  dismissedUntil?: string;
  dismissedBy?: string;
};

export type MorningProject = {
  name: string;
  slug: string;
  company: string;
  startIso: string;
  endIso: string;
  daysTotal: number;
  daysElapsed: number;
  daysRemaining: number;
  budget: number;
  spend: number;
  pctBudget: number;
  pctTime: number;
  gAdsUrl: string;
  fbAdsUrl: string;
  sheetTabUrl: string;
  signals: MorningSignal[];
  maxSeverity: number;
};

export type MorningFeed = {
  email: string;
  isAdmin: boolean;
  isInternal: boolean;
  scope: "mine" | "all" | "project" | "none";
  generatedAt: string;
  counts: {
    total: number;
    severe: number;
    warn: number;
    info: number;
    clear: number;
  };
  projects: MorningProject[];
};

export function getMorningFeed(
  opts: { scope?: "mine" | "all"; project?: string } = {},
): Promise<MorningFeed> {
  const params: Record<string, string> = {};
  if (opts.scope) params.scope = opts.scope;
  if (opts.project) params.project = opts.project;
  return callApi<MorningFeed>("morningFeed", params);
}

export type DismissResult = {
  ok: boolean;
  signal_key: string;
  snooze_until: string;
  dismissed_at: string;
};

export function dismissMorningSignal(args: {
  signalKey: string;
  snoozeUntil?: string;
  reason?: string;
}): Promise<DismissResult> {
  return postApi<DismissResult>("dismissMorningSignal", {
    signal_key: args.signalKey,
    snooze_until: args.snoozeUntil ?? "",
    reason: args.reason ?? "",
  });
}

export function unsnoozeMorningSignal(
  signalKey: string,
): Promise<{ ok: boolean; removed: boolean }> {
  return postApi<{ ok: boolean; removed: boolean }>("unsnoozeMorningSignal", {
    signal_key: signalKey,
  });
}

/* ─── Tasks module ───────────────────────────────────────────────── */

export type WorkTaskStatus =
  | "draft"
  | "awaiting_approval"
  | "in_progress"
  | "awaiting_clarification"
  | "done"
  | "cancelled";

export type WorkTaskDepartment = "מדיה" | "קריאייטיב" | "UI/UX" | "תכנון" | "אחר";

export type WorkTaskKind =
  | "ad_creative"
  | "landing_page"
  | "video"
  | "copy"
  | "campaign_launch"
  | "revision"
  | "other";

export type WorkTaskStatusHistoryEntry = {
  at: string;
  by: string;
  from: string;
  to: string;
  note?: string;
};

export type WorkTask = {
  id: string;
  brief: string;
  company: string;
  project: string;
  title: string;
  description: string;
  departments: string[];
  kind: string;
  priority: number;
  status: WorkTaskStatus;
  sub_status: string;
  author_email: string;
  approver_email: string;
  project_manager_email: string;
  assignees: string[];
  requested_date: string;
  created_at: string;
  updated_at: string;
  parent_id: string;
  round_number: number;
  drive_folder_id: string;
  drive_folder_url: string;
  chat_space_id: string;
  chat_task_name: string;
  calendar_event_ids: Record<string, string>;
  google_tasks: Record<string, { u: string; l: string; t: string; d: string }>;
  status_history: WorkTaskStatusHistoryEntry[];
  edited_at: string;
};

export type TasksListFilters = {
  company?: string;
  project?: string;
  brief?: string;
  status?: WorkTaskStatus | "";
  priority?: string; // "1" | "2" | "3" | ""
  department?: string;
  author?: string;
  approver?: string;
  project_manager?: string;
  assignee?: string;
};

export async function tasksList(
  filters: TasksListFilters = {},
): Promise<{ ok: boolean; tasks: WorkTask[]; count: number }> {
  // Feature-flagged direct read path. Route through Sheets API when
  // USE_SA_TASKS_READS=1 for ~10× latency win; fall back to the Apps
  // Script proxy otherwise. Kept in this one place so every caller
  // benefits without per-callsite changes.
  const { useSATasksReads } = await import("@/lib/sa");
  if (useSATasksReads()) {
    const { tasksListDirect } = await import("@/lib/tasksDirect");
    const user = await currentUserEmail();
    return tasksListDirect(user, filters);
  }
  const params: Record<string, string> = {};
  if (filters.company) params.company = filters.company;
  if (filters.project) params.project = filters.project;
  if (filters.brief) params.brief = filters.brief;
  if (filters.status) params.status = filters.status;
  if (filters.priority) params.priority = filters.priority;
  if (filters.department) params.department = filters.department;
  if (filters.author) params.author = filters.author;
  if (filters.approver) params.approver = filters.approver;
  if (filters.project_manager) params.project_manager = filters.project_manager;
  if (filters.assignee) params.assignee = filters.assignee;
  return callApi<{ ok: boolean; tasks: WorkTask[]; count: number }>(
    "tasksList",
    params,
  );
}

export async function tasksGet(
  id: string,
): Promise<{ ok: boolean; task: WorkTask }> {
  const { useSATasksReads } = await import("@/lib/sa");
  if (useSATasksReads()) {
    const { tasksGetDirect } = await import("@/lib/tasksDirect");
    const user = await currentUserEmail();
    return tasksGetDirect(user, id);
  }
  return callApi<{ ok: boolean; task: WorkTask }>("tasksGet", { id });
}

export type TasksPerson = { email: string; name: string; role: string };

export async function tasksPeopleList(): Promise<{
  ok: boolean;
  people: TasksPerson[];
}> {
  const { useSATasksReads } = await import("@/lib/sa");
  if (useSATasksReads()) {
    const { tasksPeopleListDirect } = await import("@/lib/tasksDirect");
    const user = await currentUserEmail();
    return tasksPeopleListDirect(user);
  }
  return callApi<{ ok: boolean; people: TasksPerson[] }>("tasksPeopleList", {});
}

/** Bootstrap a Chat Space for a project. Requires the Google Chat API
 *  advanced service to be enabled in the Apps Script project AND the
 *  API to be enabled in the GCP project. Returns a diagnostic error
 *  (`ok: false` + `howToFix`) if not — so the admin UI can explain
 *  the setup step cleanly rather than dying. */
export type ProjectSpaceCreateResult =
  | { ok: true; space: { name: string; spaceUri?: string; displayName?: string } }
  | { ok: false; error: string; howToFix?: string };

export function projectSpaceCreate(
  project: string,
): Promise<ProjectSpaceCreateResult> {
  return postApi<ProjectSpaceCreateResult>("projectSpaceCreate", { project });
}

export type TasksCreateInput = {
  project: string;
  title: string;
  description?: string;
  company?: string;          // auto-filled from Keys if omitted
  brief?: string;
  departments?: string[];    // multi-select; "מדיה, קריאייטיב" in Data Plus
  kind?: WorkTaskKind | string;
  priority?: number;
  // Initial status for the task — defaults to 'awaiting_approval' when
  // omitted. Accepting it on create lets admin tools seed tasks in any
  // state (e.g. 'done' for backfilling historical data).
  status?: WorkTaskStatus;
  sub_status?: string;
  approver_email?: string;
  project_manager_email?: string;
  assignees?: string[];
  requested_date?: string;
  parent_id?: string;
  round_number?: number;
  revision_of?: string;
};

export function tasksCreate(
  input: TasksCreateInput,
): Promise<{ ok: boolean; task: WorkTask }> {
  return postApi<{ ok: boolean; task: WorkTask }>("tasksCreate", {
    payload: JSON.stringify({
      ...input,
      assignees: (input.assignees ?? []).join(","),
      departments: (input.departments ?? []).join(","),
    }),
  });
}

export type TasksUpdatePatch = {
  status?: WorkTaskStatus;
  note?: string;
  title?: string;
  description?: string;
  brief?: string;
  company?: string;
  departments?: string[];
  kind?: string;
  priority?: number;
  approver_email?: string;
  project_manager_email?: string;
  assignees?: string[];
  requested_date?: string;
  sub_status?: string;
};

export function tasksUpdate(
  id: string,
  patch: TasksUpdatePatch,
): Promise<{ ok: boolean; task: WorkTask; changed: boolean }> {
  return postApi<{ ok: boolean; task: WorkTask; changed: boolean }>(
    "tasksUpdate",
    {
      id,
      payload: JSON.stringify({
        ...patch,
        assignees: patch.assignees ? patch.assignees.join(",") : undefined,
        departments: patch.departments
          ? patch.departments.join(",")
          : undefined,
      }),
    },
  );
}
