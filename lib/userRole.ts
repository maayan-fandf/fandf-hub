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
import { readKeysCached } from "@/lib/keys";
import { classifyRoleText, type UserRole } from "@/lib/userRoleHelpers";

export type { UserRole } from "@/lib/userRoleHelpers";

const ROLE_CACHE = new Map<
  string,
  { role: UserRole; roleText: string; expiresAt: number }
>();
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
  const { headers, rows } = await readKeysCached(subjectEmail);
  if (rows.length === 0) return "unknown";
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

  // readKeysCached returns rows already stripped of the header — iterate
  // directly. The original implementation read raw values and used
  // rows.slice(1) to skip the header itself.
  for (const row of rows) {
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

/**
 * Internal: returns BOTH the classified role and the raw role text for
 * a user, with a single cache lookup. The raw text is needed for
 * predicates that need to distinguish sub-roles within a family — e.g.
 * `canSeeCampaigns` wants media buyers (currently classified as
 * "creative") in, but designers (also "creative") out, which can only
 * be determined from the raw text.
 */
async function lookupRoleAndText(
  subjectEmail: string,
): Promise<{ role: UserRole; roleText: string }> {
  const lc = subjectEmail.toLowerCase().trim();
  if (!lc) return { role: "unknown", roleText: "" };

  const cached = ROLE_CACHE.get(lc);
  if (cached && cached.expiresAt > Date.now()) {
    return { role: cached.role, roleText: cached.roleText };
  }

  // Admins are baked-in; skip the sheet reads.
  if (HUB_ADMIN_EMAILS.has(lc)) {
    ROLE_CACHE.set(lc, {
      role: "admin",
      roleText: "",
      expiresAt: Date.now() + TTL_MS,
    });
    return { role: "admin", roleText: "" };
  }

  let role: UserRole = "unknown";
  let roleText = "";
  try {
    const lookup = await lookupNamesAndRole(subjectEmail);
    roleText = lookup.roleText;
    // Prefer the explicit Role text when it classifies cleanly.
    const fromText = classifyRoleText(roleText);
    if (fromText !== "unknown") {
      role = fromText;
    } else if (lookup.names.length) {
      role = await inferRoleFromKeys(subjectEmail, lookup.names);
    }
  } catch (e) {
    console.log(
      "[userRole] detection failed; falling back to unknown:",
      e instanceof Error ? e.message : String(e),
    );
  }

  ROLE_CACHE.set(lc, { role, roleText, expiresAt: Date.now() + TTL_MS });
  return { role, roleText };
}

export async function getUserRole(subjectEmail: string): Promise<UserRole> {
  const { role } = await lookupRoleAndText(subjectEmail);
  return role;
}

/**
 * Predicate for the top-nav קמפיינים link + the /morning page +
 * /api/morning/count badge. True when the user is one of:
 *
 *   - admin (HUB_ADMIN_EMAILS)
 *   - manager (campaign / account / project / client managers — the
 *     "manager" role family covers all of those)
 *   - media — has role text matching /media|מדיה/, even though
 *     classifyRoleText lumps them into "creative". The classified
 *     family alone can't distinguish media buyers (do care about
 *     campaign performance) from designers / copywriters (don't),
 *     so this predicate looks at the raw text in addition to the
 *     classified role.
 *
 * Designers, copywriters, illustrators, and other non-media creatives
 * see neither the link nor the badge. The /morning page itself shows
 * a "not for your role" empty state if they navigate directly.
 */
export async function canSeeCampaigns(subjectEmail: string): Promise<boolean> {
  const { role, roleText } = await lookupRoleAndText(subjectEmail);
  if (role === "admin" || role === "manager") return true;
  if (/\bmedia\b|מדיה/i.test(roleText)) return true;
  return false;
}
