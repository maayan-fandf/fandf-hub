/**
 * Detect a user's "primary role" so the tasks page can pick a smart
 * default filter (assignee=me for creatives, approver=me for managers,
 * etc.).
 *
 * Role detection walks two sources:
 *
 * 1. The `names to emails` sheet maps email → display name + role text.
 *    A "Role" column is the user-controlled source of truth — when set,
 *    we trust it.
 *
 * 2. Fallback: scan the Keys tab. The user's display name(s) are
 *    matched against:
 *      - cols C / D ("מנהל קמפיינים", "EMAIL Manager") → manager
 *      - cols J / K ("Access — internal only", "Client-facing") → creative
 *      - col E ("Email Client") → client (matches by email, not name)
 *
 * We pick the first role found in priority order (creative > manager >
 * client) since a person can wear multiple hats across different
 * projects but the tasks page wants a single default.
 *
 * Result is cached in-process for 5 minutes per email — role rarely
 * changes; a hub instance restart picks up updates immediately.
 */

import { sheetsClient } from "@/lib/sa";
import { HUB_ADMIN_EMAILS } from "@/lib/tasksDirect";
import { classifyRoleText, type UserRole } from "@/lib/userRoleHelpers";

export type { UserRole } from "@/lib/userRoleHelpers";

const ROLE_CACHE = new Map<string, { role: UserRole; expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000;

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const KEYS_HEADER_CLEAN = /[\u200B-\u200F\u202A-\u202E\u2060\u00AD\uFEFF\uD800-\uDFFF]/g;

/**
 * Returns every display name registered against `subjectEmail` in the
 * `names to emails` sheet, plus the matched role text (if any).
 */
async function lookupNamesAndRole(
  subjectEmail: string,
): Promise<{ names: string[]; roleText: string }> {
  const sheets = sheetsClient(subjectEmail);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
    range: "names to emails",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = (res.data.values ?? []) as unknown[][];
  if (rows.length < 2) return { names: [], roleText: "" };
  const headers = (rows[0] as unknown[]).map((h) =>
    String(h ?? "").trim().toLowerCase(),
  );
  const iName = headers.findIndex((h) =>
    /^(full name|name|full_name|שם)$/.test(h),
  );
  const iEmail = headers.findIndex((h) => /^(email|e-mail|mail|דוא"?ל)$/.test(h));
  const iRole = headers.findIndex((h) => /^(role|תפקיד|job|title)$/.test(h));
  if (iName < 0 || iEmail < 0) return { names: [], roleText: "" };

  const target = subjectEmail.toLowerCase().trim();
  const names: string[] = [];
  let roleText = "";
  for (const row of rows.slice(1)) {
    const email = String(row[iEmail] ?? "").toLowerCase().trim();
    if (email !== target) continue;
    const name = String(row[iName] ?? "").trim();
    if (name) names.push(name);
    if (!roleText && iRole >= 0) {
      roleText = String(row[iRole] ?? "").trim();
    }
  }
  return { names, roleText };
}

/**
 * Scan Keys for any row that lists this user (by name in C/D/J/K, or
 * by email in E). Returns the first matching role family in priority
 * order: creative > manager > client.
 */
async function inferRoleFromKeys(
  subjectEmail: string,
  displayNames: string[],
): Promise<UserRole> {
  const sheets = sheetsClient(subjectEmail);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: envOrThrow("SHEET_ID_MAIN"),
    range: "Keys",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = (res.data.values ?? []) as unknown[][];
  if (rows.length < 2) return "unknown";
  const headers = (rows[0] as unknown[]).map((h) =>
    String(h ?? "")
      .replace(KEYS_HEADER_CLEAN, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const iCampMgr = headers.indexOf("מנהל קמפיינים");
  const iAcctMgr =
    headers.indexOf("EMAIL Manager") >= 0
      ? headers.indexOf("EMAIL Manager")
      : headers.indexOf("Email Manager");
  const iClient = headers.indexOf("Email Client");
  const iInternal = headers.indexOf("Access — internal only");
  const iCf = headers.indexOf("Client-facing");

  const lc = subjectEmail.toLowerCase().trim();
  const lcNames = displayNames
    .map((n) => n.toLowerCase().trim())
    .filter(Boolean);

  let isCreative = false;
  let isManager = false;
  let isClient = false;

  for (const row of rows.slice(1)) {
    if (!isManager) {
      for (const ci of [iCampMgr, iAcctMgr]) {
        if (ci < 0) continue;
        const cell = String(row[ci] ?? "").toLowerCase().trim();
        if (cell && lcNames.includes(cell)) {
          isManager = true;
          break;
        }
      }
    }
    if (!isCreative) {
      for (const ci of [iInternal, iCf]) {
        if (ci < 0) continue;
        const csv = String(row[ci] ?? "")
          .toLowerCase()
          .split(/[,;\n]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (lcNames.some((n) => csv.includes(n))) {
          isCreative = true;
          break;
        }
      }
    }
    if (!isClient && iClient >= 0) {
      const csv = String(row[iClient] ?? "")
        .toLowerCase()
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (csv.includes(lc)) isClient = true;
    }
    if (isCreative && isManager && isClient) break;
  }

  if (isCreative) return "creative";
  if (isManager) return "manager";
  if (isClient) return "client";
  return "unknown";
}

export async function getUserRole(subjectEmail: string): Promise<UserRole> {
  const lc = subjectEmail.toLowerCase().trim();
  if (!lc) return "unknown";

  const cached = ROLE_CACHE.get(lc);
  if (cached && cached.expiresAt > Date.now()) return cached.role;

  // Admins are baked-in; skip the sheet reads.
  if (HUB_ADMIN_EMAILS.has(lc)) {
    ROLE_CACHE.set(lc, { role: "admin", expiresAt: Date.now() + TTL_MS });
    return "admin";
  }

  let role: UserRole = "unknown";
  try {
    const { names, roleText } = await lookupNamesAndRole(subjectEmail);
    // Prefer the explicit Role text when it classifies cleanly.
    const fromText = classifyRoleText(roleText);
    if (fromText !== "unknown") {
      role = fromText;
    } else if (names.length) {
      role = await inferRoleFromKeys(subjectEmail, names);
    }
  } catch (e) {
    console.log(
      "[userRole] detection failed; falling back to unknown:",
      e instanceof Error ? e.message : String(e),
    );
  }

  ROLE_CACHE.set(lc, { role, expiresAt: Date.now() + TTL_MS });
  return role;
}
