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
 * Return a JWT client authorized to act as `subjectEmail` with the given
 * scopes. `subjectEmail` must be a user inside the F&F Workspace domain
 * — otherwise Google rejects the DWD token request.
 *
 * Scopes must exactly match what's authorized in Workspace Admin DWD.
 * Mismatched scopes fail at call time with `unauthorized_client`.
 */
export function getSAClient(subjectEmail: string, scopes: string[]): JWT {
  const k = cacheKey(subjectEmail, scopes);
  const hit = clientCache.get(k);
  if (hit) return hit;

  const key = loadKey();
  const jwt = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes,
    subject: subjectEmail,
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

/** The email the hub impersonates for Drive folder creation. Defaults
 *  to maayan@fandf.co.il so new folders land in the same account as
 *  the legacy Apps Script flow. Override via env. */
export function driveFolderOwner(): string {
  return (
    process.env.DRIVE_FOLDER_OWNER || "maayan@fandf.co.il"
  ).toLowerCase().trim();
}
