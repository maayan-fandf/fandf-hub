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
};

export type MyProjects = {
  projects: Project[];
  isAdmin: boolean;
  email: string;
};

/**
 * Raw shape the Apps Script hub API might return. The old API (pre-company)
 * returns `projects: string[]`; the new one returns `projects: Project[]`.
 * We normalize at the boundary so callers only ever see `Project[]`.
 */
type MyProjectsRaw = {
  projects: (string | Project)[];
  isAdmin: boolean;
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
    typeof p === "string" ? { name: p, company: "" } : { name: p.name, company: p.company ?? "" },
  );
  return { projects, isAdmin: raw.isAdmin, email: raw.email };
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
