/**
 * Per-user preferences — knobs the user owns:
 *
 *   - email_notifications: on/off. When off, hub-side outbound emails
 *     (assignee heads-up, approver request, mention digest) skip this
 *     recipient. Defaults to ON.
 *   - gtasks_sync: on/off. When off, the user is not added to fresh
 *     Google Tasks created by the hub, and any existing entries are
 *     left alone on status flips. Defaults to ON.
 *   - view_as_email: another user's email. When set, /tasks + / read
 *     this user's identity for the role-default filter computation.
 *     Empty = act as self. No data-access escalation: the actual
 *     read paths still gate on the session user's Keys membership.
 *   - gmail_customer_poll: on/off. When ON, the customer-email cron
 *     impersonates this user via DWD and surfaces inbox messages
 *     from senders registered in Keys col E (Email Client) so they
 *     can be triaged without leaving the hub. Defaults to OFF — this
 *     is a meaningful trust ask (the system reads inbox content
 *     filtered by the sender list) and must be opt-in.
 *
 * Storage: a `User Preferences` tab on the Comments spreadsheet
 * (SHEET_ID_COMMENTS). Auto-created on first write. Lookup is by
 * lowercased email; one row per user. 5-min in-process cache mirrors
 * lib/userRole.ts so high-traffic pages don't hammer Sheets.
 */

import { sheetsClient } from "@/lib/sa";

export type UserPrefs = {
  email_notifications: boolean;
  gtasks_sync: boolean;
  view_as_email: string;
  /** ISO timestamp until which the topnav bell badge stays muted.
   *  Notifications still get written + email still flows; the snooze
   *  affects badge visibility only, so the user can opt back in by
   *  visiting /notifications without losing anything. Empty = no
   *  snooze active. */
  notifications_snooze_until: string;
  /** Last-used sort axis on the /tasks table view. Empty = "rank"
   *  (the manual drag-driven order). Persisted so column-header
   *  sorting survives a navigation away and back. The URL param
   *  always takes precedence — this is the fallback when no
   *  param is present. */
  tasks_sort: string;
  /** Last-used sort direction on /tasks. "asc" / "desc" / empty.
   *  Empty falls back to the column's natural default direction
   *  (dates desc, others asc). */
  tasks_sort_order: string;
  /** When true, /tasks collapses done/cancelled buckets on the
   *  table, hides the done/cancelled columns on the kanban behind
   *  an "📦 ארכיון" expand pill, and dims those events more
   *  aggressively on the calendar. Status-explicit URLs (?status
   *  =done) override and force them visible regardless. Default
   *  ON — fresh installs get a tidy queue immediately. */
  hide_archived: boolean;
  /** Days a task can sit in done/cancelled before it's considered
   *  archived. Drives the table's per-bucket "+N ישנות" fold + the
   *  archive count badge. Stored as a string of digits so the
   *  sheet read stays simple; parseInt with default 14. */
  archive_after_days: string;
  /** When true, the customer-email cron impersonates this user and
   *  surfaces Gmail messages from senders listed in Keys col E
   *  (Email Client) into the hub's customer-email tray. Default OFF
   *  — opt-in only because the cron reads inbox content for matching
   *  senders, which is a different trust model than the existing
   *  user-tagged "Add to Tasks" flow. */
  gmail_customer_poll: boolean;
};

const DEFAULT_PREFS: UserPrefs = {
  email_notifications: true,
  gtasks_sync: true,
  view_as_email: "",
  notifications_snooze_until: "",
  tasks_sort: "",
  tasks_sort_order: "",
  hide_archived: true,
  archive_after_days: "14",
  gmail_customer_poll: false,
};

const TAB = "User Preferences";
const HEADERS = [
  "email",
  "email_notifications",
  "gtasks_sync",
  "view_as_email",
  "notifications_snooze_until",
  "tasks_sort",
  "tasks_sort_order",
  "hide_archived",
  "archive_after_days",
  "gmail_customer_poll",
  "updated_at",
];

const CACHE = new Map<string, { prefs: UserPrefs; expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000;

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (v === true || v === "TRUE" || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "FALSE" || v === "false" || v === 0 || v === "0") return false;
  return fallback;
}

/** Ensure the User Preferences tab exists and has the canonical
 *  headers. Idempotent — safe to call from every read/write. */
async function ensureTab(subjectEmail: string): Promise<void> {
  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_COMMENTS");
  // Cheap check: try a header read. If the tab is missing we get a
  // 400; create + seed in that case.
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: `${TAB}!1:1`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const row = (res.data.values?.[0] ?? []) as unknown[];
    const have = row.map((h) => String(h ?? "").trim().toLowerCase());
    const want = HEADERS.map((h) => h.toLowerCase());
    const missing = want.filter((h) => !have.includes(h));
    if (missing.length === 0) return;
    // Append any missing headers so older sheets pick up new columns.
    const next = [...have];
    for (const h of missing) next.push(h);
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId,
      range: `${TAB}!1:1`,
      valueInputOption: "RAW",
      requestBody: { values: [next] },
    });
    return;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/Unable to parse range|notFound|not found/i.test(msg)) throw e;
  }

  // Tab missing — create it and seed headers.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: ssId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: TAB } } }],
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: ssId,
    range: `${TAB}!1:1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
}

async function readAllPrefs(
  subjectEmail: string,
): Promise<{ headers: string[]; rows: unknown[][] }> {
  await ensureTab(subjectEmail);
  const sheets = sheetsClient(subjectEmail);
  const ssId = envOrThrow("SHEET_ID_COMMENTS");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: TAB,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (values.length === 0) return { headers: HEADERS, rows: [] };
  const headers = (values[0] as unknown[]).map((h) =>
    String(h ?? "").trim().toLowerCase(),
  );
  return { headers, rows: values.slice(1) };
}

/** Read a user's preferences. Returns defaults for users with no row. */
export async function getUserPrefs(targetEmail: string): Promise<UserPrefs> {
  const lc = targetEmail.toLowerCase().trim();
  if (!lc) return { ...DEFAULT_PREFS };
  const cached = CACHE.get(lc);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.prefs };

  let prefs = { ...DEFAULT_PREFS };
  try {
    const { headers, rows } = await readAllPrefs(targetEmail);
    const iEmail = headers.indexOf("email");
    const iNotif = headers.indexOf("email_notifications");
    const iSync = headers.indexOf("gtasks_sync");
    const iViewAs = headers.indexOf("view_as_email");
    const iSnooze = headers.indexOf("notifications_snooze_until");
    const iSort = headers.indexOf("tasks_sort");
    const iOrder = headers.indexOf("tasks_sort_order");
    const iHideArch = headers.indexOf("hide_archived");
    const iArchDays = headers.indexOf("archive_after_days");
    const iGmailPoll = headers.indexOf("gmail_customer_poll");
    if (iEmail < 0) return prefs;
    for (const row of rows) {
      const e = String(row[iEmail] ?? "").toLowerCase().trim();
      if (e !== lc) continue;
      prefs = {
        email_notifications: iNotif >= 0
          ? asBool(row[iNotif], DEFAULT_PREFS.email_notifications)
          : DEFAULT_PREFS.email_notifications,
        gtasks_sync: iSync >= 0
          ? asBool(row[iSync], DEFAULT_PREFS.gtasks_sync)
          : DEFAULT_PREFS.gtasks_sync,
        view_as_email: iViewAs >= 0
          ? String(row[iViewAs] ?? "").toLowerCase().trim()
          : "",
        notifications_snooze_until:
          iSnooze >= 0 ? String(row[iSnooze] ?? "").trim() : "",
        tasks_sort: iSort >= 0 ? String(row[iSort] ?? "").trim() : "",
        tasks_sort_order:
          iOrder >= 0 ? String(row[iOrder] ?? "").trim() : "",
        hide_archived:
          iHideArch >= 0
            ? asBool(row[iHideArch], DEFAULT_PREFS.hide_archived)
            : DEFAULT_PREFS.hide_archived,
        archive_after_days:
          iArchDays >= 0
            ? String(row[iArchDays] ?? "").trim() ||
              DEFAULT_PREFS.archive_after_days
            : DEFAULT_PREFS.archive_after_days,
        gmail_customer_poll:
          iGmailPoll >= 0
            ? asBool(row[iGmailPoll], DEFAULT_PREFS.gmail_customer_poll)
            : DEFAULT_PREFS.gmail_customer_poll,
      };
      break;
    }
  } catch (e) {
    console.log(
      "[userPrefs] read failed, returning defaults:",
      e instanceof Error ? e.message : String(e),
    );
  }
  CACHE.set(lc, { prefs, expiresAt: Date.now() + TTL_MS });
  return { ...prefs };
}

/** Bypasses the cache — use when the caller just wrote prefs and wants
 *  the next read to re-fetch from the sheet. */
export function invalidateUserPrefs(targetEmail: string): void {
  CACHE.delete(targetEmail.toLowerCase().trim());
}

/** Upsert a user's preferences. Partial — only the keys passed in get
 *  written; missing keys keep their current value (or default if no
 *  existing row). The row is matched by lowercased email. */
export async function setUserPrefs(
  targetEmail: string,
  partial: Partial<UserPrefs>,
): Promise<UserPrefs> {
  const lc = targetEmail.toLowerCase().trim();
  if (!lc) throw new Error("setUserPrefs: empty email");
  await ensureTab(targetEmail);

  const sheets = sheetsClient(targetEmail);
  const ssId = envOrThrow("SHEET_ID_COMMENTS");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: ssId,
    range: TAB,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const values = (res.data.values ?? []) as unknown[][];
  const headerRow = (values[0] as unknown[] | undefined) ?? HEADERS;
  const headers = headerRow.map((h) => String(h ?? "").trim().toLowerCase());

  // Locate or build the row to write.
  let rowIndex = -1; // 0-based within `values` (excluding header offset added later)
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][headers.indexOf("email")] ?? "").toLowerCase().trim() === lc) {
      rowIndex = i;
      break;
    }
  }

  // Read existing row into a UserPrefs shape, then merge partial.
  const existing: UserPrefs = (() => {
    if (rowIndex < 0) return { ...DEFAULT_PREFS };
    const r = values[rowIndex];
    const iSnoozeExisting = headers.indexOf("notifications_snooze_until");
    const iSortExisting = headers.indexOf("tasks_sort");
    const iOrderExisting = headers.indexOf("tasks_sort_order");
    const iHideArchExisting = headers.indexOf("hide_archived");
    const iArchDaysExisting = headers.indexOf("archive_after_days");
    const iGmailPollExisting = headers.indexOf("gmail_customer_poll");
    return {
      email_notifications: asBool(
        r[headers.indexOf("email_notifications")],
        DEFAULT_PREFS.email_notifications,
      ),
      gtasks_sync: asBool(
        r[headers.indexOf("gtasks_sync")],
        DEFAULT_PREFS.gtasks_sync,
      ),
      view_as_email: String(
        r[headers.indexOf("view_as_email")] ?? "",
      ).toLowerCase().trim(),
      notifications_snooze_until:
        iSnoozeExisting >= 0
          ? String(r[iSnoozeExisting] ?? "").trim()
          : "",
      tasks_sort:
        iSortExisting >= 0 ? String(r[iSortExisting] ?? "").trim() : "",
      tasks_sort_order:
        iOrderExisting >= 0 ? String(r[iOrderExisting] ?? "").trim() : "",
      hide_archived:
        iHideArchExisting >= 0
          ? asBool(r[iHideArchExisting], DEFAULT_PREFS.hide_archived)
          : DEFAULT_PREFS.hide_archived,
      archive_after_days:
        iArchDaysExisting >= 0
          ? String(r[iArchDaysExisting] ?? "").trim() ||
            DEFAULT_PREFS.archive_after_days
          : DEFAULT_PREFS.archive_after_days,
      gmail_customer_poll:
        iGmailPollExisting >= 0
          ? asBool(r[iGmailPollExisting], DEFAULT_PREFS.gmail_customer_poll)
          : DEFAULT_PREFS.gmail_customer_poll,
    };
  })();
  const merged: UserPrefs = { ...existing, ...partial };
  // Normalize view_as_email — empty string clears it.
  merged.view_as_email = String(merged.view_as_email || "").toLowerCase().trim();
  merged.notifications_snooze_until = String(
    merged.notifications_snooze_until || "",
  ).trim();
  merged.tasks_sort = String(merged.tasks_sort || "").trim();
  merged.tasks_sort_order = String(merged.tasks_sort_order || "").trim();
  // Clamp archive_after_days to a sensible range — a typo'd 99999
  // would hide nothing; 0 would hide everything terminal-state.
  const archDays = parseInt(String(merged.archive_after_days || "14"), 10);
  merged.archive_after_days = String(
    Number.isFinite(archDays) ? Math.max(1, Math.min(365, archDays)) : 14,
  );

  // Build the row in header order. Future-proof against extra columns
  // by writing only what we know about; preserve other cells if present.
  const now = new Date().toISOString();
  const cells: Record<string, unknown> = {
    email: lc,
    email_notifications: merged.email_notifications,
    gtasks_sync: merged.gtasks_sync,
    view_as_email: merged.view_as_email,
    notifications_snooze_until: merged.notifications_snooze_until,
    tasks_sort: merged.tasks_sort,
    tasks_sort_order: merged.tasks_sort_order,
    hide_archived: merged.hide_archived,
    archive_after_days: merged.archive_after_days,
    gmail_customer_poll: merged.gmail_customer_poll,
    updated_at: now,
  };
  const newRow: unknown[] = headers.map((h) =>
    h in cells ? cells[h] : (rowIndex >= 0 ? values[rowIndex][headers.indexOf(h)] : ""),
  );

  if (rowIndex < 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: ssId,
      range: TAB,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [newRow] },
    });
  } else {
    const sheetRow = rowIndex + 1; // 0-based values index → 1-based sheet row
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId,
      range: `${TAB}!A${sheetRow}:${columnLetter(headers.length)}${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [newRow] },
    });
  }

  CACHE.set(lc, { prefs: merged, expiresAt: Date.now() + TTL_MS });
  return { ...merged };
}

/** Read every row of User Preferences as a `{email, prefs}` map.
 *  Used by the admin page to show prefs for all users at once.
 *  Caller must enforce its own admin gate. Cache is bypassed on
 *  purpose — admin views want a fresh snapshot. */
export async function listAllUserPrefs(
  subjectEmail: string,
): Promise<Array<{ email: string; prefs: UserPrefs; updatedAt: string }>> {
  const { headers, rows } = await readAllPrefs(subjectEmail);
  const iEmail = headers.indexOf("email");
  if (iEmail < 0) return [];
  const iNotif = headers.indexOf("email_notifications");
  const iSync = headers.indexOf("gtasks_sync");
  const iViewAs = headers.indexOf("view_as_email");
  const iSnooze = headers.indexOf("notifications_snooze_until");
  const iSort = headers.indexOf("tasks_sort");
  const iOrder = headers.indexOf("tasks_sort_order");
  const iHideArch = headers.indexOf("hide_archived");
  const iArchDays = headers.indexOf("archive_after_days");
  const iGmailPoll = headers.indexOf("gmail_customer_poll");
  const iUpdated = headers.indexOf("updated_at");
  const out: Array<{ email: string; prefs: UserPrefs; updatedAt: string }> = [];
  for (const row of rows) {
    const e = String(row[iEmail] ?? "").toLowerCase().trim();
    if (!e) continue;
    const prefs: UserPrefs = {
      email_notifications: iNotif >= 0
        ? asBool(row[iNotif], DEFAULT_PREFS.email_notifications)
        : DEFAULT_PREFS.email_notifications,
      gtasks_sync: iSync >= 0
        ? asBool(row[iSync], DEFAULT_PREFS.gtasks_sync)
        : DEFAULT_PREFS.gtasks_sync,
      view_as_email: iViewAs >= 0
        ? String(row[iViewAs] ?? "").toLowerCase().trim()
        : "",
      notifications_snooze_until:
        iSnooze >= 0 ? String(row[iSnooze] ?? "").trim() : "",
      tasks_sort: iSort >= 0 ? String(row[iSort] ?? "").trim() : "",
      tasks_sort_order: iOrder >= 0 ? String(row[iOrder] ?? "").trim() : "",
      hide_archived: iHideArch >= 0
        ? asBool(row[iHideArch], DEFAULT_PREFS.hide_archived)
        : DEFAULT_PREFS.hide_archived,
      archive_after_days: iArchDays >= 0
        ? String(row[iArchDays] ?? "").trim() ||
          DEFAULT_PREFS.archive_after_days
        : DEFAULT_PREFS.archive_after_days,
      gmail_customer_poll:
        iGmailPoll >= 0
          ? asBool(row[iGmailPoll], DEFAULT_PREFS.gmail_customer_poll)
          : DEFAULT_PREFS.gmail_customer_poll,
    };
    const updatedAt = iUpdated >= 0 ? String(row[iUpdated] ?? "").trim() : "";
    out.push({ email: e, prefs, updatedAt });
  }
  return out;
}

/** Defaults exposed for callers that need to render a "default for
 *  this user" row (admin page) without having to call setUserPrefs
 *  first. */
export function getDefaultUserPrefs(): UserPrefs {
  return { ...DEFAULT_PREFS };
}

function columnLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
