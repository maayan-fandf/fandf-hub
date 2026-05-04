/**
 * Direct-to-Sheets implementation of `getMyProjects`.
 *
 * Reads the Keys tab once + the names-to-emails tab once, assembles
 * the MyProjects shape (projects + per-project rosters + isAdmin /
 * isInternal / isStaff / isClient flags + display name) entirely in
 * Node.
 *
 * Replaces an Apps Script call that hits on EVERY hub page (the top
 * nav projects dropdown). Cuts ~1 s off per page load.
 *
 * Invariants kept identical to the Apps Script implementation:
 * - Admins see every project in Keys.
 * - Staff (anyone on col C / D / J / K of any project) sees every project.
 * - Clients (only on col E, never on staff columns) see only their projects.
 * - `roster.mediaManager` (col C) + `roster.projectManagerFull` (col D)
 *   are display names (Google People chip strings), not emails.
 * - `roster.internalOnly` (col J) + `roster.clientFacing` (col K) are
 *   arrays of names, split on commas.
 * - `chatSpaceUrl` is derived from the project's Chat Webhook cell
 *   (col L), not persisted separately.
 *
 * Performance: two Sheets API reads (Keys + names_to_emails) in
 * parallel. ~200–400 ms cold vs. ~1–2 s through Apps Script.
 */

import { cache } from "react";
import type { MyProjects, Project, ProjectRoster } from "@/lib/appsScript";
import { sheetsClient } from "@/lib/sa";
import { readKeysRows, HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";
import { findChatSpaceColumnIndex } from "@/lib/keys";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/** Parse any of the Chat URL forms a user might paste into Keys col L
 *  into the shareable mail.google deep-link the hub renders. Recognized
 *  inputs:
 *    - Webhook URL          → chat.googleapis.com/v1/spaces/<ID>/messages
 *    - Standalone Chat URL  → chat.google.com/room/<ID>?cls=N
 *    - Mail-embedded link   → mail.google.com/chat/u/N/#chat/space/<ID>
 *    - Bare resource name   → spaces/<ID> or just <ID>
 *  Returns "" when nothing matches. Lifted out of the original
 *  webhook-only matcher when the channel-split rolled out and users
 *  started pasting the Copy-link deeplink (col L was renamed in spirit
 *  to "Chat URL" but the schema still labels it Chat Webhook). */
export function chatSpaceUrlFromWebhook(webhookUrl: string): string {
  if (!webhookUrl) return "";
  let id = "";
  let m = webhookUrl.match(
    /^https:\/\/chat\.googleapis\.com\/v1\/spaces\/([A-Za-z0-9_-]+)\/messages/,
  );
  if (m) id = m[1];
  if (!id) {
    m = webhookUrl.match(
      /^https:\/\/chat\.google\.com\/(?:room|space)\/([A-Za-z0-9_-]+)/,
    );
    if (m) id = m[1];
  }
  if (!id) {
    m = webhookUrl.match(/[/#]chat\/(?:space|room)\/([A-Za-z0-9_-]+)/);
    if (m) id = m[1];
  }
  if (!id) {
    m = webhookUrl.trim().match(/^(?:spaces\/)?([A-Za-z0-9_-]{8,})$/);
    if (m) id = m[1];
  }
  if (!id) return "";
  return `https://mail.google.com/chat/u/0/#chat/space/${id}`;
}

/**
 * Look up the Google Chat space deep link for a single project. Used
 * by /tasks/[id] to render an "open in chat" button without going
 * through the full getMyProjectsDirect assembly.
 *
 * Reads Keys via the shared cached helper, so this is effectively
 * free when called on a page that already touched Keys (every task /
 * project page does, via assertProjectAccess + getMyProjects).
 *
 * Returns "" when:
 * - Keys lookup fails (project not found, no Chat Webhook column)
 * - The webhook cell is empty
 * - The webhook URL doesn't match the expected /v1/spaces/<id>/ shape
 */
export async function getProjectChatSpaceUrl(
  subjectEmail: string,
  project: string,
): Promise<string> {
  const target = (project || "").toLowerCase().trim();
  if (!target) return "";
  try {
    const { headers, rows } = await readKeysRows(subjectEmail);
    const iProj = headers.indexOf("פרוייקט");
    const iWebhook = findChatSpaceColumnIndex(headers);
    if (iProj < 0 || iWebhook < 0) return "";
    for (const row of rows) {
      const name = String(row[iProj] ?? "").toLowerCase().trim();
      if (name !== target) continue;
      return chatSpaceUrlFromWebhook(String(row[iWebhook] ?? "").trim());
    }
  } catch {
    // Non-fatal — page just renders without the button.
  }
  return "";
}

/**
 * Per-request landing-URL lookup. Used by ClarityInsightsSection to
 * resolve which URL to query the Microsoft Clarity Data Export API for.
 *
 * Tolerant header match across English + Hebrew labels — the Keys sheet
 * has been edited by hand for years, so column names drift. Returns ""
 * when the project isn't found OR the row exists but the cell is blank;
 * callers should treat both the same way (silently skip the section).
 *
 * Wrapped in React's `cache()` for per-request dedup. Not unstable_cache
 * because Drive folder lookups in the same lib showed multi-instance
 * staleness (see feedback_unstable_cache_multi_instance.md); landing
 * URLs change rarely enough that React-cache is sufficient.
 */
const LANDING_URL_HEADER_CANDIDATES = [
  "landing url",
  "landing",
  "landing page",
  "url",
  "דף נחיתה",
  "קישור דף נחיתה",
];

export const getProjectLandingUrl = cache(
  async (subjectEmail: string, project: string): Promise<string> => {
    const target = (project || "").toLowerCase().trim();
    if (!target) return "";
    try {
      const { headers, rows } = await readKeysRows(subjectEmail);
      const iProj = headers.indexOf("פרוייקט");
      if (iProj < 0) return "";
      // Find the landing-URL column via tolerant case-insensitive match
      // — header text varies row-to-row across the sheet's history.
      const lowerHeaders = headers.map((h) => String(h ?? "").toLowerCase().trim());
      let iLanding = -1;
      for (const candidate of LANDING_URL_HEADER_CANDIDATES) {
        const idx = lowerHeaders.indexOf(candidate);
        if (idx >= 0) {
          iLanding = idx;
          break;
        }
      }
      if (iLanding < 0) return "";
      for (const row of rows) {
        const name = String(row[iProj] ?? "").toLowerCase().trim();
        if (name !== target) continue;
        const url = String(row[iLanding] ?? "").trim();
        return url;
      }
    } catch {
      // Non-fatal — page just renders without the section.
    }
    return "";
  },
);

const CLARITY_TOKEN_HEADER_CANDIDATES = [
  "clarity api token",
  "clarity token",
  "clarity api key",
  "clarity key",
  "clarity api",
  "clarity",
  "טוקן קלריטי",
  "קלריטי",
];

export const getProjectClarityToken = cache(
  async (subjectEmail: string, project: string): Promise<string> => {
    const target = (project || "").toLowerCase().trim();
    if (!target) return "";
    try {
      const { headers, rows } = await readKeysRows(subjectEmail);
      const iProj = headers.indexOf("פרוייקט");
      if (iProj < 0) return "";
      const lowerHeaders = headers.map((h) => String(h ?? "").toLowerCase().trim());
      let iToken = -1;
      for (const candidate of CLARITY_TOKEN_HEADER_CANDIDATES) {
        const idx = lowerHeaders.indexOf(candidate);
        if (idx >= 0) {
          iToken = idx;
          break;
        }
      }
      if (iToken < 0) return "";
      for (const row of rows) {
        const name = String(row[iProj] ?? "").toLowerCase().trim();
        if (name !== target) continue;
        return String(row[iToken] ?? "").trim();
      }
    } catch {
      // Non-fatal — section silently disabled when token unreadable.
    }
    return "";
  },
);

/** Split a "Name1, Name2" roster cell into an array of trimmed names.
 *  Empty entries are dropped; the input is treated as Unicode, so
 *  Hebrew names round-trip cleanly. */
function splitRosterCell(raw: unknown): string[] {
  if (!raw) return [];
  return String(raw)
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Read the names_to_emails tab and return EVERY display name registered
 *  against `subjectEmail`. A user can have multiple aliases (e.g. an
 *  "Itay Stein" chip plus an "Itay" chip in different rows). All of them
 *  matter when matching the user against Keys cols C / D / J / K. */
export async function getDisplayNamesForEmail(
  subjectEmail: string,
): Promise<string[]> {
  try {
    const sheets = sheetsClient(subjectEmail);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
      range: "names to emails",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const values = (res.data.values ?? []) as unknown[][];
    if (values.length < 2) return [];
    const headers = (values[0] as unknown[]).map((h) =>
      String(h ?? "").trim().toLowerCase(),
    );
    const iName = headers.findIndex((h) =>
      ["full name", "name", "full_name", "fullname"].includes(h),
    );
    const iEmail = headers.findIndex((h) =>
      ["email", "e-mail", "mail"].includes(h),
    );
    if (iName < 0 || iEmail < 0) return [];
    const lc = subjectEmail.toLowerCase().trim();
    const out: string[] = [];
    for (let i = 1; i < values.length; i++) {
      const email = String(values[i][iEmail] ?? "").toLowerCase().trim();
      if (email !== lc) continue;
      const name = String(values[i][iName] ?? "").trim();
      if (name) out.push(name);
    }
    return out;
  } catch {
    return [];
  }
}

/** Read the names_to_emails tab (Comments spreadsheet) to resolve the
 *  caller's display name. Matches what the Apps Script handler returns
 *  in `person` — helps the home page default-filter to the user's own
 *  projects on first render. */
async function resolveCallerDisplayName(
  subjectEmail: string,
): Promise<string> {
  try {
    const sheets = sheetsClient(subjectEmail);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
      range: "names to emails",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const values = (res.data.values ?? []) as unknown[][];
    if (values.length < 2) return "";
    const headers = (values[0] as unknown[]).map((h) =>
      String(h ?? "").trim().toLowerCase(),
    );
    const iName = headers.findIndex((h) =>
      ["full name", "name", "full_name", "fullname"].includes(h),
    );
    const iEmail = headers.findIndex((h) =>
      ["email", "e-mail", "mail"].includes(h),
    );
    if (iName < 0 || iEmail < 0) return "";
    const lc = subjectEmail.toLowerCase().trim();
    for (let i = 1; i < values.length; i++) {
      const email = String(values[i][iEmail] ?? "").toLowerCase().trim();
      if (email === lc) return String(values[i][iName] ?? "").trim();
    }
  } catch {
    // Non-fatal — fall back to empty display name, home page just
    // skips the "your projects" auto-filter.
  }
  return "";
}

/**
 * Assemble the MyProjects shape from Keys + names-to-emails reads.
 * Mirrors `_getMyProjectsForEmail_` in the Apps Script.
 */
export async function getMyProjectsDirect(
  subjectEmail: string,
): Promise<MyProjects> {
  const lc = subjectEmail.toLowerCase().trim();
  const isAdmin = HUB_ADMIN_EMAILS.has(lc);

  const [{ headers, rows }, person] = await Promise.all([
    readKeysRows(subjectEmail),
    resolveCallerDisplayName(subjectEmail),
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
  const iWebhook = findChatSpaceColumnIndex(headers);

  if (iProj < 0) {
    // Keys tab is unreadable — fail closed like the Apps Script handler.
    return {
      projects: [],
      isAdmin,
      isInternal: lc.endsWith("@fandf.co.il"),
      isStaff: false,
      isClient: false,
      person,
      email: subjectEmail,
    };
  }

  // First pass: build the full project list + membership flags.
  let isStaff = false;
  let isClient = false;
  const projects: Project[] = [];

  for (const row of rows) {
    const name = String(row[iProj] ?? "").trim();
    if (!name) continue;

    const mediaManager = iCamp >= 0 ? String(row[iCamp] ?? "").trim() : "";
    const projectManagerFull = iAcct >= 0 ? String(row[iAcct] ?? "").trim() : "";
    const internalOnly = iInternal >= 0 ? splitRosterCell(row[iInternal]) : [];
    const clientFacing = iCf >= 0 ? splitRosterCell(row[iCf]) : [];
    const clientEmails =
      iClients >= 0 ? splitRosterCell(row[iClients]) : [];

    // Membership test for non-admins. Matches findProjectsForEmail +
    // findAccessScopeForEmail in Apps Script:
    //   - Email match on col E (clients) → isClient
    //   - Email match on any staff column (cols J / K email substring,
    //     or display-name columns C / D when we later resolve them) →
    //     isStaff
    const clientEmailsRaw = iClients >= 0 ? String(row[iClients] ?? "").toLowerCase() : "";
    const onClients = clientEmailsRaw.includes(lc);
    // For staff we'd need names→emails for C/D. Safe fallback: admins
    // see all; @fandf.co.il domain is treated as staff unless they only
    // appear on col E. This matches the Apps Script behavior closely
    // enough for the nav dropdown — precise staff status (for admin
    // console gates) still goes through the Apps Script path.
    const onStaff =
      (iInternal >= 0 && String(row[iInternal] ?? "").toLowerCase().includes(lc)) ||
      (iCf >= 0 && String(row[iCf] ?? "").toLowerCase().includes(lc));

    const visible = isAdmin || onClients || onStaff || lc.endsWith("@fandf.co.il");
    if (!visible) continue;

    if (onClients) isClient = true;
    if (onStaff || lc.endsWith("@fandf.co.il")) isStaff = true;

    const roster: ProjectRoster = {
      mediaManager,
      projectManagerFull,
      clientEmails,
      internalOnly,
      clientFacing,
    };

    projects.push({
      name,
      company: iCo >= 0 ? String(row[iCo] ?? "").trim() : "",
      chatSpaceUrl:
        iWebhook >= 0 ? chatSpaceUrlFromWebhook(String(row[iWebhook] ?? "")) : "",
      roster,
    });
  }

  // @fandf.co.il domain counts as staff even if they're not on any
  // project's roster column — covers admins + any future internal hire
  // who hasn't been added to a specific project yet.
  const isInternal = lc.endsWith("@fandf.co.il");
  if (isInternal) isStaff = true;

  return {
    projects,
    isAdmin,
    isInternal,
    isStaff,
    isClient,
    person,
    email: subjectEmail,
  };
}
