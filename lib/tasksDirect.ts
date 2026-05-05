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

import { cache } from "react";
import {
  type WorkTask,
  type WorkTaskStatus,
  type TasksPerson,
  type GTaskRef,
} from "@/lib/appsScript";
import { sheetsClient } from "@/lib/sa";
import { readKeysCached } from "@/lib/keys";

const JSON_ARRAY_FIELDS = new Set([
  "departments",
  "status_history",
  // Dependencies + chains (phase 1, 2026-05-03). Both arrays are JSON-
  // serialized lists of task IDs. Defaults to [] when absent or
  // unparseable, same as departments / status_history.
  "blocks",
  "blocked_by",
]);
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

/** Normalize the `google_tasks` cell to a flat array regardless of how
 *  it was written. Hub-next now writes arrays; legacy rows may carry
 *  the old `{ email: ref }` map shape — `Object.values()` flattens
 *  those to the same array. */
function parseGoogleTasksCell(value: unknown): GTaskRef[] {
  if (value == null || value === "") return [];
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (Array.isArray(parsed)) return parsed as GTaskRef[];
  if (parsed && typeof parsed === "object") {
    return Object.values(parsed as Record<string, GTaskRef>);
  }
  return [];
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
    google_tasks: parseGoogleTasksCell(cell("google_tasks")),
    status_history: parseJsonCell(cell("status_history"), true) as WorkTask["status_history"],
    edited_at: String(cell("edited_at") ?? ""),
    campaign: String(cell("campaign") ?? ""),
    rank: (() => {
      const raw = cell("rank");
      const parsed =
        raw === "" || raw == null ? NaN : parseFloat(String(raw));
      if (Number.isFinite(parsed)) return parsed;
      // Fallback: derive from created_at (newer = smaller = top).
      const ms = Date.parse(toIsoDate(cell("timestamp")));
      return Number.isFinite(ms) ? -ms : Number.MAX_SAFE_INTEGER / 2;
    })(),
    // Dependencies + chains — phase 1 additions. Default to empty
    // arrays / "" / false when columns are missing, so legacy rows
    // (and the rollout window before headers ship) parse cleanly.
    blocks: parseJsonCell(cell("blocks"), true) as string[],
    blocked_by: parseJsonCell(cell("blocked_by"), true) as string[],
    umbrella_id: String(cell("umbrella_id") ?? ""),
    // Boolean cell may arrive as bool, string "TRUE"/"true"/"1", or
    // number 1. Anything else (incl. "" / null / undefined) → false.
    is_umbrella: (() => {
      const v = cell("is_umbrella");
      if (v === true || v === 1) return true;
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        return s === "true" || s === "1" || s === "yes";
      }
      return false;
    })(),
  };
}

// Per-request memoized read of the Comments tab. Both tasksList and
// tasksGet (and now the round-siblings lookup on /tasks/[id]) hit
// this; without dedup, opening a task page burns 2-3 Sheets reads of
// the same tab. React's cache() collapses concurrent calls within one
// request to a single shared promise — same pattern as readKeysCached
// in lib/keys.ts.
const readCommentsTab = cache(
  async (
    subjectEmail: string,
  ): Promise<{
    headers: string[];
    rows: unknown[][];
    headerIdx: Map<string, number>;
  }> => {
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
  },
);

// readKeysRows() previously did its own Sheets fetch — now re-exported
// from the shared cached helper so multiple callers in one request
// (e.g. project page → access scope → write gate) collapse to a single
// Sheets API GET. See lib/keys.ts for rationale.
export { readKeysCached as readKeysRows } from "@/lib/keys";


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
  // Resolve the caller's display name(s) so we can match Google People
  // chip cells (cols C / D) and CSV name cells (cols J / K) — e.g. an
  // account-manager listed as "Itay Stein" in EMAIL Manager. Without
  // this, a non-admin manager's accessibleProjects came back EMPTY,
  // which made every /tasks/[id] load 500 with "Access denied" and
  // hid every relevant task on /tasks. Internal F&F users also get a
  // domain-blanket pass (matches getMyProjectsDirect's intent — staff
  // can navigate to any internal project).
  const isInternal = lc.endsWith("@fandf.co.il");
  const [{ headers, rows }, displayNames] = await Promise.all([
    readKeysCached(subjectEmail),
    isAdmin ? Promise.resolve([] as string[]) : getDisplayNamesForEmailLazy(subjectEmail),
  ]);
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
  const lcNames = displayNames
    .map((n) => n.toLowerCase().trim())
    .filter(Boolean);

  for (const row of rows) {
    const project = String(row[iProj] ?? "").trim();
    if (!project) continue;
    const company = iCo >= 0 ? String(row[iCo] ?? "").trim() : "";
    if (company) companies.set(project, company);

    if (isAdmin) {
      accessible.add(project);
      continue;
    }

    let matched = false;
    // Email-substring match against cols E (clients) and J / K
    // (internal/client-facing CSV of emails).
    for (const ci of [iClients, iInternal, iCf]) {
      if (ci < 0) continue;
      const raw = String(row[ci] ?? "").toLowerCase();
      if (raw.includes(lc)) {
        matched = true;
        break;
      }
    }
    // Display-name match against cols C / D (single chip) and J / K
    // (CSV — names sometimes appear there alongside emails).
    if (!matched && lcNames.length > 0) {
      for (const ci of [iCamp, iAcct]) {
        if (ci < 0) continue;
        const cell = String(row[ci] ?? "").toLowerCase().trim();
        if (cell && lcNames.includes(cell)) {
          matched = true;
          break;
        }
      }
    }
    if (!matched && lcNames.length > 0) {
      for (const ci of [iInternal, iCf]) {
        if (ci < 0) continue;
        const csv = String(row[ci] ?? "")
          .toLowerCase()
          .split(/[,;\n]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (lcNames.some((n) => csv.includes(n))) {
          matched = true;
          break;
        }
      }
    }
    // Domain blanket: internal F&F can navigate to any internal project
    // even if not on the roster. Mirrors getMyProjectsDirect's behavior.
    if (!matched && isInternal) matched = true;
    if (matched) accessible.add(project);
  }
  return { isAdmin, accessibleProjects: accessible, projectCompany: companies };
}

// Lazy-imported to dodge a circular import — projectsDirect.ts pulls
// readKeysRows / HUB_ADMIN_EMAILS from this file.
async function getDisplayNamesForEmailLazy(email: string): Promise<string[]> {
  const { getDisplayNamesForEmail } = await import("@/lib/projectsDirect");
  return getDisplayNamesForEmail(email);
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
    requested_date_from?: string;
    requested_date_to?: string;
    /** OR-filter across author/approver/assignee. When set, a task
     *  passes if its author_email, approver_email, OR any assignee
     *  email matches. Used by /tasks default view so a manager who is
     *  ALSO an assignee on some task sees both sets at once instead
     *  of having to flip between filters. */
    relevant_to_me?: string;
    /** Broader OR-filter: author OR approver OR project_manager OR
     *  any assignee OR mentioned-in-any-discussion-comment.
     *  Powers the /tasks "מעורב במשימה" picker — finds every task
     *  someone touched, regardless of role. The mention check
     *  walks the same in-memory rows we already loaded for tasks
     *  (comment rows on the Comments sheet have row_kind='' and
     *  parent_id pointing at the task), so the cost is one extra
     *  pass over rows we'd read anyway. */
    involved_with?: string;
    /** Surface umbrella container rows in the result. By default
     *  (`false`/omitted) `is_umbrella=true` rows are filtered out so
     *  the standard list view shows only "real" work — children of
     *  a chain already appear individually, and the umbrella's only
     *  purpose is rollup (which we deliberately keep out of the
     *  busy table view). The /tasks chip toggle "📦 הצג עטיפות"
     *  flips this to `true` so users can scan all chains at once.
     *  Phase 4 of dependencies feature, 2026-05-03. */
    include_umbrellas?: boolean;
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
  // Same pass also collects task ids where `involved_with` was
  // mentioned in any reply, so the involved-with filter below can
  // be a single Set lookup per task.
  const parentIdIdx = headerIdx.get("parent_id");
  const mentionsIdx = headerIdx.get("mentions");
  const commentsCount = new Map<string, number>();
  const involvedWith = (filters.involved_with || "").toLowerCase().trim();
  const mentionedTaskIds = new Set<string>();
  if (parentIdIdx != null) {
    for (const row of rows) {
      const rk = String(row[rowKindIdx] ?? "").trim();
      if (rk === "task") continue; // only count comment rows
      const pid = String(row[parentIdIdx] ?? "");
      if (!pid) continue;
      commentsCount.set(pid, (commentsCount.get(pid) ?? 0) + 1);
      if (involvedWith && mentionsIdx != null) {
        const mentions = String(row[mentionsIdx] ?? "").toLowerCase();
        if (mentions.includes(involvedWith)) {
          mentionedTaskIds.add(pid);
        }
      }
    }
  }

  const tasks: WorkTask[] = [];
  for (const row of rows) {
    if (String(row[rowKindIdx] ?? "").trim() !== "task") continue;
    const t = rowToTask(row, headerIdx);
    // Skip rows with empty / whitespace id — they surface broken links
    // like /tasks/%20 in TasksQueue and break every comment-reply
    // attempt with "Parent comment not found". Log so the bad row
    // can be tracked down + cleaned up in the sheet.
    if (!t.id.trim()) {
      console.log(
        `[tasksDirect] skipping task row with empty id (project="${t.project}", title="${t.title}")`,
      );
      continue;
    }
    t.comments_count = commentsCount.get(t.id) ?? 0;

    // Phase 4 dependencies — hide umbrella container rows by default.
    // Children of a chain already appear individually; the umbrella's
    // job is rollup, which would clutter the busy list view. The
    // /tasks "📦 הצג עטיפות" chip toggle flips include_umbrellas=true
    // to surface them. Applied BEFORE the access gate so the count
    // exclusion is consistent regardless of role.
    if (t.is_umbrella && !filters.include_umbrellas) continue;

    // Non-admin access gate.
    // Pseudo-projects (e.g. `__personal__`) bypass the Keys roster check —
    // they're personal-notes rows that don't live in the Keys hierarchy.
    // Privacy gate: only the listed assignees or the author see them, and
    // we deliberately skip the admin shortcut so admins don't see other
    // people's personal notes (different mental model from project rows).
    if (t.project.startsWith("__")) {
      const lcUser = subjectEmail.toLowerCase();
      const isAssignee = (t.assignees || []).some((e) => e.toLowerCase() === lcUser);
      const isAuthor   = (t.author_email || "").toLowerCase() === lcUser;
      if (!isAssignee && !isAuthor) continue;
    } else if (!scope.isAdmin && !scope.accessibleProjects.has(t.project)) {
      continue;
    }

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
    if (filters.relevant_to_me) {
      const r = filters.relevant_to_me.toLowerCase();
      const isAuthor = t.author_email === r;
      const isApprover = t.approver_email === r;
      const isAssignee = t.assignees.some((e) => e.toLowerCase() === r);
      if (!isAuthor && !isApprover && !isAssignee) continue;
    }
    if (involvedWith) {
      const isAuthor = t.author_email === involvedWith;
      const isApprover = t.approver_email === involvedWith;
      const isPm = t.project_manager_email === involvedWith;
      const isAssignee = t.assignees.some(
        (e) => e.toLowerCase() === involvedWith,
      );
      const isMentioned = mentionedTaskIds.has(t.id);
      if (!isAuthor && !isApprover && !isPm && !isAssignee && !isMentioned)
        continue;
    }
    if (filters.campaign) {
      const f = filters.campaign.trim();
      if ((t.campaign || "").trim() !== f) continue;
    }
    // Date-range filter on requested_date. Compares as YYYY-MM-DD
    // strings (lexicographic == chronological for that format). Tasks
    // without a requested_date are excluded when either bound is set.
    if (filters.requested_date_from || filters.requested_date_to) {
      const d = (t.requested_date || "").slice(0, 10);
      if (!d) continue;
      if (
        filters.requested_date_from &&
        d < filters.requested_date_from
      ) {
        continue;
      }
      if (filters.requested_date_to && d > filters.requested_date_to) {
        continue;
      }
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
 * Distinct campaigns for a given project. Drive folders under
 * `<company>/<project>/` are the canonical source: every Drive
 * subfolder there counts as a campaign, even one with zero tasks yet.
 * Task-row campaign values are then merged in as a safety net so an
 * orphan campaign (one referenced on a task but missing a Drive folder
 * — the legacy task-derived shape) still appears in the menu.
 *
 * Ordering: Drive folders first, ordered by `modifiedTime desc`, then
 * any task-only orphans by their freshest task. Drive dictates the
 * canonical name for a folder ID, so a folder rename in Drive surfaces
 * automatically on the next read.
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

  // Collect task-row campaigns first — both for the orphan-merge below
  // AND so we still return something when Drive is misconfigured (no
  // TASKS_SHARED_DRIVE_ID, network blip, scopes off). The picker is too
  // important a UX surface to fail closed on.
  const rowKindIdx = headerIdx.get("row_kind");
  const projIdx = headerIdx.get("project");
  const campaignIdx = headerIdx.get("campaign");
  const tsIdx = headerIdx.get("timestamp");
  const taskCampaigns = new Map<string, string>(); // name → freshest ts
  if (rowKindIdx != null && projIdx != null && campaignIdx != null) {
    for (const row of rows) {
      if (String(row[rowKindIdx] ?? "").trim() !== "task") continue;
      if (String(row[projIdx] ?? "").trim() !== project) continue;
      const name = String(row[campaignIdx] ?? "").trim();
      if (!name) continue;
      const ts = tsIdx != null ? toIsoDate(row[tsIdx]) : "";
      const prev = taskCampaigns.get(name);
      if (!prev || ts > prev) taskCampaigns.set(name, ts);
    }
  }

  // Drive list scoped to this project. Empty when the project folder
  // doesn't exist yet (brand-new project). Cheap to call repeatedly —
  // listCampaignFolders is unstable_cache-d at 60s.
  const company = scope.projectCompany.get(project) || "";
  let driveFolders: { id: string; name: string; modifiedTime: string }[] = [];
  try {
    const { listCampaignFolders } = await import("@/lib/driveCampaigns");
    driveFolders = await listCampaignFolders(company, project);
  } catch {
    // Fall through to task-derived list — picker stays usable when
    // Drive is unreachable.
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of driveFolders) {
    const n = f.name.trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  // Append task-only orphans (campaigns referenced on tasks but with no
  // matching Drive folder). The rename / create paths backfill folders
  // for these; until then, keep them visible so the user can still pick
  // them when assigning a task.
  const orphans = Array.from(taskCampaigns.entries())
    .filter(([name]) => !seen.has(name))
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([name]) => name);
  for (const n of orphans) {
    seen.add(n);
    out.push(n);
  }
  return { project, campaigns: out };
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
  // Optional Hebrew-name column added 2026-05-05 — preferred over the
  // English `Full Name` for every UI surface that displays the person
  // (see lib/personDisplay.ts). Tolerant header matching so the sheet
  // owner can rename the column without code changes.
  const iHeName = findFirst(headers, [
    "he name",
    "hebrew name",
    "he_name",
    "שם בעברית",
    "שם עברית",
    "שם",
  ]);
  if (iName < 0 || iEmail < 0) return { ok: true, people: [] };

  const seen = new Set<string>();
  const people: TasksPerson[] = [];
  for (let i = 1; i < values.length; i++) {
    const name = String(values[i][iName] ?? "").trim();
    const email = String(values[i][iEmail] ?? "").toLowerCase().trim();
    const role = iRole >= 0 ? String(values[i][iRole] ?? "").trim() : "";
    const heName =
      iHeName >= 0 ? String(values[i][iHeName] ?? "").trim() : "";
    if (!email || seen.has(email)) continue;
    seen.add(email);
    people.push({ name, email, role, ...(heName ? { he_name: heName } : {}) });
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
