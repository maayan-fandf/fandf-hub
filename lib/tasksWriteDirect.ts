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
import type {
  TasksCreateInput,
  TasksUpdatePatch,
  WorkTask,
  WorkTaskStatus,
} from "@/lib/appsScript";

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
];

// Open lifecycle — every status routes to every other status (minus
// self). Previously this was a hand-curated graph that rejected
// "non-canonical" moves; the team's actual workflow turned out to need
// arbitrary jumps (e.g. drag from done back to awaiting_handling), so
// the whitelist became a friction source instead of a guard. Client
// mirror in TaskStatusCell.tsx is generated the same way.
const TASKS_ALLOWED_TRANSITIONS: Record<WorkTaskStatus, WorkTaskStatus[]> =
  Object.fromEntries(
    TASKS_STATUSES.map((from) => [
      from,
      TASKS_STATUSES.filter((to) => to !== from),
    ]),
  ) as Record<WorkTaskStatus, WorkTaskStatus[]>;

const ADMIN_EMAILS = new Set([
  "maayan@fandf.co.il",
  "nadav@fandf.co.il",
  "felix@fandf.co.il",
]);

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

const KEYS_HEADER_NORMALIZE = /[\u200B-\u200F\u202A-\u202E\u2060\u00AD\uFEFF\uD800-\uDFFF]/g;

async function readKeys(subjectEmail: string): Promise<{
  headers: string[];
  rows: unknown[][];
}> {
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
      .replace(KEYS_HEADER_NORMALIZE, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return { headers, rows: values.slice(1) };
}

async function resolveCompany(
  subjectEmail: string,
  project: string,
): Promise<string> {
  const { headers, rows } = await readKeys(subjectEmail);
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
  const lc = subjectEmail.toLowerCase().trim();
  if (ADMIN_EMAILS.has(lc)) return;
  const { headers, rows } = await readKeys(subjectEmail);
  const iProj = headers.indexOf("פרוייקט");
  const iClients = headers.indexOf("Email Client");
  const iInternal = headers.indexOf("Access — internal only");
  const iCf = headers.indexOf("Client-facing");
  const targetProject = project.toLowerCase().trim();
  for (const row of rows) {
    const p = String(row[iProj] ?? "")
      .toLowerCase()
      .trim();
    if (p !== targetProject) continue;
    for (const ci of [iClients, iInternal, iCf]) {
      if (ci < 0) continue;
      const raw = String(row[ci] ?? "").toLowerCase();
      if (raw.includes(lc)) return;
    }
    throw new Error("Access denied to project: " + project);
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
    /** Optional override for the leaf folder name. Defaults to
     *  `<task.id> — <title(0..60)>`, matching the legacy behavior. */
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
    if (campaign) {
      parent = await getOrCreateFolderInSharedDrive(
        drive,
        campaign,
        parent,
        sharedDriveId,
      );
    }

    const overrideName = (task.folderNameOverride || "").trim();
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

/**
 * Mark each assignee's Google Task as completed (or revive) based on
 * the new task status. The hub task carries `google_tasks` =
 * `{ email: { l: tasklist, t: taskId } }` set at create-time. For
 * each entry we patch the personal Tasks API entry — best-effort, an
 * assignee who deleted their entry just gets skipped.
 */
async function syncGoogleTasksStatus(
  googleTasks: Record<string, { u: string; l: string; t: string; d: string }>,
  desired: "completed" | "needsAction",
): Promise<void> {
  const entries = Object.values(googleTasks || {});
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
        const tasksApi = tasksApiClient(gt.u);
        await tasksApi.tasks.patch({
          tasklist: gt.l,
          task: gt.t,
          requestBody: { status: desired },
        });
      } catch (e) {
        console.log(
          `[tasksWriteDirect] Google Tasks patch (${desired}) failed for ${gt.u}:`,
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

async function createGoogleTasks(
  task: { id: string; title: string; project: string; description: string; drive_folder_url: string; requested_date: string; assignees: string[] },
): Promise<Record<string, { u: string; l: string; t: string; d: string }>> {
  const out: Record<string, { u: string; l: string; t: string; d: string }> = {};
  const hubUrl = (process.env.AUTH_URL || "").replace(/\/+$/, "");
  // Each assignee owns whether the hub puts entries in their personal
  // Google Tasks list — gate per-recipient.
  const allowed = await filterByGtasksPref(task.assignees);
  if (allowed.length === 0) return out;
  const notes =
    task.description +
    (task.drive_folder_url ? `\n\nקבצים: ${task.drive_folder_url}` : "") +
    (hubUrl ? `\n\n${hubUrl}/tasks/${encodeURIComponent(task.id)}` : "");
  // `requested_date` may be either "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM".
  // Google Tasks `due` only persists the date portion (the API doc is
  // explicit about that), so we strip any time and send it as midnight
  // UTC. The time-of-day stays only on the hub side for display.
  const datePart = (task.requested_date || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  const dueRfc = datePart
    ? new Date(datePart + "T00:00:00Z").toISOString()
    : undefined;
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
          requestBody: {
            title: "📋 " + task.title + " · " + task.project,
            notes,
            due: dueRfc,
          },
        });
        if (created.data.id) {
          out[email] = { u: email, l: listId, t: created.data.id, d: task.requested_date };
        }
      } catch (e) {
        console.log(`[tasksWriteDirect] Google Tasks insert failed for ${email}:`, e);
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
): Promise<void> {
  try {
    const gmail = gmailClient(authorEmail);
    // RFC 2822 MIME message. Subject UTF-8-encoded so Hebrew lands clean.
    const mime = [
      `From: ${authorEmail}`,
      `To: ${toEmail}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(plainBody, "utf-8").toString("base64"),
    ].join("\r\n");
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

/**
 * Ping every assignee on create — "you have a new task."
 * Skips recipients who turned off email_notifications in their gear menu.
 */
async function emailAssignees(
  task: { id: string; project: string; title: string; description: string; requested_date: string; priority: number; drive_folder_url: string; assignees: string[] },
  authorEmail: string,
): Promise<void> {
  if (!task.assignees.length) return;
  const allowed = await filterByEmailPref(task.assignees);
  if (allowed.length === 0) return;
  const hubUrl = (process.env.AUTH_URL || "").replace(/\/+$/, "");
  const link = hubUrl ? `${hubUrl}/tasks/${encodeURIComponent(task.id)}` : "";
  const subject = `📋 משימה חדשה עבורך — ${task.project} · ${task.title}`;
  const plainBody = [
    `${authorEmail.split("@")[0]} שיבץ/ה אותך למשימה חדשה.`,
    "",
    `פרויקט: ${task.project}`,
    `כותרת: ${task.title}`,
    task.description ? `\n${task.description}` : "",
    "",
    task.requested_date ? `תאריך מבוקש: ${task.requested_date}` : "",
    task.priority ? `דחיפות: ${task.priority}` : "",
    "",
    link ? `פרטי המשימה: ${link}` : "",
    task.drive_folder_url ? `תיקיית קבצים: ${task.drive_folder_url}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  await Promise.all(
    allowed.map((to) => sendMimeMail(authorEmail, to, subject, plainBody)),
  );
}

/**
 * Ping the approver when the task transitions INTO awaiting_approval —
 * "please review this finished work."
 */
async function emailApprover(
  task: { id: string; project: string; title: string; description: string; requested_date: string; priority: number },
  actorEmail: string,
  approverEmail: string,
): Promise<void> {
  if (!approverEmail) return;
  // Respect the approver's email_notifications preference. They may
  // still rely on the chat-card / hub UI as a notification channel.
  const allowed = await filterByEmailPref([approverEmail]);
  if (allowed.length === 0) return;
  const hubUrl = (process.env.AUTH_URL || "").replace(/\/+$/, "");
  const link = hubUrl ? `${hubUrl}/tasks/${encodeURIComponent(task.id)}` : "";
  const subject = `📋 משימה ממתינה לאישורך — ${task.project} · ${task.title}`;
  const plainBody = [
    `${actorEmail.split("@")[0]} סיים/ה את העבודה ומחכה לאישורך.`,
    "",
    `פרויקט: ${task.project}`,
    `כותרת: ${task.title}`,
    task.description ? `\n${task.description}` : "",
    "",
    task.requested_date ? `תאריך מבוקש: ${task.requested_date}` : "",
    task.priority ? `דחיפות: ${task.priority}` : "",
    "",
    link ? `לסקירה + אישור / החזרה לעבודה: ${link}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  await sendMimeMail(actorEmail, approverEmail, subject, plainBody);
}

/* ── Chat webhook (per-project card, unchanged behavior) ──────────── */

async function postChatWebhook(
  subjectEmail: string,
  project: string,
  kind: "create" | "resolve" | "reply",
  card: { authorName: string; body?: string; deepLink?: string; assignees?: string[] },
): Promise<void> {
  // Webhook URL lives in Keys col L. Read it here; don't fail the write
  // path if the read or POST errors.
  try {
    const { headers, rows } = await readKeys(subjectEmail);
    const iProj = headers.indexOf("פרוייקט");
    const iWebhook = headers.indexOf("Chat Webhook");
    if (iProj < 0 || iWebhook < 0) return;
    const target = project.toLowerCase().trim();
    let webhookUrl = "";
    for (const row of rows) {
      if (String(row[iProj] ?? "").toLowerCase().trim() === target) {
        webhookUrl = String(row[iWebhook] ?? "").trim();
        break;
      }
    }
    if (!webhookUrl) return;
    const emoji = kind === "create" ? "📋" : kind === "resolve" ? "✅" : "💬";
    const text = `${emoji} ${card.authorName}${kind === "create" ? " יצר/ה משימה" : kind === "resolve" ? " סיים/ה משימה" : " הגיב/ה"}${card.body ? `: ${card.body}` : ""}${card.deepLink ? `\n${card.deepLink}` : ""}`;
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.log("[tasksWriteDirect] Chat webhook post failed:", e);
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
    google_tasks: {},
    status_history: [{ at: now, by: subjectEmail, from: "", to: status, note: "created" }],
    edited_at: "",
    campaign: String(payload.campaign || "").trim(),
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
  const gt = await createGoogleTasks({
    id: task.id,
    title: task.title,
    project: task.project,
    description: task.description,
    drive_folder_url: task.drive_folder_url,
    requested_date: task.requested_date,
    assignees,
  });
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
  };
  // Reflect rank back on the in-memory task so callers see it.
  task.rank = newTaskRank;
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

  // After-write notifications (non-fatal). On create we email the
  // assignees ("you have a new task") — the approver gets a separate
  // email later when the status transitions to awaiting_approval.
  await Promise.all([
    emailAssignees(
      {
        id: task.id,
        project: task.project,
        title: task.title,
        description: task.description,
        requested_date: task.requested_date,
        priority: task.priority,
        drive_folder_url: task.drive_folder_url,
        assignees: task.assignees,
      },
      task.author_email,
    ),
    postChatWebhook(subjectEmail, project, "create", {
      authorName: task.author_email.split("@")[0],
      body:
        task.title +
        (task.description ? " — " + task.description.slice(0, 120) : ""),
      deepLink: process.env.AUTH_URL
        ? `${process.env.AUTH_URL.replace(/\/+$/, "")}/tasks/${encodeURIComponent(task.id)}`
        : "",
    }),
  ]);

  return { ok: true, task };
}

/* ── Main update orchestrator ──────────────────────────────────────── */

export async function tasksUpdateDirect(
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

      const currentGT = (() => {
        try {
          const v = cell("google_tasks");
          if (!v) return {};
          const parsed = typeof v === "string" ? JSON.parse(v) : v;
          return parsed && typeof parsed === "object"
            ? (parsed as Record<string, { u: string; l: string; t: string; d: string }>)
            : {};
        } catch {
          return {};
        }
      })();

      // Mark removed assignees' Google Tasks completed (best-effort)
      // and drop them from the map.
      const cleanedGT: Record<string, { u: string; l: string; t: string; d: string }> = {};
      for (const [email, ref] of Object.entries(currentGT)) {
        if (newAssignees.includes(email)) {
          cleanedGT[email] = ref;
          continue;
        }
        try {
          const tasksApi = tasksApiClient(ref.u || email);
          await tasksApi.tasks.patch({
            tasklist: ref.l,
            task: ref.t,
            requestBody: { status: "completed" },
          });
        } catch (e) {
          console.log(
            `[tasksWriteDirect] could not complete removed assignee's Google Task (${email}):`,
            e instanceof Error ? e.message : String(e),
          );
        }
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
          const fresh = await createGoogleTasks({
            id: taskId,
            title: mergedTitle,
            project: mergedProject,
            description: mergedDescription,
            drive_folder_url: driveUrl,
            requested_date: mergedRequestedDate,
            assignees: assigneeAdded,
          });
          for (const [email, ref] of Object.entries(fresh)) {
            cleanedGT[email] = ref;
          }
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

  // Chat post on key status transitions — same rules as Apps Script.
  if (changes.status) {
    const chatKind =
      changes.status === "done"
        ? "resolve"
        : changes.status === "in_progress"
          ? "create"
          : changes.status === "awaiting_approval"
            ? "reply"
            : null;
    if (chatKind) {
      await postChatWebhook(subjectEmail, project, chatKind, {
        authorName: subjectEmail.split("@")[0],
        body: String(cell("title") ?? "") + " · " + String(changes.status),
        deepLink: process.env.AUTH_URL
          ? `${process.env.AUTH_URL.replace(/\/+$/, "")}/tasks/${encodeURIComponent(taskId)}`
          : "",
      });
    }
  }

  // Email the approver when work transitions into awaiting_approval —
  // that's when they need to act. Build a lean task shape from the
  // fresh row so the email reflects any simultaneous field patches.
  if (changes.status === "awaiting_approval") {
    const fresh = rowToTask(freshRow, idx);
    await emailApprover(
      {
        id: fresh.id,
        project: fresh.project,
        title: fresh.title,
        description: fresh.description,
        requested_date: fresh.requested_date,
        priority: fresh.priority,
      },
      subjectEmail,
      fresh.approver_email,
    );
  }

  // Email newly-added assignees so they hear about the reassignment
  // outside the hub UI — same shape as the on-create heads-up.
  if (assigneeAdded.length > 0) {
    const fresh = rowToTask(freshRow, idx);
    await emailAssignees(
      {
        id: fresh.id,
        project: fresh.project,
        title: fresh.title,
        description: fresh.description,
        requested_date: fresh.requested_date,
        priority: fresh.priority,
        drive_folder_url: fresh.drive_folder_url,
        assignees: assigneeAdded,
      },
      subjectEmail,
    );
  }

  // Keep each assignee's personal Google Tasks list in sync with the
  // hub status. done / cancelled → mark completed (so the entry stops
  // nagging in their Tasks panel); revival to in_progress / awaiting_*
  // → re-open. Best-effort; failures don't block the response.
  if (changes.status) {
    const fresh = rowToTask(freshRow, idx);
    if (changes.status === "done" || changes.status === "cancelled") {
      await syncGoogleTasksStatus(fresh.google_tasks, "completed");
    } else if (
      changes.status === "in_progress" ||
      changes.status === "awaiting_handling" ||
      changes.status === "awaiting_clarification" ||
      changes.status === "awaiting_approval"
    ) {
      await syncGoogleTasksStatus(fresh.google_tasks, "needsAction");
    }
  }

  return { ok: true, task: rowToTask(freshRow, idx), changed: true };
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
    google_tasks: parseJsonField("google_tasks", false) as Record<string, { u: string; l: string; t: string; d: string }>,
    status_history: parseJsonField("status_history", true) as WorkTask["status_history"],
    edited_at: String(cell("edited_at") ?? ""),
    campaign: String(cell("campaign") ?? ""),
    rank: Number.isFinite(parsedRank) ? parsedRank : fallbackRank,
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
