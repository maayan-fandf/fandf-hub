/**
 * Direct-to-Google write path for tasks.
 *
 * Mirrors the Apps Script tasksCreateForUser_ / tasksUpdateForUser_
 * orchestration but runs entirely in Node using `googleapis` with
 * domain-wide-delegated impersonation. Saves the ~2–4 s Apps Script
 * overhead per write and unblocks future improvements (parallel side
 * effects, richer error handling, etc).
 *
 * Invariants preserved from the Apps Script version:
 * - Tasks live in the Comments sheet with row_kind='task'.
 * - body stores description; mentions CSV stores assignees; resolved
 *   stays in sync with status ('done' ↔ true).
 * - State machine transitions follow TASKS_ALLOWED_TRANSITIONS below
 *   (same list as Apps Script).
 * - Drive folder hierarchy: root/<company>/<project>/<task-id — title>.
 *   Root is looked up by name "F&F Tasks" under the impersonated
 *   DRIVE_FOLDER_OWNER (defaults to maayan@fandf.co.il).
 * - Side-effect failures are logged but don't roll back the row; a
 *   retry on the same task upserts the missing side effects.
 */

import type { drive_v3 } from "googleapis";
import {
  sheetsClient,
  driveClient,
  calendarClient,
  tasksApiClient,
  gmailClient,
  driveFolderOwner,
} from "@/lib/sa";
import { readKeysCached } from "@/lib/keys";
import type {
  GTaskKind,
  TasksCreateInput,
  TasksUpdatePatch,
  WorkTask,
  WorkTaskStatus,
  GTaskRef,
} from "@/lib/appsScript";

/** Normalize the cell to the canonical array shape. Legacy rows wrote
 *  it as `Record<string, GTaskRef>` (keyed by recipient email). New
 *  writes always emit an array; this helper accepts both during the
 *  transition window so already-stored rows keep working. */
function normalizeGTaskCell(value: unknown): GTaskRef[] {
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

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const TASKS_STATUSES: WorkTaskStatus[] = [
  "draft",
  "awaiting_handling",
  "in_progress",
  "awaiting_clarification",
  "awaiting_approval",
  "done",
  "cancelled",
  "blocked",
];

// Open lifecycle — every status routes to every other status (minus
// self). Previously this was a hand-curated graph that rejected
// "non-canonical" moves; the team's actual workflow turned out to need
// arbitrary jumps (e.g. drag from done back to awaiting_handling), so
// the whitelist became a friction source instead of a guard. Client
// mirror in TaskStatusCell.tsx is generated the same way.
const TASKS_ALLOWED_TRANSITIONS: Record<WorkTaskStatus, WorkTaskStatus[]> = (() => {
  const base: Record<WorkTaskStatus, WorkTaskStatus[]> = Object.fromEntries(
    TASKS_STATUSES.map((from) => [
      from,
      TASKS_STATUSES.filter((to) => to !== from),
    ]),
  ) as Record<WorkTaskStatus, WorkTaskStatus[]>;
  // System-managed status overrides (phase 2, 2026-05-03):
  //   - From `blocked`: only manual transition allowed is to `cancelled`
  //     (the user can always abandon a blocked task). Every other move
  //     out of blocked must come through dependencyCascade once
  //     upstream blockers terminate.
  //   - Into `blocked`: never allowed manually. Only the chain-creation
  //     flow + dependency-cascade reverse-flow may set this status.
  base.blocked = ["cancelled"];
  for (const from of TASKS_STATUSES) {
    if (from === "blocked") continue;
    base[from] = base[from].filter((to) => to !== "blocked");
  }
  return base;
})();

const ADMIN_EMAILS = new Set([
  "maayan@fandf.co.il",
  "nadav@fandf.co.il",
  "felix@fandf.co.il",
]);

/* ── Delayed status-change notifications ──────────────────────────────
 *
 * When a task's status flips, we used to fire the email + bell ping
 * synchronously inside tasksUpdate. That made an accidental drop in
 * the kanban (drag → wrong column → drag back) immediately spam the
 * approver / author / assignees with "this is done!" / "this is
 * waiting for your approval!" emails before the user could fix it.
 *
 * Now: schedule the notifications for STATUS_NOTIFY_DELAY_MS in the
 * future, keyed by task id. If the same task gets another status
 * change inside that window, the previous schedule is cancelled and
 * a fresh one is set up. The "Drop in wrong column → drop back into
 * the right one" sequence ends with no email at all (or with the
 * RIGHT email if the second status change happens to also notify).
 *
 * Caveat: this is in-process. If the Node instance restarts inside
 * the grace window, the pending notification is dropped. Acceptable
 * tradeoff — Firebase App Hosting instances stay warm for traffic and
 * a missed notification is strictly better than a wrong one. The
 * Sheets row + the Google Tasks state-machine spawn (todo / approve /
 * clarify GTs) still happen synchronously so the source-of-truth data
 * is correct immediately; only the human-facing notify is buffered.
 */
const STATUS_NOTIFY_DELAY_MS = 30_000;
const pendingStatusNotifications = new Map<string, NodeJS.Timeout>();

function clearStatusNotify(taskId: string): void {
  const t = pendingStatusNotifications.get(taskId);
  if (t) {
    clearTimeout(t);
    pendingStatusNotifications.delete(taskId);
  }
}

function scheduleStatusNotify(
  taskId: string,
  fire: () => Promise<void>,
): void {
  clearStatusNotify(taskId);
  const timer = setTimeout(() => {
    pendingStatusNotifications.delete(taskId);
    fire().catch((e) => {
      console.log(
        "[tasksWriteDirect] delayed status notify failed:",
        e instanceof Error ? e.message : e,
      );
    });
  }, STATUS_NOTIFY_DELAY_MS);
  pendingStatusNotifications.set(taskId, timer);
}

/* ── Utilities ─────────────────────────────────────────────────────── */

function nowIso(): string {
  return new Date().toISOString();
}

function genId(): string {
  return (
    "T-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 6)
  );
}

function parseAssignees(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((x) => String(x || "").trim().toLowerCase())
      .filter((s) => s.includes("@"));
  }
  return String(raw)
    .split(/[,;\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes("@"));
}

function parseDepartments(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s).trim()).filter(Boolean);
  }
  return String(raw)
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ── Keys lookups (company resolution + access control) ────────────── */

// (Keys reads now go through `readKeysCached` from @/lib/keys, which
// dedupes via React's cache() across all callers within one request.)


async function resolveCompany(
  subjectEmail: string,
  project: string,
): Promise<string> {
  const { headers, rows } = await readKeysCached(subjectEmail);
  const iProj = headers.indexOf("פרוייקט");
  const iCo = headers.indexOf("חברה");
  if (iProj < 0 || iCo < 0) return "";
  const target = project.toLowerCase().trim();
  for (const row of rows) {
    const p = String(row[iProj] ?? "")
      .toLowerCase()
      .trim();
    if (p === target) return String(row[iCo] ?? "").trim();
  }
  return "";
}

async function assertProjectAccess(
  subjectEmail: string,
  project: string,
): Promise<void> {
  // Delegate to the shared getAccessScope (lib/tasksDirect.ts) so the
  // write gate uses the same display-name resolution and @fandf.co.il
  // domain blanket the read paths use. Without this, non-admin
  // managers (listed by name chip in cols C/D) couldn't change task
  // status on their own projects — Itay's reproduction.
  const { getAccessScope } = await import("@/lib/tasksDirect");
  const scope = await getAccessScope(subjectEmail);
  if (scope.isAdmin) return;
  if (scope.accessibleProjects.has(project)) return;
  // Confirm the project actually exists before reporting access denial,
  // so the caller can distinguish "typo" from "no access".
  const { headers, rows } = await readKeysCached(subjectEmail);
  const iProj = headers.indexOf("פרוייקט");
  const targetProject = project.toLowerCase().trim();
  for (const row of rows) {
    const p = String(row[iProj] ?? "").toLowerCase().trim();
    if (p === targetProject) {
      throw new Error("Access denied to project: " + project);
    }
  }
  throw new Error("Project not found: " + project);
}

/* ── Drive folder hierarchy ────────────────────────────────────────── */

/**
 * Task folders live inside a dedicated Shared Drive (ID in env
 * TASKS_SHARED_DRIVE_ID). The hierarchy is:
 *
 *     <Shared Drive root> / <company> / <project> / <campaign> / <task>
 *
 * — with `<campaign>` skipped when the task has no campaign set. The
 * Shared Drive's own membership settings handle access (no per-folder
 * domain-share is needed). The impersonated `DRIVE_FOLDER_OWNER` must
 * be a Content Manager on the Shared Drive for folder creation to
 * succeed.
 */
function tasksSharedDriveId(): string | null {
  return process.env.TASKS_SHARED_DRIVE_ID || null;
}

async function getOrCreateFolderInSharedDrive(
  drive: drive_v3.Drive,
  name: string,
  parentId: string,
  sharedDriveId: string,
): Promise<string> {
  const safeName = (name || "(unnamed)")
    .replace(/[\\/]/g, "-")
    .replace(/'/g, "\\'");
  const query = [
    `mimeType='application/vnd.google-apps.folder'`,
    `name='${safeName}'`,
    `'${parentId}' in parents`,
    "trashed=false",
  ].join(" and ");
  const list = await drive.files.list({
    q: query,
    fields: "files(id, name)",
    pageSize: 1,
    // Required for Shared Drive queries.
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: sharedDriveId,
  });
  const existing = list.data.files?.[0];
  if (existing?.id) return existing.id;
  const created = await drive.files.create({
    requestBody: {
      name: safeName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  if (!created.data.id) throw new Error("Drive folder create returned no id");
  return created.data.id;
}

async function createTaskFolder(
  task: {
    id: string;
    title: string;
    company: string;
    project: string;
    campaign?: string;
    /** Override for the leaf folder name. When set, a sub-folder with
     *  this name is created under the campaign folder (the user opted
     *  in to a per-task organizing folder). When empty AND a campaign
     *  is present, the campaign folder itself is used as the task's
     *  Drive folder (default UX — no leaf, no duplication). When empty
     *  AND no campaign is set, falls back to the legacy `<id> — <title>`
     *  leaf under the project so tasks without a campaign still get a
     *  unique folder. */
    folderNameOverride?: string;
  },
): Promise<{ folderId: string; folderUrl: string } | null> {
  try {
    const sharedDriveId = tasksSharedDriveId();
    if (!sharedDriveId) {
      console.log(
        "[tasksWriteDirect] TASKS_SHARED_DRIVE_ID not set — skipping Drive folder creation",
      );
      return null;
    }
    const owner = driveFolderOwner();
    const drive = driveClient(owner);

    // Walk the hierarchy from Shared Drive root down.
    let parent = sharedDriveId;
    if (task.company) {
      parent = await getOrCreateFolderInSharedDrive(
        drive,
        task.company,
        parent,
        sharedDriveId,
      );
    }
    parent = await getOrCreateFolderInSharedDrive(
      drive,
      task.project || "(no-project)",
      parent,
      sharedDriveId,
    );
    const campaign = (task.campaign || "").trim();
    let campaignFolderId = "";
    if (campaign) {
      parent = await getOrCreateFolderInSharedDrive(
        drive,
        campaign,
        parent,
        sharedDriveId,
      );
      campaignFolderId = parent;
    }

    const overrideName = (task.folderNameOverride || "").trim();
    // Default UX: no override + campaign present → use the campaign
    // folder directly. The form defaults to "use existing campaign
    // folder" mode and only sends an override name when the user
    // explicitly opted into a sub-folder.
    if (!overrideName && campaignFolderId) {
      const meta = await drive.files.get({
        fileId: campaignFolderId,
        fields: "id, webViewLink",
        supportsAllDrives: true,
      });
      return {
        folderId: campaignFolderId,
        folderUrl:
          meta.data.webViewLink ||
          `https://drive.google.com/drive/folders/${campaignFolderId}`,
      };
    }
    const leafName = overrideName
      ? overrideName.replace(/[\\/]/g, "-").slice(0, 120)
      : task.id +
        (task.title
          ? " — " + task.title.slice(0, 60).replace(/[\\/]/g, "-")
          : "");
    const created = await drive.files.create({
      requestBody: {
        name: leafName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parent],
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });
    if (!created.data.id) return null;
    return {
      folderId: created.data.id,
      folderUrl:
        created.data.webViewLink ||
        `https://drive.google.com/drive/folders/${created.data.id}`,
    };
  } catch (e) {
    console.log("[tasksWriteDirect] Drive folder create failed:", e);
    return null;
  }
}

/** HTTP codes worth retrying — quota / transient infrastructure. Anything
 *  else (404 deleted-by-user, 401 auth, 400 bad request) is permanent. */
const TRANSIENT_TASKS_CODES = new Set([429, 500, 502, 503, 504]);

/** Patch a single Google Task with bounded retry on transient codes
 *  (429 / 5xx). Three attempts with 1s/2s/4s backoff — caps total wait
 *  at ~7s, well under any cron cadence. Throws on permanent errors so
 *  the caller can decide whether to swallow or surface. Used by the
 *  status-cascade close, the assignee-removed close, and the title
 *  rename — all paths whose silent failure leaves orphan GTs that
 *  diverge from the hub state.
 */
async function patchGoogleTaskWithRetry(
  gt: GTaskRef,
  body: { status?: "completed" | "needsAction"; title?: string },
): Promise<void> {
  const tasksApi = tasksApiClient(gt.u);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await tasksApi.tasks.patch({
        tasklist: gt.l,
        task: gt.t,
        requestBody: body,
      });
      return;
    } catch (e) {
      lastError = e;
      const code =
        (e as { code?: number; response?: { status?: number } }).code ??
        (e as { response?: { status?: number } }).response?.status;
      if (typeof code !== "number" || !TRANSIENT_TASKS_CODES.has(code)) {
        throw e;
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Mark every Google Task in `googleTasks` as completed (or revive)
 * based on the new task status. The cell is a flat array of refs —
 * we patch each one. Best-effort: an assignee who deleted their entry
 * just gets skipped. Each patch retries on 429 / 5xx (see helper) so
 * a transient quota blip doesn't leave hub→done with the assignee's
 * GT still open in their tasklist.
 */
async function syncGoogleTasksStatus(
  googleTasks: GTaskRef[],
  desired: "completed" | "needsAction",
): Promise<void> {
  const entries = googleTasks || [];
  if (entries.length === 0) return;
  // Per-assignee gtasks_sync gate: if a user disabled Google Tasks
  // sync in their gear menu, leave their entry alone.
  const { getUserPrefs } = await import("@/lib/userPrefs");
  const allowedEntries = await Promise.all(
    entries.map(async (gt) => {
      try {
        const p = await getUserPrefs(gt.u);
        return p.gtasks_sync ? gt : null;
      } catch {
        return gt; // fail-open
      }
    }),
  );
  await Promise.all(
    allowedEntries.map(async (gt) => {
      if (!gt) return;
      try {
        await patchGoogleTaskWithRetry(gt, { status: desired });
      } catch (e) {
        console.log(
          `[tasksWriteDirect] Google Tasks patch (${desired}) failed for ${gt.u} after retries:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }),
  );
}

/* ── Calendar events + Google Tasks per assignee ───────────────────── */

async function createCalendarEvents(
  task: { title: string; project: string; description: string; drive_folder_url: string; requested_date: string; assignees: string[] },
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const date = task.requested_date.trim();
  if (!date) return out;
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const description =
    task.description + (task.drive_folder_url ? `\n\nקבצים: ${task.drive_folder_url}` : "");
  const body: Record<string, unknown> = {
    summary: "📋 " + task.title + " · " + task.project,
    description,
    reminders: { useDefault: true },
  };
  if (allDay) {
    const start = new Date(date + "T00:00:00Z");
    const next = new Date(start.getTime() + 24 * 3600 * 1000);
    body.start = { date };
    body.end = { date: next.toISOString().slice(0, 10) };
  } else {
    const start = new Date(date);
    body.start = { dateTime: start.toISOString() };
    body.end = { dateTime: new Date(start.getTime() + 3600 * 1000).toISOString() };
  }
  await Promise.all(
    task.assignees.map(async (email) => {
      try {
        const cal = calendarClient(email);
        const res = await cal.events.insert({
          calendarId: "primary",
          requestBody: body,
        });
        if (res.data.id) out[email] = res.data.id;
      } catch (e) {
        console.log(`[tasksWriteDirect] Calendar insert failed for ${email}:`, e);
      }
    }),
  );
  return out;
}

async function filterByGtasksPref(emails: string[]): Promise<string[]> {
  if (emails.length === 0) return [];
  const { getUserPrefs } = await import("@/lib/userPrefs");
  const out: string[] = [];
  for (const e of emails) {
    try {
      const p = await getUserPrefs(e);
      if (p.gtasks_sync) out.push(e);
    } catch {
      out.push(e); // fail-open
    }
  }
  return out;
}

/** Kind-specific title prefix shown at the top of the user's Google
 *  Tasks list. Picked to be visually distinct at a glance — assignees
 *  know they own the work, approvers know they own a decision, owners
 *  know someone needs them to clarify. */
const KIND_PREFIX: Record<GTaskKind, string> = {
  todo: "📋 לבצע",
  approve: "👀 לאישור",
  clarify: "❓ לבירור",
};

/** Override prefix for `kind=todo` when the hub task is actively in
 *  progress (status=in_progress). Pencil/tools cue tells the assignee
 *  "this is the one you're working on right now" vs. `📋 לבצע` which
 *  reads as "queued / not started yet". Switched on/off by the status
 *  cascade in tasksUpdateDirect via patchGoogleTaskTitles. */
const TODO_IN_PROGRESS_PREFIX = "🛠️ בעבודה";

function gtaskTitle(
  kind: GTaskKind,
  task: { title: string; project: string; status?: string },
  reissued = false,
): string {
  const reissue = reissued ? "🔙 " : "";
  const prefix =
    kind === "todo" && task.status === "in_progress"
      ? TODO_IN_PROGRESS_PREFIX
      : KIND_PREFIX[kind];
  return `${reissue}${prefix} · ${task.title} · ${task.project}`;
}

function gtaskNotes(
  task: {
    id: string;
    description: string;
    drive_folder_url: string;
  },
  notePrefix?: string,
): string {
  // Deep link FIRST so it's clickable from any Tasks UI without
  // expanding the notes block. Hub URL is configured per env (set in
  // apphosting.yaml as AUTH_URL=https://hub.fandf.co.il).
  const hubUrl = (process.env.AUTH_URL || "").replace(/\/+$/, "");
  const lines: string[] = [];
  if (hubUrl) lines.push(`🔗 ${hubUrl}/tasks/${encodeURIComponent(task.id)}`);
  if (notePrefix && notePrefix.trim()) lines.push("", notePrefix.trim());
  if (task.description) lines.push("", task.description);
  if (task.drive_folder_url) lines.push("", `קבצים: ${task.drive_folder_url}`);
  return lines.join("\n");
}

function gtaskDueRfc(requestedDate: string): string | undefined {
  // `requested_date` may be either "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM".
  // Google Tasks `due` only persists the date portion (the API doc is
  // explicit about that), so we strip any time and send it as midnight
  // UTC. The time-of-day stays only on the hub side for display.
  const datePart = (requestedDate || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return datePart ? new Date(datePart + "T00:00:00Z").toISOString() : undefined;
}

/**
 * Spawn one Google Task per recipient, tagged with `kind` so the poller
 * (Apps Script `pollTaskCompletions`) knows which transition to apply
 * when a recipient marks their entry done:
 *   - todo done → awaiting_approval (or done if no approver)
 *   - approve done → done
 *   - clarify done → in_progress + re-spawn todo GTs
 *
 * Recipients pass through the per-user `gtasks_sync` preference gate
 * — anyone who turned off the sync in their gear menu is skipped.
 *
 * `notePrefix` is an optional message inserted between the deep link
 * and the task description. Used by the clarify path so the author
 * sees the approver's reason inline without having to click through.
 *
 * `reissued` adds a 🔄 prefix to the title — used when re-spawning
 * todo GTs after a clarification round, so assignees can tell at a
 * glance the task was returned (not new work).
 */
export async function createGoogleTasks(
  task: {
    id: string;
    title: string;
    project: string;
    description: string;
    drive_folder_url: string;
    requested_date: string;
    /** Optional hub status — when "in_progress" and kind="todo",
     *  the title swaps from `📋 לבצע` to `🛠️ בעבודה` so the assignee
     *  visually knows this is active work, not queued. WorkTask
     *  satisfies this structurally (its `status` is non-optional). */
    status?: string;
  },
  recipients: string[],
  opts: {
    kind: GTaskKind;
    notePrefix?: string;
    reissued?: boolean;
  },
): Promise<GTaskRef[]> {
  const out: GTaskRef[] = [];
  const allowed = await filterByGtasksPref(recipients);
  if (allowed.length === 0) return out;
  const title = gtaskTitle(opts.kind, task, opts.reissued);
  const notes = gtaskNotes(task, opts.notePrefix);
  const dueRfc = gtaskDueRfc(task.requested_date);
  await Promise.all(
    allowed.map(async (email) => {
      try {
        const tasksApi = tasksApiClient(email);
        // Use the user's default (first) task list, matching
        // _getDefaultTaskListId_ in Apps Script.
        const lists = await tasksApi.tasklists.list({ maxResults: 1 });
        const listId = lists.data.items?.[0]?.id;
        if (!listId) return;
        const created = await tasksApi.tasks.insert({
          tasklist: listId,
          requestBody: { title, notes, due: dueRfc },
        });
        if (created.data.id) {
          out.push({
            u: email,
            l: listId,
            t: created.data.id,
            d: task.requested_date,
            kind: opts.kind,
          });
        }
      } catch (e) {
        console.log(
          `[tasksWriteDirect] Google Tasks insert (${opts.kind}) failed for ${email}:`,
          e,
        );
      }
    }),
  );
  return out;
}

/* ── Gmail notifications ───────────────────────────────────────────── */

/**
 * Shared Gmail send. Impersonates `authorEmail` so the "From" is a
 * real person on the team (not the service account). UTF-8 subject
 * properly base64-encoded so Hebrew lands clean.
 */
async function sendMimeMail(
  authorEmail: string,
  toEmail: string,
  subject: string,
  plainBody: string,
  htmlBody?: string,
): Promise<void> {
  try {
    const gmail = gmailClient(authorEmail);
    // RFC 2822 MIME message. Subject UTF-8-encoded so Hebrew lands clean.
    // When htmlBody is provided, send multipart/alternative so clients can
    // render the rich version with proper <a href> anchors. The plain
    // version remains as a fallback. The HTML form sidesteps the bidi
    // mangling we hit with Hebrew text + raw URL on the same line — some
    // clients auto-link the URL and grab adjacent punctuation, breaking
    // the click target.
    const headers = [
      `From: ${authorEmail}`,
      `To: ${toEmail}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`,
      "MIME-Version: 1.0",
    ];
    let mime: string;
    if (htmlBody) {
      const boundary = `=_F_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      mime = [
        ...headers,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(plainBody, "utf-8").toString("base64"),
        `--${boundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(htmlBody, "utf-8").toString("base64"),
        `--${boundary}--`,
      ].join("\r\n");
    } else {
      mime = [
        ...headers,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(plainBody, "utf-8").toString("base64"),
      ].join("\r\n");
    }
    const raw = Buffer.from(mime, "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  } catch (e) {
    console.log("[tasksWriteDirect] email send failed:", e);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the HTML body for task notification emails. Uses RTL-aware
 * inline styles, a clearly-bounded `<a>` anchor for the primary CTA,
 * and an explicit lang/dir attribute on the root so clients render
 * Hebrew correctly. Inputs are escaped — callers can pass intro as
 * pre-escaped HTML via the renderTaskEmailHtml.intro field.
 */
function renderTaskEmailHtml(opts: {
  /** Pre-escaped HTML for the intro line. */
  intro: string;
  project: string;
  title: string;
  description: string;
  requested_date: string;
  priority: number;
  primaryHref: string;
  primaryLabel: string;
  driveHref?: string;
}): string {
  const rows: string[] = [];
  rows.push(`<p style="margin:0 0 12px">${opts.intro}</p>`);
  rows.push(
    `<p style="margin:0 0 6px"><b>פרויקט:</b> ${escapeHtml(opts.project)}</p>`,
  );
  rows.push(
    `<p style="margin:0 0 6px"><b>כותרת:</b> ${escapeHtml(opts.title)}</p>`,
  );
  if (opts.description) {
    rows.push(
      `<p style="margin:8px 0 12px;white-space:pre-wrap">${escapeHtml(opts.description)}</p>`,
    );
  }
  if (opts.requested_date) {
    rows.push(
      `<p style="margin:0 0 6px"><b>תאריך מבוקש:</b> ${escapeHtml(opts.requested_date)}</p>`,
    );
  }
  if (opts.priority) {
    rows.push(
      `<p style="margin:0 0 6px"><b>דחיפות:</b> ${opts.priority}</p>`,
    );
  }
  if (opts.primaryHref) {
    rows.push(
      `<p style="margin:18px 0 8px"><a href="${escapeHtml(opts.primaryHref)}" style="display:inline-block;padding:10px 16px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">${escapeHtml(opts.primaryLabel)}</a></p>`,
    );
  }
  if (opts.driveHref) {
    rows.push(
      `<p style="margin:8px 0 0"><a href="${escapeHtml(opts.driveHref)}">📁 תיקיית קבצים</a></p>`,
    );
  }
  return [
    "<!doctype html>",
    '<html lang="he" dir="rtl"><head><meta charset="utf-8"></head>',
    '<body style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f172a">',
    rows.join("\n"),
    "</body></html>",
  ].join("");
}

async function filterByEmailPref(emails: string[]): Promise<string[]> {
  if (emails.length === 0) return [];
  const { getUserPrefs } = await import("@/lib/userPrefs");
  const out: string[] = [];
  for (const e of emails) {
    try {
      const p = await getUserPrefs(e);
      if (p.email_notifications) out.push(e);
    } catch {
      // Fail-open — if we can't read prefs, keep the recipient.
      out.push(e);
    }
  }
  return out;
}

/* ── Notification dispatch (replaces the older emailAssignees /
   emailApprover helpers — now routed through lib/notifications so
   every email also writes a row to the Notifications tab + bell
   badge). The legacy filterByEmailPref call inside each helper is
   gone too: notifyOnce reads the email_notifications pref itself,
   so the gating logic lives in one place. ─────────────────── */

function buildTaskBody(task: {
  description: string;
  requested_date: string;
  priority: number;
}): string {
  const parts: string[] = [];
  if (task.description) parts.push(task.description.slice(0, 280));
  if (task.requested_date) parts.push(`תאריך מבוקש: ${task.requested_date}`);
  if (task.priority) parts.push(`דחיפות: ${task.priority}`);
  return parts.join("\n");
}

function taskHubUrl(taskId: string): string {
  const hubUrl = (process.env.AUTH_URL || "").replace(/\/+$/, "");
  return hubUrl ? `${hubUrl}/tasks/${encodeURIComponent(taskId)}` : "";
}

async function notifyTaskAssigned(
  task: {
    id: string;
    project: string;
    title: string;
    description: string;
    requested_date: string;
    priority: number;
    assignees: string[];
  },
  actorEmail: string,
): Promise<void> {
  if (!task.assignees.length) return;
  const { notifyOnce } = await import("@/lib/notifications");
  const link = taskHubUrl(task.id);
  const body = buildTaskBody(task);
  for (const to of task.assignees) {
    await notifyOnce({
      kind: "task_assigned",
      forEmail: to,
      actorEmail,
      taskId: task.id,
      project: task.project,
      title: task.title,
      body,
      link,
    });
  }
}

async function notifyTaskUnassigned(
  task: { id: string; project: string; title: string },
  removedAssignees: string[],
  actorEmail: string,
): Promise<void> {
  if (!removedAssignees.length) return;
  const { notifyOnce } = await import("@/lib/notifications");
  const link = taskHubUrl(task.id);
  for (const to of removedAssignees) {
    await notifyOnce({
      kind: "task_unassigned",
      forEmail: to,
      actorEmail,
      taskId: task.id,
      project: task.project,
      title: task.title,
      body: "",
      link,
    });
  }
}

async function notifyTaskAwaitingApproval(
  task: {
    id: string;
    project: string;
    title: string;
    description: string;
    requested_date: string;
    priority: number;
  },
  approverEmail: string,
  actorEmail: string,
): Promise<void> {
  if (!approverEmail) return;
  const { notifyOnce } = await import("@/lib/notifications");
  await notifyOnce({
    kind: "task_awaiting_approval",
    forEmail: approverEmail,
    actorEmail,
    taskId: task.id,
    project: task.project,
    title: task.title,
    body: buildTaskBody(task),
    link: taskHubUrl(task.id),
  });
}

async function notifyTaskAudience(
  kind: "task_returned" | "task_done" | "task_cancelled",
  task: {
    id: string;
    project: string;
    title: string;
    description: string;
    requested_date: string;
    priority: number;
    author_email: string;
    assignees: string[];
  },
  actorEmail: string,
): Promise<void> {
  // Audience = the author + every current assignee. Self-mention
  // dedup happens inside notifyOnce, so the actor never gets pinged.
  const audience = new Set<string>();
  if (task.author_email) audience.add(task.author_email.toLowerCase());
  for (const e of task.assignees) audience.add(e.toLowerCase());
  if (audience.size === 0) return;
  const { notifyOnce } = await import("@/lib/notifications");
  const link = taskHubUrl(task.id);
  const body = buildTaskBody(task);
  for (const to of audience) {
    await notifyOnce({
      kind,
      forEmail: to,
      actorEmail,
      taskId: task.id,
      project: task.project,
      title: task.title,
      body,
      link,
    });
  }
}

/* ── Main create orchestrator ──────────────────────────────────────── */

export async function tasksCreateDirect(
  subjectEmail: string,
  payload: TasksCreateInput,
): Promise<{ ok: true; task: WorkTask }> {
  const project = String(payload.project || "").trim();
  if (!project) throw new Error("tasksCreate: project is required");
  await assertProjectAccess(subjectEmail, project);

  const now = nowIso();
  const id = genId();
  const assignees = parseAssignees(payload.assignees);
  const approver = String(payload.approver_email || "").toLowerCase().trim();
  const projectManager = String(payload.project_manager_email || "").toLowerCase().trim();
  const company = payload.company?.trim() || (await resolveCompany(subjectEmail, project));
  // Default entry state is awaiting_handling — the assignee has a new
  // task to do. awaiting_approval is reserved for the end-of-cycle
  // review step.
  const status = (TASKS_STATUSES as string[]).includes(String(payload.status || ""))
    ? (payload.status as WorkTaskStatus)
    : ("awaiting_handling" as WorkTaskStatus);

  const task: WorkTask = {
    id,
    brief: String(payload.brief || "").trim(),
    company,
    project,
    title: String(payload.title || "").trim(),
    description: String(payload.description || ""),
    departments: parseDepartments(payload.departments),
    kind: String(payload.kind || "other").trim(),
    priority: parseInt(String(payload.priority || "2"), 10) || 2,
    status,
    sub_status: String(payload.sub_status || "").trim(),
    author_email: subjectEmail.toLowerCase().trim(),
    approver_email: approver,
    project_manager_email: projectManager,
    assignees,
    requested_date: String(payload.requested_date || "").trim(),
    created_at: now,
    updated_at: now,
    parent_id: String(payload.parent_id || "").trim(),
    round_number: parseInt(String(payload.round_number || "1"), 10) || 1,
    drive_folder_id: "",
    drive_folder_url: "",
    chat_space_id: "",
    chat_task_name: "",
    calendar_event_ids: {},
    google_tasks: [],
    status_history: [{ at: now, by: subjectEmail, from: "", to: status, note: "created" }],
    edited_at: "",
    campaign: String(payload.campaign || "").trim(),
    // Dependencies + chains (phase 1, 2026-05-03). Defaults — chain-
    // creation flow will pass real values via payload extensions in
    // phase 5. The cells builder downstream stringifies these for the
    // sheet write.
    blocks: [],
    blocked_by: [],
    umbrella_id: String(payload.umbrella_id || "").trim(),
    is_umbrella: payload.is_umbrella === true || payload.is_umbrella === "true",
  };

  // Side effects — run in parallel where safe.
  //
  // Drive folder:
  //   - If the caller pinned `drive_folder_id` (folder picker "existing"
  //     mode), reuse it — just fetch its webViewLink so we can persist
  //     a stable URL alongside the ID.
  //   - Otherwise create a new folder. `drive_folder_name` overrides the
  //     auto-generated `<task-id> — <title>` leaf name.
  const pinnedFolderId = String(payload.drive_folder_id || "").trim();
  if (pinnedFolderId) {
    try {
      const { getFolderRef } = await import("@/lib/driveFolders");
      const ref = await getFolderRef(subjectEmail, pinnedFolderId);
      task.drive_folder_id = ref.id;
      task.drive_folder_url = ref.viewUrl;
    } catch (e) {
      console.log(
        "[tasksWriteDirect] Pinned folder lookup failed, continuing with empty Drive fields:",
        e,
      );
    }
  } else {
    const folder = await createTaskFolder({
      id: task.id,
      title: task.title,
      company: task.company,
      project: task.project,
      campaign: task.campaign,
      folderNameOverride: String(payload.drive_folder_name || "").trim(),
    });
    if (folder) {
      task.drive_folder_id = folder.folderId;
      task.drive_folder_url = folder.folderUrl;
    }
  }
  // Calendar events were creating noise on every assignee's calendar
  // when the Google Tasks due-date already covers the same need with
  // less clutter. Calendar code stays in `createCalendarEvents` for
  // possible revival but is no longer called on create.
  const gt = await createGoogleTasks(
    {
      id: task.id,
      title: task.title,
      project: task.project,
      description: task.description,
      drive_folder_url: task.drive_folder_url,
      requested_date: task.requested_date,
    },
    assignees,
    { kind: "todo" },
  );
  task.calendar_event_ids = {};
  task.google_tasks = gt;

  // Persist to the Comments sheet. We need the header row order to
  // write cells in the right positions (schema auto-migrated).
  const sheets = sheetsClient(subjectEmail);
  const commentsSsId = envOrThrow("SHEET_ID_COMMENTS");
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: commentsSsId,
    range: "Comments!1:1",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const headerRow = ((headerRes.data.values?.[0] ?? []) as unknown[]).map((h) =>
    String(h ?? "").trim(),
  );

  // Default rank for a new task: enter at the TOP of its status bucket.
  // We derive a value smaller than any current rank in the same status
  // (negative timestamps mean smaller = newer); the explicit drag-and-
  // drop UI overrides this once the user repositions the card.
  const newTaskRank = -Date.parse(now);

  const cells: Record<string, unknown> = {
    id: task.id,
    timestamp: now,
    project: task.project,
    anchor: "general",
    author_email: task.author_email,
    author_name: task.author_email.split("@")[0],
    parent_id: task.parent_id,
    body: task.description,
    resolved: false,
    mentions: assignees.join(","),
    google_tasks: JSON.stringify(task.google_tasks),
    edited_at: "",
    row_kind: "task",
    kind: task.kind,
    title: task.title,
    brief: task.brief,
    company: task.company,
    departments: JSON.stringify(task.departments),
    priority: task.priority,
    status: task.status,
    sub_status: task.sub_status,
    approver_email: task.approver_email,
    project_manager_email: task.project_manager_email,
    requested_date: task.requested_date,
    round_number: task.round_number,
    revision_of: "",
    drive_folder_id: task.drive_folder_id,
    drive_folder_url: task.drive_folder_url,
    chat_space_id: "",
    chat_task_name: "",
    calendar_event_ids: JSON.stringify(task.calendar_event_ids),
    status_history: JSON.stringify(task.status_history),
    updated_at: task.updated_at,
    campaign: task.campaign || "",
    rank: newTaskRank,
    // Dependencies + chains (phase 1, 2026-05-03). Defaults emit empty
    // arrays / "" / FALSE for plain tasks; chain-creation flow (phase 5)
    // will pass real values through `task.blocks`/`task.blocked_by`/
    // `task.umbrella_id`/`task.is_umbrella`. Headers added by
    // scripts/add-dependency-headers.mjs — if those columns aren't on
    // the live sheet yet, the headerRow.map below silently drops these
    // keys (no error), making the rollout safe in either order.
    blocks: JSON.stringify(task.blocks ?? []),
    blocked_by: JSON.stringify(task.blocked_by ?? []),
    umbrella_id: task.umbrella_id ?? "",
    is_umbrella: task.is_umbrella ? "TRUE" : "FALSE",
  };
  // Reflect rank back on the in-memory task so callers see it.
  task.rank = newTaskRank;
  // Defensive guard: never write a task row with an empty id. Failure
  // mode otherwise: row exists but `/tasks/<id>` 404s, the row is
  // invisible in every list view (filtered by id), and pollTasks's
  // reconciliation skips it (`if (!taskId) continue`). The 2026-05-03
  // sweep caught one such row already; this guard prevents a future
  // upstream id-generation bug from producing more.
  if (!String(cells.id ?? "").trim()) {
    throw new Error("createTask: refusing to write row with empty id");
  }
  const row = headerRow.map((h) => (h in cells ? cells[h] : ""));
  await sheets.spreadsheets.values.append({
    spreadsheetId: commentsSsId,
    range: "Comments",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row as unknown[]] },
  });

  // "Convert comment to task" — Flavor C migration. Re-parent the
  // source comment + every direct reply to the new task id, so the
  // entire conversation moves under the task verbatim. Best-effort:
  // a migration error is logged but doesn't fail the create (the task
  // already exists; user can re-trigger or manually move replies).
  const sourceCommentId = String(payload.from_comment || "").trim();
  if (sourceCommentId) {
    try {
      const { migrateCommentThreadDirect } = await import("@/lib/commentsDirect");
      await migrateCommentThreadDirect(subjectEmail, sourceCommentId, task.id);
    } catch (e) {
      console.log(
        "[tasksWriteDirect] migrateCommentThread failed:",
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // After-write notifications (non-fatal). On create we ping the
  // assignees ("you have a new task") via the unified notifyOnce
  // pipeline — same dispatch writes a Notifications row + sends
  // email when the recipient hasn't muted it. Approver gets a
  // separate notification later when status flips to awaiting_approval.
  await notifyTaskAssigned(
    {
      id: task.id,
      project: task.project,
      title: task.title,
      description: task.description,
      requested_date: task.requested_date,
      priority: task.priority,
      assignees: task.assignees,
    },
    task.author_email,
  );

  return { ok: true, task };
}

/* ── Main update orchestrator ──────────────────────────────────────── */

/* Per-task serialization queue.
 *
 * Concurrent transitions on the same hub task race when each one does:
 *   1. read row's google_tasks cell
 *   2. close every ref in cell
 *   3. spawn the next-stage GT
 *   4. write merged cell
 * If T1 and T2 land within the same Sheets read+write window, T2 reads
 * the pre-T1 cell, T1's spawned GT ref never reaches T2's write, and
 * the GT is open with no row-side ref to track it. Yesterday's stress-
 * test produced 29 such orphans on a single task.
 *
 * The mutex chains awaitable promises per taskId so the read-modify-
 * write cycle is atomic from this Node process's view. Cross-container
 * races can still occur on Firebase App Hosting (multiple instances),
 * but burst kanban drops from one user almost always hit the same
 * warm container. Combined with the additive array merge below, this
 * makes the GT cell tamper-proof in the common case.
 *
 * The lock is best-effort — we always clear our slot in `finally` so a
 * thrown exception inside one transition can't permanently block the
 * task. */
const taskUpdateLocks = new Map<string, Promise<unknown>>();

async function withTaskLock<T>(
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = taskUpdateLocks.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const ourSlot: Promise<void> = new Promise((res) => {
    release = res;
  });
  // Chain: the next caller's prior is our slot, so they wait for us.
  const chained: Promise<void> = prior.then(() => ourSlot, () => ourSlot);
  taskUpdateLocks.set(taskId, chained);
  try {
    await prior.catch(() => {}); // prior errors are not ours to inherit
    return await fn();
  } finally {
    release();
    // If no later caller chained behind us, drop the entry so the map
    // doesn't grow unbounded across the lifetime of the process.
    if (taskUpdateLocks.get(taskId) === chained) {
      taskUpdateLocks.delete(taskId);
    }
  }
}

export async function tasksUpdateDirect(
  subjectEmail: string,
  taskId: string,
  patch: TasksUpdatePatch,
): Promise<{ ok: true; task: WorkTask; changed: boolean }> {
  return withTaskLock(taskId, () =>
    tasksUpdateDirectInner(subjectEmail, taskId, patch),
  );
}

async function tasksUpdateDirectInner(
  subjectEmail: string,
  taskId: string,
  patch: TasksUpdatePatch,
): Promise<{ ok: true; task: WorkTask; changed: boolean }> {
  // Read the whole Comments sheet once; we need header idx + the task row.
  const sheets = sheetsClient(subjectEmail);
  const commentsSsId = envOrThrow("SHEET_ID_COMMENTS");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: commentsSsId,
    range: "Comments",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (values.length < 2) throw new Error("Task not found: " + taskId);
  const headers = (values[0] as unknown[]).map((h) => String(h ?? "").trim());
  const idx = new Map<string, number>();
  headers.forEach((h, i) => {
    if (h) idx.set(h, i);
  });
  const idCol = idx.get("id");
  const rowKindCol = idx.get("row_kind");
  if (idCol == null || rowKindCol == null) throw new Error("Task not found: " + taskId);

  let rowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol] ?? "") !== taskId) continue;
    if (String(values[i][rowKindCol] ?? "").trim() !== "task") continue;
    rowIndex = i; // 0-based inside values; actual row in sheet is i+1
    break;
  }
  if (rowIndex < 0) throw new Error("Task not found: " + taskId);
  const rowVals = values[rowIndex];

  const cell = (k: string): unknown => {
    const i = idx.get(k);
    return i == null ? "" : rowVals[i];
  };
  const currentStatus = String(cell("status") ?? "awaiting_approval") as WorkTaskStatus;
  const project = String(cell("project") ?? "");

  const isAdmin = ADMIN_EMAILS.has(subjectEmail.toLowerCase().trim());
  if (!isAdmin) await assertProjectAccess(subjectEmail, project);

  // Build the changes map, keyed by Comments column names. Special
  // mapping: description → body, assignees → mentions, status → also
  // sync `resolved`. Mirrors Apps Script tasksUpdateForUser_.
  const changes: Record<string, unknown> = {};
  const now = nowIso();

  if (patch.status && patch.status !== currentStatus) {
    const allowed = TASKS_ALLOWED_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(patch.status) && !isAdmin) {
      throw new Error(
        "Transition not allowed: " + currentStatus + " → " + patch.status,
      );
    }
    changes.status = patch.status;
    changes.resolved = patch.status === "done";
    // Auto-clear the legacy `sub_status` modifier on any real status
    // transition — otherwise a stale value like "אושר" (set when the
    // task was at a different status) follows the task around and
    // confuses the pill. If the caller is intentionally setting a new
    // sub_status in the same patch, the SIMPLE_DIRECT loop below will
    // overwrite this clear with the new value.
    changes.sub_status = "";
    // Append to status_history.
    const existingHist = (() => {
      try {
        return JSON.parse(String(cell("status_history") ?? "[]"));
      } catch {
        return [];
      }
    })();
    existingHist.push({
      at: now,
      by: subjectEmail,
      from: currentStatus,
      to: patch.status,
      note: patch.note || "",
    });
    changes.status_history = JSON.stringify(existingHist);
  }

  const SIMPLE_DIRECT = [
    "title",
    "kind",
    "priority",
    "approver_email",
    "project_manager_email",
    "requested_date",
    "brief",
    "company",
    "sub_status",
    "campaign",
    "rank",
  ] as const;
  for (const k of SIMPLE_DIRECT) {
    if (k in patch && patch[k] !== cell(k)) {
      changes[k] = patch[k];
    }
  }

  if ("description" in patch && patch.description !== cell("body")) {
    changes.body = patch.description;
  }

  // Track if assignees changed so the after-write block can email
  // newcomers (we only know the merged set after side-effect work).
  let assigneeAdded: string[] = [];
  let assigneeRemoved: string[] = [];
  if ("assignees" in patch) {
    const newAssignees = parseAssignees(patch.assignees);
    const currentAssignees = String(cell("mentions") ?? "")
      .split(/[,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (newAssignees.join(",") !== currentAssignees.join(",")) {
      changes.mentions = newAssignees.join(",");

      // Diff the lists and sync each side's Google Tasks list:
      //   - removed: mark their entry completed (gentler than delete —
      //     keeps history visible) and drop from `google_tasks`.
      //   - added: create a fresh Google Task on their list and append.
      // Without this, removed assignees keep an orphan that can fire
      // the reverse-direction poller into transitioning the hub task
      // to done if they tick it off — a real correctness bug, not just
      // a tidiness issue.
      assigneeRemoved = currentAssignees.filter((e) => !newAssignees.includes(e));
      assigneeAdded = newAssignees.filter((e) => !currentAssignees.includes(e));

      const currentGT: GTaskRef[] = normalizeGTaskCell(cell("google_tasks"));

      // Walk the array and split into "keep" (assignee still on the
      // task) vs "close" (assignee removed). Closing patches their
      // GT to completed; the ref is then dropped from the cell.
      // Refs whose `u` is not in either set (e.g. the approver / clarify
      // owner from prior status rounds) are kept untouched — they're
      // not assignee-bound and the status cascade owns their lifecycle.
      const removedSet = new Set(assigneeRemoved);
      const cleanedGT: GTaskRef[] = [];
      for (const ref of currentGT) {
        const email = String(ref.u || "").toLowerCase();
        if (removedSet.has(email) && (ref.kind ?? "todo") === "todo") {
          try {
            await patchGoogleTaskWithRetry(ref, { status: "completed" });
          } catch (e) {
            console.log(
              `[tasksWriteDirect] could not complete removed assignee's Google Task (${email}) after retries:`,
              e instanceof Error ? e.message : String(e),
            );
          }
          continue; // drop the ref — assignee no longer on task
        }
        cleanedGT.push(ref);
      }

      // Create Google Tasks for newly-added assignees. Pull title /
      // description / requested_date / drive_folder_url from the
      // post-patch view so reassign-and-rename in one save lands the
      // new entry with the new metadata.
      if (assigneeAdded.length > 0) {
        const mergedTitle = String(changes.title ?? cell("title") ?? "");
        const mergedDescription = String(changes.body ?? cell("body") ?? "");
        const mergedRequestedDate = String(
          changes.requested_date ?? cell("requested_date") ?? "",
        );
        const mergedProject = String(cell("project") ?? "");
        const driveUrl = String(cell("drive_folder_url") ?? "");
        try {
          const fresh = await createGoogleTasks(
            {
              id: taskId,
              title: mergedTitle,
              project: mergedProject,
              description: mergedDescription,
              drive_folder_url: driveUrl,
              requested_date: mergedRequestedDate,
            },
            assigneeAdded,
            { kind: "todo" },
          );
          cleanedGT.push(...fresh);
        } catch (e) {
          console.log(
            "[tasksWriteDirect] createGoogleTasks for added assignees failed:",
            e instanceof Error ? e.message : String(e),
          );
        }
      }

      changes.google_tasks = JSON.stringify(cleanedGT);

      // Append a status_history entry noting the reassignment so the
      // audit log captures who joined / left the task.
      const histRaw = String(cell("status_history") ?? "[]");
      let hist: WorkTask["status_history"];
      try {
        hist = JSON.parse(histRaw);
        if (!Array.isArray(hist)) hist = [];
      } catch {
        hist = [];
      }
      // If the same patch already pushed a status-change entry, splice
      // ours in alongside so both events show up in order.
      if (changes.status_history) {
        try {
          hist = JSON.parse(String(changes.status_history));
          if (!Array.isArray(hist)) hist = [];
        } catch {
          hist = [];
        }
      }
      const noteParts: string[] = [];
      if (assigneeRemoved.length) {
        noteParts.push(
          "removed: " + assigneeRemoved.map((e) => e.split("@")[0]).join(", "),
        );
      }
      if (assigneeAdded.length) {
        noteParts.push(
          "added: " + assigneeAdded.map((e) => e.split("@")[0]).join(", "),
        );
      }
      hist.push({
        at: now,
        by: subjectEmail,
        from: "",
        to: "",
        note: "reassigned · " + noteParts.join(" · "),
      });
      changes.status_history = JSON.stringify(hist);
    }
  }

  if ("departments" in patch) {
    const newDepts = parseDepartments(patch.departments);
    const currentDepts = (() => {
      try {
        return JSON.parse(String(cell("departments") ?? "[]"));
      } catch {
        return [];
      }
    })();
    if (newDepts.join(",") !== (currentDepts as string[]).join(",")) {
      changes.departments = JSON.stringify(newDepts);
    }
  }

  // Re-point Drive folder. Lookup the new folder's webViewLink so the
  // stored URL stays in sync with the ID. A lookup failure doesn't block
  // the rest of the patch — we just leave the URL blank and log.
  if ("drive_folder_id" in patch) {
    const nextId = String(patch.drive_folder_id || "").trim();
    const currentId = String(cell("drive_folder_id") ?? "").trim();
    if (nextId && nextId !== currentId) {
      try {
        const { getFolderRef } = await import("@/lib/driveFolders");
        const ref = await getFolderRef(subjectEmail, nextId);
        changes.drive_folder_id = ref.id;
        changes.drive_folder_url = ref.viewUrl;
      } catch (e) {
        console.log(
          "[tasksWriteDirect] Re-point folder lookup failed:",
          e,
        );
        changes.drive_folder_id = nextId;
        changes.drive_folder_url = "";
      }
    }
  }

  const changedKeys = Object.keys(changes);
  if (!changedKeys.length) {
    // Reuse the existing row as the return shape.
    return { ok: true, task: rowToTask(rowVals, idx), changed: false };
  }
  changes.updated_at = now;
  if (patch.title || patch.description) changes.edited_at = now;

  // Build a single batchUpdate for all changed cells.
  //
  // rowIndex is 0-based inside values[] where values[0] IS the header row.
  // So sheet row number = rowIndex + 1 (values[0]=row 1, values[1]=row 2, …).
  //
  // The previous code double-counted — adding +1 for "0-based index" AND
  // again for "header row 1" — which wrote every update to the row BELOW
  // the intended task. That's why transitions appeared to silently no-op:
  // the API returned success (with the next row's data re-read), but the
  // task's actual row was never touched. User-visible symptom: "page
  // refreshes but nothing happens".
  const sheetRow = rowIndex + 1;
  const data: Array<{ range: string; values: (string | number | boolean)[][] }> = [];
  for (const [k, v] of Object.entries(changes)) {
    const colIdx = idx.get(k);
    if (colIdx == null) continue;
    // Defensive guard: never let a patch wipe column A (id) on a task
    // row. The patch shape doesn't expose `id` today, but a future
    // refactor that accidentally threads an empty id through would
    // produce the exact bug surfaced by the 2026-05-03 audit (row 117).
    // The check is on `k === "id"` because that's the canonical
    // header name; column-A index isn't necessarily 0 if the sheet
    // schema ever changes.
    if (k === "id" && !String(v ?? "").trim()) {
      throw new Error(
        `tasksUpdateDirect: refusing to write empty id to row ${sheetRow}`,
      );
    }
    const col = columnLetter(colIdx + 1);
    data.push({
      range: `Comments!${col}${sheetRow}`,
      values: [[v as string | number | boolean]],
    });
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: commentsSsId,
    requestBody: { valueInputOption: "RAW", data },
  });

  // Re-read the row so the return shape reflects the merged result.
  const reread = await sheets.spreadsheets.values.get({
    spreadsheetId: commentsSsId,
    range: `Comments!A${sheetRow}:${columnLetter(headers.length)}${sheetRow}`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const freshRow = (reread.data.values?.[0] ?? []) as unknown[];

  // Status-change notifications. Routed through the unified notifyOnce
  // pipeline so each kind writes a Notifications row + sends email
  // (gated by the recipient's email_notifications pref). Audience for
  // returned/done/cancelled is author + current assignees.
  //
  // DELAYED FAN-OUT: each notify is scheduled STATUS_NOTIFY_DELAY_MS
  // in the future and cancelled if another status change lands inside
  // that window. Lets users undo accidental kanban drops without
  // spamming the approver / author. The Sheets row + Google Tasks
  // state-machine spawn (above) still happen synchronously — only
  // the email/bell ping is buffered.
  if (changes.status) {
    const fresh = rowToTask(freshRow, idx);
    const previousStatus = String(cell("status") ?? "");
    // Always cancel any pending notify for this task — even if the
    // current transition itself doesn't trigger one (e.g. drop back
    // into the original column), we want to drop the old pending
    // ping that was queued by the FIRST drop.
    clearStatusNotify(fresh.id);
    if (changes.status === "awaiting_approval") {
      scheduleStatusNotify(fresh.id, () =>
        notifyTaskAwaitingApproval(
          {
            id: fresh.id,
            project: fresh.project,
            title: fresh.title,
            description: fresh.description,
            requested_date: fresh.requested_date,
            priority: fresh.priority,
          },
          fresh.approver_email,
          subjectEmail,
        ),
      );
    } else if (
      previousStatus === "awaiting_approval" &&
      (changes.status === "in_progress" ||
        changes.status === "awaiting_handling" ||
        changes.status === "awaiting_clarification")
    ) {
      // Approver bounced the work back — author + assignees should know.
      scheduleStatusNotify(fresh.id, () =>
        notifyTaskAudience("task_returned", fresh, subjectEmail),
      );
    } else if (changes.status === "done") {
      scheduleStatusNotify(fresh.id, () =>
        notifyTaskAudience("task_done", fresh, subjectEmail),
      );
    } else if (changes.status === "cancelled") {
      scheduleStatusNotify(fresh.id, () =>
        notifyTaskAudience("task_cancelled", fresh, subjectEmail),
      );
    }
  }

  // Reassignment notifications. New assignees → task_assigned;
  // removed assignees → task_unassigned. Both go through notifyOnce
  // and write a Notifications row in addition to the email.
  if (assigneeAdded.length > 0) {
    const fresh = rowToTask(freshRow, idx);
    await notifyTaskAssigned(
      {
        id: fresh.id,
        project: fresh.project,
        title: fresh.title,
        description: fresh.description,
        requested_date: fresh.requested_date,
        priority: fresh.priority,
        assignees: assigneeAdded,
      },
      subjectEmail,
    );
  }
  if (assigneeRemoved.length > 0) {
    const fresh = rowToTask(freshRow, idx);
    await notifyTaskUnassigned(
      { id: fresh.id, project: fresh.project, title: fresh.title },
      assigneeRemoved,
      subjectEmail,
    );
  }

  // Keep each recipient's personal Google Tasks list in sync with the
  // hub status. The state machine drives THREE distinct GT lifecycles
  // per task — todo (assignees), approve (approver), clarify (owner) —
  // and a status transition usually retires one set + spawns the next.
  if (changes.status) {
    const fresh = rowToTask(freshRow, idx);
    const previousStatus = String(cell("status") ?? "");
    const newStatus = changes.status as WorkTaskStatus;

    if (newStatus === "done" || newStatus === "cancelled") {
      // Terminal — close every open GT regardless of kind.
      await syncGoogleTasksStatus(fresh.google_tasks, "completed");
    } else if (newStatus === "awaiting_approval") {
      // Hand off to approver. Close assignees' todo entries and spawn
      // a `kind=approve` GT for the approver. No-approver fallback:
      // the poller treats a `kind=todo` completion as `done` directly,
      // so we just leave the todo entries open here and let the assignee's
      // tick-to-done flow apply (a hub-side transition straight into
      // awaiting_approval without an approver_email shouldn't normally
      // happen — it'd flip back through done on the next poll).
      await syncGoogleTasksStatus(fresh.google_tasks, "completed");
      if (fresh.approver_email) {
        const approveGT = await createGoogleTasks(
          fresh,
          [fresh.approver_email],
          { kind: "approve" },
        );
        if (approveGT.length > 0) {
          const merged: GTaskRef[] = [...fresh.google_tasks, ...approveGT];
          await persistGoogleTasksCell(
            sheets,
            commentsSsId,
            idx,
            rowIndex,
            merged,
          );
        }
      }
    } else if (newStatus === "awaiting_clarification") {
      // Bounce to assignment owner. Close every open GT and spawn one
      // `kind=clarify` GT for the author (or PM as fallback). The
      // status-transition note from the approver becomes the body
      // prefix so the owner sees the question inline in their Tasks.
      await syncGoogleTasksStatus(fresh.google_tasks, "completed");
      const owner = fresh.author_email || fresh.project_manager_email;
      if (owner) {
        const clarifyGT = await createGoogleTasks(
          fresh,
          [owner],
          {
            kind: "clarify",
            notePrefix: patch.note
              ? `הערת מאשר: ${patch.note}`
              : "",
          },
        );
        if (clarifyGT.length > 0) {
          const merged: GTaskRef[] = [...fresh.google_tasks, ...clarifyGT];
          await persistGoogleTasksCell(
            sheets,
            commentsSsId,
            idx,
            rowIndex,
            merged,
          );
        }
      }
    } else if (
      (newStatus === "in_progress" || newStatus === "awaiting_handling") &&
      (previousStatus === "awaiting_approval" ||
        previousStatus === "awaiting_clarification")
    ) {
      // Returned-to-work bounce. Either the approver rejected back to
      // in_progress, or the owner finished clarifying. Close the
      // approve/clarify entries that fired this and re-spawn a fresh
      // round of `kind=todo` GTs for assignees with the 🔙 marker so
      // they can tell at a glance the task came back, not new work.
      // The freshly-spawned titles inherit the status-aware prefix
      // automatically (`🛠️ בעבודה` when newStatus=in_progress, `📋 לבצע`
      // when newStatus=awaiting_handling) — see gtaskTitle.
      await syncGoogleTasksStatus(fresh.google_tasks, "completed");
      if (fresh.assignees.length > 0) {
        const reissued = await createGoogleTasks(
          fresh,
          fresh.assignees,
          { kind: "todo", reissued: true },
        );
        if (reissued.length > 0) {
          const merged: GTaskRef[] = [...fresh.google_tasks, ...reissued];
          await persistGoogleTasksCell(
            sheets,
            commentsSsId,
            idx,
            rowIndex,
            merged,
          );
        }
      }
    } else if (
      newStatus === "in_progress" ||
      newStatus === "awaiting_handling"
    ) {
      // Generic revive (awaiting_handling ↔ in_progress, or revival
      // from done / cancelled / draft into a working state) — reopen
      // whatever's there. Then refresh titles so the kind=todo
      // entries' prefix reflects the new status: `📋 לבצע` for
      // awaiting_handling, `🛠️ בעבודה` for in_progress. The patch is
      // a no-op for entries whose title is already correct, and
      // best-effort skipped for deleted entries via the same
      // patchGoogleTaskWithRetry helper.
      await syncGoogleTasksStatus(fresh.google_tasks, "needsAction");
      await patchGoogleTaskTitles(fresh);
    }
  }

  // Dependency cascade — when this transition reached a terminal
  // status (`done` or `cancelled`), unblock every downstream task
  // whose remaining `blocked_by` references are now all terminal.
  // Fires AFTER the GT-sync block above so the user-facing status
  // landed first; cascade failures are best-effort and don't bubble.
  // Phase 2 of dependencies feature, 2026-05-03 — see
  // memory/project_dependencies_chains_pending.md.
  //
  // Note: the cascade does NOT spawn personal Google Tasks for the
  // newly-unblocked downstream assignees. That's phase 3's job
  // (GT sync rework — defer spawn until task is ready). Until phase 3
  // ships, the unblocked task's row updates but its assignee won't
  // get a fresh GT until phase 3 is wired.
  if (
    changes.status &&
    (changes.status === "done" || changes.status === "cancelled")
  ) {
    try {
      const { cascadeAfterTerminal } = await import("@/lib/dependencyCascade");
      const cascade = await cascadeAfterTerminal({
        // Use the same subject the parent transition ran under — DWD
        // gives them Sheets-write on Comments, no privilege bump needed.
        // The cascade attribution in status_history is "system" rather
        // than the subject email (it's an automatic effect, not the
        // user's edit on the downstream row).
        subjectEmail,
        completedTaskId: taskId,
        upstreamFinalStatus: changes.status as WorkTaskStatus,
        nowIso: now,
        commentsSpreadsheetId: commentsSsId,
      });
      if (cascade.unblocked.length > 0) {
        console.log(
          `[tasksWriteDirect] cascade after ${taskId} → ${changes.status}: unblocked ${cascade.unblocked.length} downstream (${cascade.unblocked.map((u) => u.taskId).join(", ")})`,
        );
      }
      if (cascade.errors.length > 0) {
        console.log(
          `[tasksWriteDirect] cascade errors for ${taskId}:`,
          cascade.errors.join("; "),
        );
      }
    } catch (e) {
      console.log(
        `[tasksWriteDirect] cascade threw for ${taskId}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // Hub-side title rename → patch every open GT's title so assignees /
  // approvers see the renamed task in their personal lists. Preserves
  // the kind prefix and drops the reissued marker (it's stale post-
  // rename). Best-effort: a deleted GT is silently skipped.
  if (changes.title) {
    const fresh = rowToTask(freshRow, idx);
    await patchGoogleTaskTitles(fresh);
  }

  return { ok: true, task: rowToTask(freshRow, idx), changed: true };
}

/** Persist the merged `google_tasks` JSON back to the sheet cell.
 *  Used after a status transition spawns new GTs and we need to
 *  union them into the existing map. Single targeted update —
 *  cheaper than a full row rewrite. */
export async function persistGoogleTasksCell(
  sheets: ReturnType<typeof sheetsClient>,
  commentsSsId: string,
  headerIdx: Map<string, number>,
  rowIndex: number,
  googleTasks: GTaskRef[],
): Promise<void> {
  const colIdx = headerIdx.get("google_tasks");
  if (colIdx == null) return;
  const sheetRow = rowIndex + 1;
  const colA1 = columnLetter(colIdx + 1);
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: commentsSsId,
      range: `Comments!${colA1}${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [[JSON.stringify(googleTasks)]] },
    });
  } catch (e) {
    console.log(
      "[tasksWriteDirect] persistGoogleTasksCell failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Patch every open Google Task's title to reflect the task's current
 *  hub-side title. Re-derives the title from kind+title+project so the
 *  prefix stays consistent with whatever spawned the GT. */
async function patchGoogleTaskTitles(task: WorkTask): Promise<void> {
  const entries = task.google_tasks || [];
  if (entries.length === 0) return;
  await Promise.all(
    entries.map(async (gt) => {
      try {
        const kind = gt.kind || "todo";
        await patchGoogleTaskWithRetry(gt, {
          title: gtaskTitle(kind, task, /* reissued */ false),
        });
      } catch (e) {
        console.log(
          `[tasksWriteDirect] GT title patch failed for ${gt.u} after retries:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }),
  );
}

/* ── Row → WorkTask mapper (local copy of lib/tasksDirect helper) ─── */

function rowToTask(row: unknown[], idx: Map<string, number>): WorkTask {
  const cell = (k: string): unknown => {
    const i = idx.get(k);
    return i == null ? "" : row[i];
  };
  const createdAtRaw = cell("timestamp");
  const createdAt =
    createdAtRaw instanceof Date
      ? createdAtRaw.toISOString()
      : String(createdAtRaw ?? "");
  const parseJsonField = (k: string, array: boolean): unknown => {
    const v = cell(k);
    if (!v) return array ? [] : {};
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return array ? [] : {};
    }
  };
  const assignees = String(cell("mentions") ?? "")
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // Rank fallback — if the sheet has no `rank` column yet (or this row
  // hasn't been ranked), derive a default from `created_at`. Newer
  // tasks get a smaller number so they sort to the top by default,
  // matching the previous chronological behavior. Once a user drags
  // anything, the explicit rank takes over for that row.
  const rankRaw = cell("rank");
  const parsedRank =
    rankRaw === "" || rankRaw == null ? NaN : parseFloat(String(rankRaw));
  const fallbackRank = (() => {
    const ms = Date.parse(String(createdAtRaw ?? ""));
    if (!Number.isFinite(ms)) return Number.MAX_SAFE_INTEGER / 2;
    // Negate so newer (larger ms) becomes smaller (sorts first).
    return -ms;
  })();
  return {
    id: String(cell("id") ?? ""),
    brief: String(cell("brief") ?? ""),
    company: String(cell("company") ?? ""),
    project: String(cell("project") ?? ""),
    title: String(cell("title") ?? ""),
    description: String(cell("body") ?? ""),
    departments: parseJsonField("departments", true) as string[],
    kind: String(cell("kind") ?? "other"),
    priority: parseInt(String(cell("priority") ?? "2"), 10) || 2,
    status: String(cell("status") ?? "awaiting_approval") as WorkTaskStatus,
    sub_status: String(cell("sub_status") ?? ""),
    author_email: String(cell("author_email") ?? "").toLowerCase(),
    approver_email: String(cell("approver_email") ?? "").toLowerCase(),
    project_manager_email: String(cell("project_manager_email") ?? "").toLowerCase(),
    assignees,
    requested_date: String(cell("requested_date") ?? ""),
    created_at: createdAt,
    updated_at: String(cell("updated_at") ?? ""),
    parent_id: String(cell("parent_id") ?? ""),
    round_number: parseInt(String(cell("round_number") ?? "1"), 10) || 1,
    drive_folder_id: String(cell("drive_folder_id") ?? ""),
    drive_folder_url: String(cell("drive_folder_url") ?? ""),
    chat_space_id: String(cell("chat_space_id") ?? ""),
    chat_task_name: String(cell("chat_task_name") ?? ""),
    calendar_event_ids: parseJsonField("calendar_event_ids", false) as Record<string, string>,
    google_tasks: normalizeGTaskCell(cell("google_tasks")),
    status_history: parseJsonField("status_history", true) as WorkTask["status_history"],
    edited_at: String(cell("edited_at") ?? ""),
    campaign: String(cell("campaign") ?? ""),
    rank: Number.isFinite(parsedRank) ? parsedRank : fallbackRank,
    // Dependencies + chains (phase 1, 2026-05-03). Mirrors the parser
    // in lib/tasksDirect.ts rowToTask — keep these two in sync.
    blocks: parseJsonField("blocks", true) as string[],
    blocked_by: parseJsonField("blocked_by", true) as string[],
    umbrella_id: String(cell("umbrella_id") ?? ""),
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

function columnLetter(colNumber: number): string {
  // 1 -> A, 2 -> B, ..., 27 -> AA
  let n = colNumber;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
