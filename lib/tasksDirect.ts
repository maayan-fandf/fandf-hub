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
import { sheetsClient, useFirestoreTasks } from "@/lib/sa";
import { readKeysCached } from "@/lib/keys";

const JSON_ARRAY_FIELDS = new Set([
  "departments",
  "status_history",
  // Dependencies + chains (phase 1, 2026-05-03). Both arrays are JSON-
  // serialized lists of task IDs. Defaults to [] when absent or
  // unparseable, same as departments / status_history.
  "blocks",
  "blocked_by",
  // Description-edit snapshots — see WorkTaskDescriptionHistoryEntry.
  "description_history",
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
    // Pause/resume events on the in-progress counter. Graceful: empty /
    // missing `time_pauses` column → [] (legacy rows + rollout window).
    time_pauses: parseJsonCell(cell("time_pauses"), true) as WorkTask["time_pauses"],
    description_history: parseJsonCell(
      cell("description_history"),
      true,
    ) as WorkTask["description_history"],
    edited_at: String(cell("edited_at") ?? ""),
    campaign: String(cell("campaign") ?? ""),
    // CSV of file IDs — TaskFilesPanel's manual order. Empty when the
    // column doesn't exist yet (graceful — we ship code first, sheet
    // header gets added on first reorder save).
    file_order: String(cell("file_order") ?? ""),
    // Pending-completion claim JSON. Empty when no GT completion is
    // awaiting confirmation. See the type definition for shape.
    pending_complete: String(cell("pending_complete") ?? ""),
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
    // Task price (₪). Graceful: empty / missing `price` column → undefined
    // (legacy rows + rollout window). Tolerates "₪500" / "1,200".
    price: (() => {
      const raw = cell("price");
      if (raw === "" || raw == null) return undefined;
      const n = Number(String(raw).replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? n : undefined;
    })(),
    // Editable status-derived time override (minutes). Graceful: empty /
    // missing `inprogress_minutes` column → undefined, which makes the
    // UI fall back to the value derived live from status_history.
    inprogress_minutes: (() => {
      const raw = cell("inprogress_minutes");
      if (raw === "" || raw == null) return undefined;
      const n = Number(String(raw).replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    })(),
  };
}

// Two-layer memoization on the Comments tab read:
//
//   1. Per-request: React's `cache()` collapses concurrent calls
//      WITHIN one request to a single shared promise. Same pattern
//      as readKeysCached in lib/keys.ts. Saves the 2-3 reads a
//      single page render would otherwise burn (tasksList +
//      tasksGet + round-siblings).
//
//   2. Cross-request: a process-local Map (well, single-slot since
//      the data is the same regardless of subject) holds the parsed
//      snapshot for a short TTL. On a burst of concurrent /tasks
//      loads, only the first one hits Sheets; the rest serve
//      cached. Staleness is bounded to TTL per Firebase App
//      Hosting instance — a user's own edits invalidate the cache
//      explicitly via `invalidateCommentsCache()` from
//      tasksWriteDirect, so they see their changes instantly.
//
// We deliberately avoid `unstable_cache` here — it's the
// cross-instance staleness trap noted in feedback_unstable_cache_*.
// Process-local Map mirrors lib/userAvatar.ts.
//
// Why this layer was added (2026-05-07): the F&F GCP project's
// default 300-reads/min/project Sheets quota was tripping during
// normal /tasks browsing (multiple tabs + Cloud Scheduler poll +
// background nav prefetches). The cache cuts the per-minute read
// volume by ~10× on bursty traffic, well within the human-tolerable
// staleness window.

type CommentsValue = {
  headers: string[];
  rows: unknown[][];
  headerIdx: Map<string, number>;
};

const COMMENTS_CACHE_TTL_MS = 5_000;
let _commentsCacheValue: CommentsValue | null = null;
let _commentsCacheExpiresAt = 0;

/** Bust the in-process Comments-tab cache. Call after any write to
 *  the Comments sheet (tasksCreateDirect / tasksUpdateDirect /
 *  cascade / umbrellaRecompute) so the next read pulls fresh data
 *  on the same instance. Other instances still see TTL-staleness
 *  for up to ~5s — acceptable for the data shape (a user's own
 *  edits land instantly because the post-write invalidate runs on
 *  the SAME instance that handled the write). */
export function invalidateCommentsCache(): void {
  _commentsCacheValue = null;
  _commentsCacheExpiresAt = 0;
}

const readCommentsTab = cache(
  async (
    subjectEmail: string,
    /** §11 — when supplied (and the Firestore flag is on), read only
     *  this project's `tasks`/`comments` instead of the whole
     *  collection. Behavior-identical for project-filtered callers
     *  (tasksListDirect with filters.project, tasksCampaignsDirect).
     *  See readCommentsShapeForProject. */
    project?: string,
  ): Promise<CommentsValue> => {
    // §11 — project-scoped path. MUST return BEFORE the single-slot
    // TTL cache below and MUST NOT read/write it: `_commentsCacheValue`
    // is ONE shared slot for the WHOLE collection — caching a project
    // subset there would serve that subset to a whole-collection caller
    // for up to COMMENTS_CACHE_TTL_MS. Per-request dedup comes from
    // readCommentsShapeForProject's own React cache() (keyed by
    // project); cross-request freshness is request-scoped, the same
    // model the whole-collection Firestore branch below already uses.
    const p = project?.trim();
    if (p && useFirestoreTasks()) {
      const { readCommentsShapeForProject } = await import(
        "@/lib/firestoreRead"
      );
      return readCommentsShapeForProject(p);
    }
    if (_commentsCacheValue && Date.now() < _commentsCacheExpiresAt) {
      return _commentsCacheValue;
    }
    // Phase 3 storage migration — Firestore read path behind the flag.
    // Returns the EXACT Sheets shape (rows/headerIdx) so every
    // downstream reader (rowToTask, the filters) runs unchanged. Still
    // honors the process-local TTL cache below for cross-request dedupe
    // (handoff: keep the cache structure until Phase 5). invalidate-
    // CommentsCache() (called by the dual-write) busts it on writes.
    if (useFirestoreTasks()) {
      const { readCommentsShapeFromFirestore } = await import(
        "@/lib/firestoreRead"
      );
      const fsResult = await readCommentsShapeFromFirestore();
      _commentsCacheValue = fsResult;
      _commentsCacheExpiresAt = Date.now() + COMMENTS_CACHE_TTL_MS;
      return fsResult;
    }
    const sheets = sheetsClient(subjectEmail);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
      range: "Comments",
      // Return Date objects as ISO strings, numbers as numbers.
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const values = (res.data.values ?? []) as unknown[][];
    let result: CommentsValue;
    if (!values.length) {
      result = { headers: [], rows: [], headerIdx: new Map() };
    } else {
      const headers = (values[0] as unknown[]).map((h) =>
        String(h ?? "").trim(),
      );
      const headerIdx = new Map<string, number>();
      headers.forEach((h, i) => {
        if (h) headerIdx.set(h, i);
      });
      result = { headers, rows: values.slice(1), headerIdx };
    }
    _commentsCacheValue = result;
    _commentsCacheExpiresAt = Date.now() + COMMENTS_CACHE_TTL_MS;
    return result;
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
    /** Exact-match on `task.kind`. */
    kind?: string;
    author?: string;
    approver?: string;
    project_manager?: string;
    assignee?: string;
    campaign?: string;
    requested_date_from?: string;
    requested_date_to?: string;
    /** OR-filter across author/approver/project_manager/assignee. When
     *  set, a task passes if any of those email fields matches. Used
     *  by /tasks default view so a manager who is the PM on some
     *  projects sees those tasks alongside ones they author/approve/
     *  work on directly. Reported by Maayan 2026-05-12: Itay (Client
     *  Manager on the מטרו project, listed as `project_manager_email`
     *  on its tasks but not author/approver/assignee) couldn't see
     *  the project's tasks in his default queue. */
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
  // §11 — when the caller filters by a single project (e.g. the
  // project page's tasksList({project})), scope the Firestore read to
  // that project. Behavior-identical: the access gate, every filter,
  // the comment-count / involved_with pass, and the umbrella-sibling
  // 2nd pass are all project-local (chain siblings + a task's comments
  // share the task's project — see commentsWriteDirect / tasksCreate
  // Chain). Unfiltered /tasks queue (no filters.project) → undefined →
  // whole-collection read, unchanged.
  const [{ rows, headerIdx }, scope] = await Promise.all([
    readCommentsTab(subjectEmail, filters.project),
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
    if (filters.kind) {
      const f = filters.kind.trim();
      if ((t.kind || "").trim() !== f) continue;
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
      const isPm = t.project_manager_email === r;
      const isAssignee = t.assignees.some((e) => e.toLowerCase() === r);
      if (!isAuthor && !isApprover && !isPm && !isAssignee) continue;
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

  // ── umbrellas-mode chain context augmentation ────────────────────
  // When the user toggles the עטיפות chip (`include_umbrellas=true`),
  // the chain-context view becomes meaningful: they're asking to see
  // each chain in full. The default relevance filter (relevant_to_me /
  // assignee=me) hides upstream/downstream stages assigned to teammates,
  // which is exactly the context the user wants in this mode.
  //
  // Strategy: after the main filter pass, find every umbrella id touched
  // by the result (either the row IS an umbrella, or its umbrella_id
  // points at one). Then do a second pass adding sibling rows that share
  // those umbrella ids — bypassing the relevance filters but still
  // enforcing access + scope (company/project/department/kind/
  // brief/dates/campaign). Status filter is also relaxed so a "done"
  // upstream stage appears alongside the user's current "awaiting"
  // stage — the user expects to see the whole journey in this view.
  // Maayan reported 2026-05-12: chain context invisible without
  // flipping between tasks.
  if (filters.include_umbrellas) {
    const umbrellaIds = new Set<string>();
    for (const t of tasks) {
      if (t.is_umbrella) umbrellaIds.add(t.id);
      else if (t.umbrella_id) umbrellaIds.add(t.umbrella_id);
    }
    if (umbrellaIds.size > 0) {
      const existing = new Set(tasks.map((t) => t.id));
      for (const row of rows) {
        if (String(row[rowKindIdx] ?? "").trim() !== "task") continue;
        const t = rowToTask(row, headerIdx);
        if (!t.id.trim()) continue;
        if (existing.has(t.id)) continue;
        const isUmbrellaOfFamily = t.is_umbrella && umbrellaIds.has(t.id);
        const isChildOfFamily =
          !t.is_umbrella && !!t.umbrella_id && umbrellaIds.has(t.umbrella_id);
        if (!isUmbrellaOfFamily && !isChildOfFamily) continue;
        // Access gate — same logic as the main loop. Personal-note
        // pseudo-projects keep their stricter check.
        if (t.project.startsWith("__")) {
          const lcUser = subjectEmail.toLowerCase();
          const isAssignee = (t.assignees || []).some(
            (e) => e.toLowerCase() === lcUser,
          );
          const isAuthor = (t.author_email || "").toLowerCase() === lcUser;
          if (!isAssignee && !isAuthor) continue;
        } else if (!scope.isAdmin && !scope.accessibleProjects.has(t.project)) {
          continue;
        }
        // Scope/content filters still apply (everything except
        // relevance: relevant_to_me / assignee / author / approver /
        // project_manager / involved_with — and status, which we
        // relax so done/blocked siblings appear).
        if (filters.company && t.company.trim() !== filters.company.trim()) continue;
        if (filters.project && t.project.trim() !== filters.project.trim()) continue;
        if (filters.priority) {
          const pr = parseInt(filters.priority, 10);
          if (pr && t.priority !== pr) continue;
        }
        if (filters.department) {
          const f = filters.department.trim();
          if (!t.departments.some((d) => d.trim() === f)) continue;
        }
        if (filters.kind) {
          const f = filters.kind.trim();
          if ((t.kind || "").trim() !== f) continue;
        }
        if (
          filters.brief &&
          !t.brief.toLowerCase().includes(filters.brief.toLowerCase())
        ) {
          continue;
        }
        if (filters.campaign) {
          const f = filters.campaign.trim();
          if ((t.campaign || "").trim() !== f) continue;
        }
        if (filters.requested_date_from || filters.requested_date_to) {
          const d = (t.requested_date || "").slice(0, 10);
          if (!d) continue;
          if (filters.requested_date_from && d < filters.requested_date_from) continue;
          if (filters.requested_date_to && d > filters.requested_date_to) continue;
        }
        t.comments_count = commentsCount.get(t.id) ?? 0;
        tasks.push(t);
      }
    }
  }

  tasks.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { ok: true, tasks, count: tasks.length };
}

export async function tasksGetDirect(
  subjectEmail: string,
  taskId: string,
): Promise<{ ok: true; task: WorkTask }> {
  // §11: do NOT thread a project here — this lookup is by task id and
  // the caller does not know the task's project up front. The
  // whole-collection read is required (a different, out-of-scope
  // surface — task detail page — optimize separately if needed).
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
    // Access check, in order of permissiveness:
    //   1. admins always pass
    //   2. internal @fandf.co.il users always pass — mirrors the
    //      "domain blanket" intent already documented in
    //      getAccessScope(). The blanket there only applies to projects
    //      that have a Keys-sheet row; tasks tied to projects WITHOUT a
    //      Keys row (e.g. `__personal__` notes, brand-new projects, or
    //      projects where the Keys row was deleted) used to 500
    //      internal users with "Access denied". This explicit subject-
    //      level check makes the blanket actually blanket.
    //   3. the task's author / approver / assignee always pass — same
    //      principle as Gmail: if you're on the thread, you can read
    //      the message regardless of what folder it lives in.
    //   4. otherwise the project must be in accessibleProjects.
    // Project string is trimmed on both sides — Sheets cells sometimes
    // carry trailing whitespace, and the access scope already trims its
    // side, so without this normalization a 1-char delta would 500.
    const lc = subjectEmail.toLowerCase().trim();
    const isInternal = lc.endsWith("@fandf.co.il");
    const proj = t.project.trim();
    const onTask =
      (t.author_email || "").toLowerCase().trim() === lc ||
      (t.approver_email || "").toLowerCase().trim() === lc ||
      (t.assignees || []).some(
        (a) => String(a).toLowerCase().trim() === lc,
      );
    const allowed =
      scope.isAdmin ||
      isInternal ||
      onTask ||
      scope.accessibleProjects.has(proj) ||
      scope.accessibleProjects.has(t.project);
    if (!allowed) {
      throw new Error("Access denied");
    }
    return { ok: true, task: t };
  }
  throw new Error("Task not found: " + taskId);
}

/**
 * Phase 3 fix — read ONE task row straight from the **Sheets**
 * `Comments` tab, unconditionally (never the flag-gated reader, never
 * Firestore, no process cache, no access gate). Used ONLY by the
 * Firestore dual-write mirror.
 *
 * Why this exists: every task WRITE path (tasksUpdateDirect /
 * createDirect / dependencyCascade / umbrellaRecompute) commits to
 * Sheets directly regardless of the read flag. The mirror must reflect
 * THAT just-written Sheets state. Routing the mirror's re-read through
 * `tasksGetDirect` was the read-flip bug: with USE_FIRESTORE_TASKS=1 it
 * read Firestore (the stale copy we're trying to update) instead of the
 * fresh Sheets row, so the mirror wrote stale data back and Firestore
 * never converged. Pinning the mirror read to Sheets fixes that. No
 * access gate: this is an internal system mirror, not a user read.
 * Returns null when the task row isn't found.
 */
/** Phase 4 — expose the canonical row→WorkTask reader so the
 *  Firestore-authoritative write path (lib/firestoreWrite) can turn a
 *  post-transaction shaped doc-row back into a WorkTask using the exact
 *  same parsing every other reader uses. */
export function rowToTaskForMirror(
  row: unknown[],
  headerIdx: Map<string, number>,
): WorkTask {
  return rowToTask(row, headerIdx);
}

export async function tasksGetFromSheetsForMirror(
  subjectEmail: string,
  taskId: string,
): Promise<WorkTask | null> {
  const id = String(taskId ?? "").trim();
  if (!id) return null;
  const sheets = sheetsClient(subjectEmail);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
    range: "Comments",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (values.length < 2) return null;
  const headers = (values[0] as unknown[]).map((h) => String(h ?? "").trim());
  const headerIdx = new Map<string, number>();
  headers.forEach((h, i) => {
    if (h) headerIdx.set(h, i);
  });
  const idIdx = headerIdx.get("id");
  const rowKindIdx = headerIdx.get("row_kind");
  if (idIdx == null || rowKindIdx == null) return null;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (String(row[idIdx] ?? "") !== id) continue;
    if (String(row[rowKindIdx] ?? "").trim() !== "task") continue;
    return rowToTask(row, headerIdx);
  }
  return null;
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
  // §11 — campaigns are read per-project; scope the Firestore read.
  const [{ rows, headerIdx }, scope] = await Promise.all([
    readCommentsTab(subjectEmail, project),
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
  //
  // Defensively skip names that match the reserved-subfolder list — a
  // stray task row stored before the picker filter went in (e.g. a user
  // manually typed "פריסות" as a בריף) shouldn't keep resurrecting the
  // option here. Source of truth is `lib/driveCampaigns.ts`.
  const { isReservedCampaignSubfolderName } = await import(
    "@/lib/driveCampaigns"
  );
  const orphans = Array.from(taskCampaigns.entries())
    .filter(([name]) => !seen.has(name))
    .filter(([name]) => !isReservedCampaignSubfolderName(name))
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
    // Role passes through verbatim (preserving the sheet's typed
    // case — "Media", "Client Manager" — which several display
    // surfaces render directly). Comparison sites (PM-substring
    // check, RoleChip lookup, dept filter) all lowercase locally
    // when they need to, so leaving the case intact here is safe
    // and makes the rendered " · {role}" labels match what was
    // typed in the sheet.
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
