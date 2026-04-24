/**
 * Direct-to-Sheets implementation of the tasks read path.
 *
 * Bypasses Apps Script entirely — reads the Comments sheet (where task
 * rows live with row_kind='task') and the Keys tab (for project roster
 * + access control) via `googleapis` using a domain-wide-delegated
 * service account. Called from the hub's server components when
 * USE_SA_TASKS_READS=1.
 *
 * The output shape exactly matches what `tasksList` / `tasksGet` /
 * `tasksPeopleList` return from Apps Script, so callers (queue page,
 * detail page, typed client) don't need to care which path they got.
 *
 * Invariants:
 * - Authorization: we impersonate the caller's email via DWD. If the
 *   caller isn't in F&F Workspace domain, Google rejects the JWT —
 *   that's the right answer, it matches the existing auth model.
 * - Schema: uses COMMENTS_HEADER_NAMES (kept in sync with Apps Script
 *   COMMENTS_HEADERS). Any column not in the header row is ignored on
 *   read.
 * - Filters / sort: same semantics as Apps Script tasksListForUser_.
 *
 * Performance: one Sheets API read per call (plus one Keys read for
 * access-check + company lookup). ~200–400 ms cold vs. ~2–4 s through
 * Apps Script.
 */

import {
  type WorkTask,
  type WorkTaskStatus,
  type TasksPerson,
} from "@/lib/appsScript";
import { sheetsClient } from "@/lib/sa";

const JSON_ARRAY_FIELDS = new Set(["departments", "status_history"]);
const JSON_OBJECT_FIELDS = new Set(["calendar_event_ids", "google_tasks"]);

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function parseJsonCell(
  value: unknown,
  array: boolean,
): unknown {
  if (value == null || value === "") return array ? [] : {};
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return array ? [] : {};
  }
}

function toIsoDate(v: unknown): string {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return String(v);
}

function rowToTask(
  row: unknown[],
  headerIdx: Map<string, number>,
): WorkTask {
  const cell = (k: string): unknown => {
    const i = headerIdx.get(k);
    return i == null ? "" : row[i];
  };
  const mentionsRaw = String(cell("mentions") ?? "");
  const assignees = mentionsRaw
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return {
    id: String(cell("id") ?? ""),
    brief: String(cell("brief") ?? ""),
    company: String(cell("company") ?? ""),
    project: String(cell("project") ?? ""),
    title: String(cell("title") ?? ""),
    // body holds description for task rows (see Apps Script
    // _commentsRowToTask_ — kept identical).
    description: String(cell("body") ?? ""),
    departments: parseJsonCell(cell("departments"), true) as string[],
    kind: String(cell("kind") ?? "other"),
    priority: parseInt(String(cell("priority") ?? "2"), 10) || 2,
    status: (String(cell("status") ?? "awaiting_approval") as WorkTaskStatus),
    sub_status: String(cell("sub_status") ?? ""),
    author_email: String(cell("author_email") ?? "").toLowerCase(),
    approver_email: String(cell("approver_email") ?? "").toLowerCase(),
    project_manager_email: String(cell("project_manager_email") ?? "").toLowerCase(),
    assignees,
    requested_date: String(cell("requested_date") ?? ""),
    created_at: toIsoDate(cell("timestamp")),
    updated_at: String(cell("updated_at") ?? ""),
    parent_id: String(cell("parent_id") ?? ""),
    round_number: parseInt(String(cell("round_number") ?? "1"), 10) || 1,
    drive_folder_id: String(cell("drive_folder_id") ?? ""),
    drive_folder_url: String(cell("drive_folder_url") ?? ""),
    chat_space_id: String(cell("chat_space_id") ?? ""),
    chat_task_name: String(cell("chat_task_name") ?? ""),
    calendar_event_ids: parseJsonCell(
      cell("calendar_event_ids"),
      false,
    ) as Record<string, string>,
    google_tasks: parseJsonCell(
      cell("google_tasks"),
      false,
    ) as Record<string, { u: string; l: string; t: string; d: string }>,
    status_history: parseJsonCell(cell("status_history"), true) as WorkTask["status_history"],
    edited_at: String(cell("edited_at") ?? ""),
    campaign: String(cell("campaign") ?? ""),
  };
}

async function readCommentsTab(subjectEmail: string): Promise<{
  headers: string[];
  rows: unknown[][];
  headerIdx: Map<string, number>;
}> {
  const sheets = sheetsClient(subjectEmail);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
    range: "Comments",
    // Return Date objects as ISO strings, numbers as numbers.
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (!values.length) {
    return { headers: [], rows: [], headerIdx: new Map() };
  }
  const headers = (values[0] as unknown[]).map((h) =>
    String(h ?? "").trim(),
  );
  const headerIdx = new Map<string, number>();
  headers.forEach((h, i) => {
    if (h) headerIdx.set(h, i);
  });
  return { headers, rows: values.slice(1), headerIdx };
}

export async function readKeysRows(
  subjectEmail: string,
): Promise<{ headers: string[]; rows: unknown[][] }> {
  const sheets = sheetsClient(subjectEmail);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: envOrThrow("SHEET_ID_MAIN"),
    range: "Keys",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (!values.length) return { headers: [], rows: [] };
  const headers = (values[0] as unknown[]).map((h) =>
    String(h ?? "")
      // Match Apps Script's Keys header normalization — strip invisibles.
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060\u00AD\uFEFF\uD800-\uDFFF]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return { headers, rows: values.slice(1) };
}

/**
 * Return the set of projects the caller has access to (any Keys
 * column membership), plus the caller's admin status. Used to filter
 * tasksList when the caller isn't an admin.
 *
 * Admin list comes from hardcoded env for now (same as Apps Script
 * CONFIG.ADMIN_EMAILS). Extract to Secret Manager later if it grows.
 */
export const HUB_ADMIN_EMAILS = new Set([
  "maayan@fandf.co.il",
  "nadav@fandf.co.il",
  "felix@fandf.co.il",
]);

export async function getAccessScope(subjectEmail: string): Promise<{
  isAdmin: boolean;
  accessibleProjects: Set<string>;
  projectCompany: Map<string, string>;
}> {
  const lc = subjectEmail.toLowerCase().trim();
  const isAdmin = HUB_ADMIN_EMAILS.has(lc);
  const { headers, rows } = await readKeysRows(subjectEmail);
  const iProj = headers.indexOf("פרוייקט");
  const iCo = headers.indexOf("חברה");
  const iCamp = headers.indexOf("מנהל קמפיינים");
  const iAcct =
    headers.indexOf("EMAIL Manager") >= 0
      ? headers.indexOf("EMAIL Manager")
      : headers.indexOf("EMAIL");
  const iClients = headers.indexOf("Email Client");
  const iInternal = headers.indexOf("Access — internal only");
  const iCf = headers.indexOf("Client-facing");

  const accessible = new Set<string>();
  const companies = new Map<string, string>();

  for (const row of rows) {
    const project = String(row[iProj] ?? "").trim();
    if (!project) continue;
    const company = iCo >= 0 ? String(row[iCo] ?? "").trim() : "";
    if (company) companies.set(project, company);

    if (isAdmin) {
      accessible.add(project);
      continue;
    }
    // Non-admin: match the caller's email against any roster column.
    // Col C / D contain Google-People chips (display names, not emails)
    // — we can't resolve those on the non-admin read-path without a
    // names→emails lookup. For Phase 1 we only check the email columns
    // (E / J / K), which covers client access + internal emails. Admins
    // see everything anyway.
    const emailCols = [iClients, iInternal, iCf].filter((i) => i >= 0);
    for (const ci of emailCols) {
      const raw = String(row[ci] ?? "").toLowerCase();
      if (raw.includes(lc)) {
        accessible.add(project);
        break;
      }
    }
  }
  return { isAdmin, accessibleProjects: accessible, projectCompany: companies };
}

/* ─── Public API (mirrors lib/appsScript.ts tasksList / tasksGet / tasksPeopleList) ─ */

export async function tasksListDirect(
  subjectEmail: string,
  filters: {
    company?: string;
    project?: string;
    brief?: string;
    status?: WorkTaskStatus | "";
    priority?: string;
    department?: string;
    author?: string;
    approver?: string;
    project_manager?: string;
    assignee?: string;
    campaign?: string;
  },
): Promise<{ ok: true; tasks: WorkTask[]; count: number }> {
  const [{ rows, headerIdx }, scope] = await Promise.all([
    readCommentsTab(subjectEmail),
    getAccessScope(subjectEmail),
  ]);

  const rowKindIdx = headerIdx.get("row_kind");
  if (rowKindIdx == null) {
    return { ok: true, tasks: [], count: 0 };
  }

  // Build the task-id → comment-count map in a single pass over the
  // same rows. A comment parented to a task is row_kind='' with
  // parent_id=taskId; task-parented replies are already filtered out
  // from the projectComments feed but still live in the sheet.
  const parentIdIdx = headerIdx.get("parent_id");
  const commentsCount = new Map<string, number>();
  if (parentIdIdx != null) {
    for (const row of rows) {
      const rk = String(row[rowKindIdx] ?? "").trim();
      if (rk === "task") continue; // only count comment rows
      const pid = String(row[parentIdIdx] ?? "");
      if (!pid) continue;
      commentsCount.set(pid, (commentsCount.get(pid) ?? 0) + 1);
    }
  }

  const tasks: WorkTask[] = [];
  for (const row of rows) {
    if (String(row[rowKindIdx] ?? "").trim() !== "task") continue;
    const t = rowToTask(row, headerIdx);
    t.comments_count = commentsCount.get(t.id) ?? 0;

    // Non-admin access gate.
    if (!scope.isAdmin && !scope.accessibleProjects.has(t.project)) continue;

    if (filters.company && t.company.trim() !== filters.company.trim()) continue;
    if (filters.project && t.project.trim() !== filters.project.trim()) continue;
    if (filters.status && t.status !== filters.status) continue;
    if (filters.priority) {
      const pr = parseInt(filters.priority, 10);
      if (pr && t.priority !== pr) continue;
    }
    if (filters.department) {
      const f = filters.department.trim();
      if (!t.departments.some((d) => d.trim() === f)) continue;
    }
    if (
      filters.brief &&
      !t.brief.toLowerCase().includes(filters.brief.toLowerCase())
    ) {
      continue;
    }
    if (filters.author && t.author_email !== filters.author.toLowerCase()) continue;
    if (filters.approver && t.approver_email !== filters.approver.toLowerCase()) continue;
    if (
      filters.project_manager &&
      t.project_manager_email !== filters.project_manager.toLowerCase()
    ) {
      continue;
    }
    if (filters.assignee) {
      const a = filters.assignee.toLowerCase();
      if (!t.assignees.some((e) => e.toLowerCase() === a)) continue;
    }
    if (filters.campaign) {
      const f = filters.campaign.trim();
      if ((t.campaign || "").trim() !== f) continue;
    }
    tasks.push(t);
  }
  tasks.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { ok: true, tasks, count: tasks.length };
}

export async function tasksGetDirect(
  subjectEmail: string,
  taskId: string,
): Promise<{ ok: true; task: WorkTask }> {
  const { rows, headerIdx } = await readCommentsTab(subjectEmail);
  const idIdx = headerIdx.get("id");
  const rowKindIdx = headerIdx.get("row_kind");
  if (idIdx == null || rowKindIdx == null) {
    throw new Error("Task not found: " + taskId);
  }
  // Same single-pass counting as tasksListDirect, scoped to this taskId.
  const parentIdIdx = headerIdx.get("parent_id");
  let commentsCount = 0;
  if (parentIdIdx != null) {
    for (const row of rows) {
      const rk = String(row[rowKindIdx] ?? "").trim();
      if (rk === "task") continue;
      if (String(row[parentIdIdx] ?? "") !== taskId) continue;
      commentsCount++;
    }
  }
  for (const row of rows) {
    if (String(row[idIdx] ?? "") !== taskId) continue;
    if (String(row[rowKindIdx] ?? "").trim() !== "task") continue;
    const t = rowToTask(row, headerIdx);
    t.comments_count = commentsCount;
    const scope = await getAccessScope(subjectEmail);
    if (!scope.isAdmin && !scope.accessibleProjects.has(t.project)) {
      throw new Error("Access denied");
    }
    return { ok: true, task: t };
  }
  throw new Error("Task not found: " + taskId);
}

/**
 * Distinct campaigns for a given project, derived from task rows.
 * Campaigns auto-emerge from tasks — no separate storage table. A
 * campaign is "remembered" as long as at least one task on the project
 * references it. Ordered by most-recently-used (freshest task first)
 * so the picker surfaces what the user likely wants.
 */
export async function tasksCampaignsDirect(
  subjectEmail: string,
  project: string,
): Promise<{ project: string; campaigns: string[] }> {
  const [{ rows, headerIdx }, scope] = await Promise.all([
    readCommentsTab(subjectEmail),
    getAccessScope(subjectEmail),
  ]);

  if (!scope.isAdmin && !scope.accessibleProjects.has(project)) {
    throw new Error("Access denied to project: " + project);
  }

  const rowKindIdx = headerIdx.get("row_kind");
  const projIdx = headerIdx.get("project");
  const campaignIdx = headerIdx.get("campaign");
  const tsIdx = headerIdx.get("timestamp");
  if (rowKindIdx == null || projIdx == null || campaignIdx == null) {
    return { project, campaigns: [] };
  }

  // Collect (campaign, most-recent-timestamp) pairs, then sort.
  const latestByName = new Map<string, string>();
  for (const row of rows) {
    if (String(row[rowKindIdx] ?? "").trim() !== "task") continue;
    if (String(row[projIdx] ?? "").trim() !== project) continue;
    const name = String(row[campaignIdx] ?? "").trim();
    if (!name) continue;
    const ts = tsIdx != null ? toIsoDate(row[tsIdx]) : "";
    const prev = latestByName.get(name);
    if (!prev || ts > prev) latestByName.set(name, ts);
  }
  const campaigns = Array.from(latestByName.entries())
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([name]) => name);
  return { project, campaigns };
}

/**
 * List unique people across the caller's accessible projects. Same
 * output shape as Apps Script tasksPeopleListForUser_. For Phase 1 we
 * read the names-to-emails tab directly (with its Role column) — it's
 * the cleanest universal source of people inside F&F.
 */
export async function tasksPeopleListDirect(
  subjectEmail: string,
): Promise<{ ok: true; people: TasksPerson[] }> {
  const sheets = sheetsClient(subjectEmail);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
    range: "names to emails",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (values.length < 2) return { ok: true, people: [] };
  const headers = (values[0] as unknown[]).map((h) =>
    String(h ?? "").trim().toLowerCase(),
  );
  const iName = findFirst(headers, ["full name", "name", "full_name"]);
  const iEmail = findFirst(headers, ["email", "e-mail", "mail"]);
  const iRole = findFirst(headers, ["role", "תפקיד", "job", "title"]);
  if (iName < 0 || iEmail < 0) return { ok: true, people: [] };

  const seen = new Set<string>();
  const people: TasksPerson[] = [];
  for (let i = 1; i < values.length; i++) {
    const name = String(values[i][iName] ?? "").trim();
    const email = String(values[i][iEmail] ?? "").toLowerCase().trim();
    const role = iRole >= 0 ? String(values[i][iRole] ?? "").trim() : "";
    if (!email || seen.has(email)) continue;
    seen.add(email);
    people.push({ name, email, role });
  }
  return { ok: true, people };
}

function findFirst(headers: string[], candidates: string[]): number {
  for (const c of candidates) {
    const i = headers.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
}
