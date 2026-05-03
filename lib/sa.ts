/**
 * Service-account auth with domain-wide delegation.
 *
 * The SA key (same JSON that lives on the Apps Script project under
 * Script Property `SERVICE_ACCOUNT_KEY_JSON`) is read from the
 * `TASKS_SA_KEY_JSON` env var. Production reads it from Google Cloud
 * Secret Manager via apphosting.yaml; local dev reads it from
 * `.env.local`.
 *
 * Each authClient is tied to ONE impersonated user + a fixed scope list.
 * The clients are cached per (email, scopes) so repeated calls within
 * the same Node process reuse the JWT without re-signing.
 *
 * Scopes currently wired through DWD (as of 2026-04-24):
 *   - https://www.googleapis.com/auth/tasks         (original)
 *   - https://www.googleapis.com/auth/spreadsheets  (new, for tasks reads)
 *
 * Add a new scope here only after it's also been added in
 *   Workspace Admin → Security → API controls → Domain-wide delegation
 * for client ID 102907403320696302169 ("fandf dashboard"). Without that,
 * JWT token requests will succeed but the API calls will 403.
 */

import { google } from "googleapis";
import type { JWT } from "google-auth-library";

type SAKey = {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
};

let cachedKey: SAKey | null = null;

function loadKey(): SAKey {
  if (cachedKey) return cachedKey;
  const raw = process.env.TASKS_SA_KEY_JSON;
  if (!raw) {
    throw new Error(
      "TASKS_SA_KEY_JSON is not set. See hub-next/.env.local.example.",
    );
  }
  try {
    cachedKey = JSON.parse(raw) as SAKey;
    return cachedKey;
  } catch (e) {
    throw new Error(
      `TASKS_SA_KEY_JSON is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// In-process cache: JWT client per (subject, sorted-scopes) key.
// Google's JWT client caches access tokens internally, so we just need
// to avoid re-creating the client itself on every call.
const clientCache = new Map<string, JWT>();

function cacheKey(subject: string, scopes: string[]): string {
  return `${subject}::${[...scopes].sort().join(",")}`;
}

/**
 * Pick the email to impersonate via DWD. The SA can only delegate to
 * users inside the F&F Workspace domain — outside emails (personal
 * Gmail addresses for external clients) blow up with
 * `unauthorized_client`. For those callers we impersonate the
 * configured Drive-folder owner instead.
 *
 * Access control isn't compromised: every direct-read helper takes the
 * original requested email as a separate argument and gates results
 * against Keys columns. The "effective" email here only decides whose
 * Workspace identity makes the API call.
 */
function effectiveSubject(requestedEmail: string): string {
  const lc = requestedEmail.toLowerCase().trim();
  if (lc.endsWith("@fandf.co.il")) return requestedEmail;
  // External user: impersonate the team's bot identity.
  return driveFolderOwner();
}

/**
 * Return a JWT client authorized to act as `subjectEmail` with the given
 * scopes. For external (non-@fandf.co.il) callers the SA impersonates
 * a fixed F&F identity (`DRIVE_FOLDER_OWNER`) — DWD can't delegate to
 * personal Gmail accounts. Caller is responsible for separately
 * gating the data they read against the original email.
 *
 * Scopes must exactly match what's authorized in Workspace Admin DWD.
 * Mismatched scopes fail at call time with `unauthorized_client`.
 */
export function getSAClient(subjectEmail: string, scopes: string[]): JWT {
  const subject = effectiveSubject(subjectEmail);
  const k = cacheKey(subject, scopes);
  const hit = clientCache.get(k);
  if (hit) return hit;

  const key = loadKey();
  const jwt = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes,
    subject,
  });
  clientCache.set(k, jwt);
  return jwt;
}

/**
 * Convenience wrapper: returns a Sheets API client authorized as
 * `subjectEmail` with the `spreadsheets` scope. Use for any sheet
 * read/write.
 */
export function sheetsClient(subjectEmail: string) {
  const auth = getSAClient(subjectEmail, [
    "https://www.googleapis.com/auth/spreadsheets",
  ]);
  return google.sheets({ version: "v4", auth });
}

/**
 * Convenience wrapper for the Tasks API (scope: `tasks`). Used by the
 * direct write path to create Google Tasks on assignees' default lists.
 */
export function tasksApiClient(subjectEmail: string) {
  const auth = getSAClient(subjectEmail, [
    "https://www.googleapis.com/auth/tasks",
  ]);
  return google.tasks({ version: "v1", auth });
}

/**
 * Drive API client. Used to create/lookup the per-task folder hierarchy
 * (`F&F Tasks / <company> / <project> / <task-id — title>`). Usually
 * impersonates the Drive-folder owner (DRIVE_FOLDER_OWNER env, defaults
 * to maayan@fandf.co.il) so folders land in the same account as the
 * legacy Apps Script flow.
 */
export function driveClient(subjectEmail: string) {
  const auth = getSAClient(subjectEmail, [
    "https://www.googleapis.com/auth/drive",
  ]);
  return google.drive({ version: "v3", auth });
}

/**
 * Calendar API client. Impersonates each assignee to create events on
 * their primary calendar.
 */
export function calendarClient(subjectEmail: string) {
  const auth = getSAClient(subjectEmail, [
    "https://www.googleapis.com/auth/calendar",
  ]);
  return google.calendar({ version: "v3", auth });
}

/**
 * Gmail send-as client. Impersonates the email sender (usually the task
 * author) so the approval-request email lands "from" a real person,
 * matching the Apps Script MailApp behavior.
 */
export function gmailClient(subjectEmail: string) {
  const auth = getSAClient(subjectEmail, [
    "https://www.googleapis.com/auth/gmail.send",
  ]);
  return google.gmail({ version: "v1", auth });
}

/**
 * Gmail read client (full readonly). Used by the Gmail-origin task
 * inbox to resolve the sender of an email referenced by a Google Task's
 * `links[]` entry, so the convert-to-task flow can pre-select the
 * matching client's company. Scope is broad (full readonly) so Workspace
 * Admin only needs to greenlight one Gmail scope.
 *
 * REQUIRES adding the scope to DWD client 102907403320696302169 in
 * Workspace Admin → Security → API controls → Domain-wide delegation:
 *   - https://www.googleapis.com/auth/gmail.readonly
 * Until that's done, calls return 403 and the Gmail-tasks list still
 * works — only the company auto-prefill silently no-ops.
 */
export function gmailReadClient(subjectEmail: string) {
  const auth = getSAClient(subjectEmail, [
    "https://www.googleapis.com/auth/gmail.readonly",
  ]);
  return google.gmail({ version: "v1", auth });
}

/**
 * Admin SDK Directory client (read-only on users). Used to resolve a
 * Chat `users/<id>` resource name into a real displayName when the
 * Chat API itself doesn't include it on a message's sender record —
 * which it routinely doesn't, especially for SA-impersonated posts.
 *
 * REQUIRES one extra DWD scope on top of the Chat ones above:
 *   - https://www.googleapis.com/auth/admin.directory.user.readonly
 * Add it in Workspace Admin → Security → API controls → Domain-wide
 * delegation, same client ID. The impersonated user must be a member
 * of the F&F directory (any @fandf.co.il user works); they don't need
 * admin role since the scope is read-only.
 *
 * Lookups are cached in-process for 1h via the Map in lib/chat.ts.
 */
export function directoryClient(subjectEmail: string) {
  const auth = getSAClient(subjectEmail, [
    "https://www.googleapis.com/auth/admin.directory.user.readonly",
  ]);
  return google.admin({ version: "directory_v1", auth });
}

/**
 * Google Chat client. Impersonates the calling F&F user so list/post
 * actions appear authored by them in the project Chat space. Used by
 * the project page's "🔒 דיון פנימי" tab to surface recent messages
 * server-side, and by the cross-stream signal that drops a notice into
 * the internal Chat space whenever a client posts in the hub.
 *
 * REQUIRES (one-time GCP / Workspace setup):
 *   1. Enable "Google Chat API" on the GCP project (fandf-dashboard).
 *   2. In Workspace Admin → Security → API controls → Domain-wide
 *      delegation, edit the SA's client ID and add scopes:
 *        - https://www.googleapis.com/auth/chat.messages.readonly
 *        - https://www.googleapis.com/auth/chat.messages
 *      (Both are needed: readonly for list, write for post.)
 *   3. Confirm the SA can impersonate any @fandf.co.il user — same as
 *      Sheets / Drive setup, no separate domain bind.
 *
 * No per-space membership setup is needed: the impersonated user is
 * the actual space member, so reads / writes inherit their access.
 */
export function chatClient(subjectEmail: string) {
  const auth = getSAClient(subjectEmail, [
    "https://www.googleapis.com/auth/chat.messages",
    "https://www.googleapis.com/auth/chat.messages.readonly",
  ]);
  return google.chat({ version: "v1", auth });
}

/**
 * Chat client scoped for creating spaces — `chat.spaces.create` (the
 * narrow write-restricted scope, separate from `chat.spaces` and from
 * the messages scopes above). Used by the admin "Create Chat Space"
 * flow at /admin/chat-spaces.
 *
 * REQUIRES adding the scope to DWD client 102907403320696302169 in
 * Workspace Admin → Security → API controls → Domain-wide delegation:
 *   - https://www.googleapis.com/auth/chat.spaces.create
 * Until that's done, calls return 403. The Chat API itself must also
 * be enabled on the GCP project (one-time, already done for the
 * messages scopes).
 *
 * Why a separate client (vs adding the scope to chatClient): the
 * narrower the scope per call site, the smaller the blast radius if
 * the SA key ever leaks. chatClient handles read/write of messages
 * across every project; only the admin create-space flow needs to
 * actually mint new spaces.
 */
export function chatSpaceCreateClient(subjectEmail: string) {
  const auth = getSAClient(subjectEmail, [
    "https://www.googleapis.com/auth/chat.spaces.create",
  ]);
  return google.chat({ version: "v1", auth });
}

/**
 * Chat client scoped for adding members to existing spaces. Used by
 * the "Create Chat Space" flow to invite the project's roster (Keys
 * cols C/D/J/K + admins, internal-only) right after the space is
 * created — so people don't have to be invited one-by-one in the
 * Chat UI.
 *
 * REQUIRES adding the scope to DWD client 102907403320696302169 in
 * Workspace Admin → Security → API controls → Domain-wide delegation:
 *   - https://www.googleapis.com/auth/chat.memberships
 * Until that's granted, calls return 403 / unauthorized_client. The
 * create flow logs the failure and returns success with a partial-
 * fan-out warning rather than rolling back the space.
 */
export function chatMembershipsClient(subjectEmail: string) {
  const auth = getSAClient(subjectEmail, [
    "https://www.googleapis.com/auth/chat.memberships",
  ]);
  return google.chat({ version: "v1", auth });
}

/** True when the hub is configured to use the direct SA-backed reads. */
export function useSATasksReads(): boolean {
  return String(process.env.USE_SA_TASKS_READS || "").trim() === "1";
}

/** True when the hub is configured to use the direct SA-backed writes.
 *  Separate from reads because writes require 3 additional DWD scopes
 *  (drive, calendar, gmail.send) that may not be in place yet. */
export function useSATasksWrites(): boolean {
  return String(process.env.USE_SA_TASKS_WRITES || "").trim() === "1";
}

/** True when the hub routes getProjectComments / getMyMentions /
 *  getProjectTasks through direct Sheets reads instead of Apps Script.
 *  Shares the /auth/spreadsheets DWD scope with reads; no new scope
 *  needed to flip it on. */
export function useSACommentsReads(): boolean {
  return String(process.env.USE_SA_COMMENTS_READS || "").trim() === "1";
}

/** True when `getMyProjects` reads the Keys tab directly via SA
 *  instead of calling the Apps Script `myProjects` action. Runs on
 *  every hub page render (nav dropdown + home) so the perf win is
 *  broad. */
export function useSAProjectsReads(): boolean {
  return String(process.env.USE_SA_PROJECTS_READS || "").trim() === "1";
}

/** The email the hub impersonates for Drive folder creation. Defaults
 *  to maayan@fandf.co.il so new folders land in the same account as
 *  the legacy Apps Script flow. Override via env. */
export function driveFolderOwner(): string {
  return (
    process.env.DRIVE_FOLDER_OWNER || "maayan@fandf.co.il"
  ).toLowerCase().trim();
}
