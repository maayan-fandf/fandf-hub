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

async function callApi<T>(
  action: string,
  params: Record<string, string> = {},
): Promise<T> {
  const base = assertEnv("APPS_SCRIPT_API_URL");
  const token = assertEnv("APPS_SCRIPT_API_TOKEN");
  const user = await currentUserEmail();

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
    // Apps Script responses are cacheable but we want fresh data on each page load
    // in dev. Tune to `{ revalidate: 30 }` once you're happy with the shape.
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

export type Project = {
  name: string;
  company: string; // "" when the Keys tab has no company for this project
  chatSpaceUrl: string; // "" when no Chat webhook is configured for the project
};

export type MyProjects = {
  projects: Project[];
  isAdmin: boolean;
  isInternal: boolean;
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
    | { name: string; company?: string; chat_space_url?: string }
  )[];
  isAdmin: boolean;
  isInternal?: boolean;
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
  deep_link: string;
};

export type ProjectTasks = {
  project: string;
  tasks: TaskItem[];
  me: { email: string; isAdmin: boolean };
  today: string; // YYYY-MM-DD
};

export async function getMyProjects(): Promise<MyProjects> {
  const raw = await callApi<MyProjectsRaw>("myProjects");
  const projects: Project[] = (raw.projects ?? []).map((p) =>
    typeof p === "string"
      ? { name: p, company: "", chatSpaceUrl: "" }
      : {
          name: p.name,
          company: p.company ?? "",
          chatSpaceUrl: p.chat_space_url ?? "",
        },
  );
  return {
    projects,
    isAdmin: raw.isAdmin,
    isInternal: !!raw.isInternal,
    email: raw.email,
  };
}

export function getProjectTasks(project: string): Promise<ProjectTasks> {
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
  deep_link: string;
};

export type MyMentions = {
  mentions: MentionItem[];
  me: { email: string; isAdmin: boolean };
  total: number;
};

export function getMyMentions(): Promise<MyMentions> {
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

export function getProjectComments(
  project: string,
  limit = 20,
): Promise<ProjectComments> {
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

export type NameEmailRow = { full_name: string; email: string };
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
};

export function adminUpsertNameToEmail(args: {
  fullName: string;
  email: string;
}): Promise<UpsertNameToEmailResult> {
  return postApi<UpsertNameToEmailResult>("adminUpsertNameToEmail", {
    fullName: args.fullName,
    email: args.email,
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
