/**
 * Continuous Chat-space membership reconcile.
 *
 * Owner decision 2026-05-18: every project's internal Chat space
 * membership must stay synced to EXACTLY who is assigned to the
 * project in Keys (cols C/D/J/K, @fandf-only). Roster-ONLY — system
 * admins are NOT blanket-members (an admin is in a space only if
 * they're on that project's row). Fully automatic via a cron
 * (/api/cron/sync-chat-spaces): adds missing roster members AND
 * removes anyone no longer on the roster.
 *
 * GATED on useRestrictedChatSpaces() (the same master flag as the
 * restricted-create path) → dormant by default. Nothing here runs
 * until the owner flips USE_RESTRICTED_CHAT_SPACES=1, which must only
 * happen AFTER the chat.memberships DWD scope is granted.
 *
 * SAFETY RAILS (per memory/feedback_reconciliation_iteration.md — a
 * transient Keys/names read glitch must NEVER silently empty a space):
 *  - names→emails map empty/failed ⇒ ABORT the whole run (every space
 *    would otherwise compute an empty intended set → mass removal).
 *  - members.list fails for a space ⇒ skip that space (never remove
 *    against an unknown current set).
 *  - intended set empty for a space ⇒ skip removals for that space
 *    (blank Keys roster cells are a data issue, not "remove everyone").
 *  - removals for a space exceed MAX_REMOVALS or >50% of current
 *    humans ⇒ skip that space's removals (likely a glitch; adds still
 *    apply). Loud log either way.
 *  - NEVER remove: space managers (ROLE_MANAGER — structural Chat
 *    requirement, not an admin exception), non-HUMAN members
 *    (apps/bots), or the operating identity.
 *  - chat.memberships scope missing (403/unauthorized_client) ⇒ ABORT
 *    the run (surfaces the missing scope; no point continuing).
 */

import { sheetsClient, chatMembershipsClient, driveFolderOwner } from "@/lib/sa";
import { useRestrictedChatSpaces, chatSpaceSyncDryRun } from "@/lib/sa";
import { readKeysCached, findChatSpaceColumnIndex } from "@/lib/keys";
import {
  parseSpaceId,
  lookupUserGaiaResource,
  lookupEmailByGaiaResource,
} from "@/lib/chat";

/** Hard cap on removals per space per run — a glitch guard, not a
 *  product limit (real roster churn is 0–2 people at a time). */
const MAX_REMOVALS_PER_SPACE = 8;
/** Also skip removals if they'd cut more than this fraction of the
 *  space's current human members (catches "intended set is wrong"). */
const MAX_REMOVAL_FRACTION = 0.5;

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export type ChatSpaceSyncSummary = {
  ok: boolean;
  skipped?: string;
  /** When true, NOTHING was mutated — counts below are the PLAN. */
  dryRun: boolean;
  spacesSeen: number;
  spacesReconciled: number;
  spacesSkipped: number;
  /** Members actually added (0 in dry-run). */
  added: number;
  /** Members actually removed (0 in dry-run). */
  removed: number;
  /** What WOULD be added/removed (populated in both modes). */
  plannedAdds: number;
  plannedRemovals: number;
  /** Spaces whose removals were suppressed by a safety rail. */
  removalsSuppressed: { space: string; reason: string }[];
  /** Per-space audit detail (resolved emails) — the reviewable plan.
   *  `removes` is what WOULD be removed (even if a rail suppressed it
   *  this run — cross-reference removalsSuppressed). Only spaces with
   *  a non-empty add/remove plan are listed. */
  plan: {
    project: string;
    space: string;
    adds: string[];
    removes: string[];
    removalsSuppressed?: string;
  }[];
  scopeMissing: boolean;
  errors: string[];
};

let inFlight: Promise<ChatSpaceSyncSummary> | null = null;

/** Re-entrancy guard, mirrors pollTasks. */
export async function reconcileAllChatSpaces(): Promise<ChatSpaceSyncSummary> {
  if (!useRestrictedChatSpaces()) {
    return {
      ok: true,
      skipped: "USE_RESTRICTED_CHAT_SPACES off",
      dryRun: chatSpaceSyncDryRun(),
      spacesSeen: 0,
      spacesReconciled: 0,
      spacesSkipped: 0,
      added: 0,
      removed: 0,
      plannedAdds: 0,
      plannedRemovals: 0,
      removalsSuppressed: [],
      plan: [],
      scopeMissing: false,
      errors: [],
    };
  }
  if (inFlight) return inFlight;
  inFlight = run();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Read the `names to emails` map (display name → email). Empty map is
 *  treated as a hard failure by the caller (abort) since it would make
 *  every intended set empty. */
async function readNameToEmail(
  adminEmail: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const sheets = sheetsClient(adminEmail);
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
    range: "names to emails",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const values = (r.data.values ?? []) as unknown[][];
  if (values.length < 2) return map;
  const headers = (values[0] as unknown[]).map((h) =>
    String(h ?? "").trim().toLowerCase(),
  );
  const iName = headers.findIndex((h) =>
    ["full name", "name", "full_name", "fullname"].includes(h),
  );
  const iEmail = headers.findIndex((h) =>
    ["email", "e-mail", "mail"].includes(h),
  );
  if (iName < 0 || iEmail < 0) return map;
  for (let i = 1; i < values.length; i++) {
    const name = String(values[i][iName] ?? "").trim().toLowerCase();
    const email = String(values[i][iEmail] ?? "").trim().toLowerCase();
    if (name && email) map.set(name, email);
  }
  return map;
}

function resolveToken(token: string, nameToEmail: Map<string, string>): string {
  const t = token.trim();
  if (!t) return "";
  if (t.includes("@")) return t.toLowerCase();
  return nameToEmail.get(t.toLowerCase()) || "";
}

function splitCell(cell: string): string[] {
  return cell
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Keys roster cells (C/D/J/K) → intended @fandf member emails. */
function intendedEmailsFromRow(
  row: unknown[],
  cols: { iCamp: number; iAcct: number; iInternal: number; iCf: number },
  nameToEmail: Map<string, string>,
): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const e = resolveToken(raw, nameToEmail);
    if (e && e.endsWith("@fandf.co.il")) out.add(e);
  };
  if (cols.iCamp >= 0) add(String(row[cols.iCamp] ?? ""));
  if (cols.iAcct >= 0) add(String(row[cols.iAcct] ?? ""));
  if (cols.iInternal >= 0)
    for (const n of splitCell(String(row[cols.iInternal] ?? ""))) add(n);
  if (cols.iCf >= 0)
    for (const n of splitCell(String(row[cols.iCf] ?? ""))) add(n);
  return [...out];
}

type Membership = {
  name?: string | null; // spaces/X/members/Y
  role?: string | null; // ROLE_MEMBER | ROLE_MANAGER
  member?: {
    name?: string | null; // users/<gaia>
    type?: string | null; // HUMAN | BOT
  } | null;
};

async function listSpaceMembers(
  chat: ReturnType<typeof chatMembershipsClient>,
  spaceResource: string,
): Promise<Membership[]> {
  const all: Membership[] = [];
  let pageToken: string | undefined;
  do {
    const res = await chat.spaces.members.list({
      parent: spaceResource,
      pageSize: 100,
      pageToken,
    });
    for (const m of res.data.memberships ?? []) all.push(m as Membership);
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);
  return all;
}

function isScopeMissing(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const code =
    (e as { code?: number; response?: { status?: number } }).code ??
    (e as { response?: { status?: number } }).response?.status;
  return (
    code === 403 ||
    /unauthorized_client/i.test(msg) ||
    /client not authorized/i.test(msg) ||
    /PERMISSION_DENIED/i.test(msg)
  );
}

async function run(): Promise<ChatSpaceSyncSummary> {
  const dryRun = chatSpaceSyncDryRun();
  const summary: ChatSpaceSyncSummary = {
    ok: true,
    dryRun,
    spacesSeen: 0,
    spacesReconciled: 0,
    spacesSkipped: 0,
    added: 0,
    removed: 0,
    plannedAdds: 0,
    plannedRemovals: 0,
    removalsSuppressed: [],
    plan: [],
    scopeMissing: false,
    errors: [],
  };
  // Canonical operating identity — same one that creates/owns hub
  // spaces. It is the space manager, so it's structurally protected
  // from removal below (and also explicitly).
  const adminEmail = driveFolderOwner();

  // GUARD: names→emails must load and be non-empty. An empty map would
  // make every intended set empty → mass removal everywhere. Abort.
  let nameToEmail: Map<string, string>;
  try {
    nameToEmail = await readNameToEmail(adminEmail);
  } catch (e) {
    summary.ok = false;
    summary.errors.push(
      "ABORT: names→emails read failed: " +
        (e instanceof Error ? e.message : String(e)),
    );
    return summary;
  }
  if (nameToEmail.size === 0) {
    summary.ok = false;
    summary.errors.push(
      "ABORT: names→emails map empty — refusing to reconcile (would mass-remove)",
    );
    return summary;
  }

  let keys: { headers: string[]; rows: unknown[][] };
  try {
    keys = await readKeysCached(adminEmail);
  } catch (e) {
    summary.ok = false;
    summary.errors.push(
      "ABORT: Keys read failed: " +
        (e instanceof Error ? e.message : String(e)),
    );
    return summary;
  }
  const { headers, rows } = keys;
  const iChat = findChatSpaceColumnIndex(headers);
  const iProj = headers.indexOf("פרוייקט");
  if (iChat < 0 || iProj < 0) {
    summary.ok = false;
    summary.errors.push("ABORT: Keys missing פרוייקט or Chat Space column");
    return summary;
  }
  const cols = {
    iCamp: headers.indexOf("מנהל קמפיינים"),
    iAcct:
      headers.indexOf("EMAIL Manager") >= 0
        ? headers.indexOf("EMAIL Manager")
        : headers.indexOf("EMAIL"),
    iInternal: headers.indexOf("Access — internal only"),
    iCf: headers.indexOf("Client-facing"),
  };

  const chat = chatMembershipsClient(adminEmail);
  const opResource = await lookupUserGaiaResource(adminEmail, adminEmail);

  for (const row of rows) {
    const spaceId = parseSpaceId(String(row[iChat] ?? "").trim());
    if (!spaceId) continue;
    summary.spacesSeen++;
    const project = String(row[iProj] ?? "").trim();
    const label = `${project || "?"} (spaces/${spaceId})`;
    const spaceResource = `spaces/${spaceId}`;

    try {
      const intendedEmails = intendedEmailsFromRow(row, cols, nameToEmail);
      const intendedResources = new Set<string>();
      for (const email of intendedEmails) {
        const res = await lookupUserGaiaResource(adminEmail, email);
        if (res) intendedResources.add(res);
      }

      // Current membership (must succeed — no blind removal).
      let members: Membership[];
      try {
        members = await listSpaceMembers(chat, spaceResource);
      } catch (e) {
        if (isScopeMissing(e)) {
          summary.scopeMissing = true;
          summary.ok = false;
          summary.errors.push(
            "ABORT: chat.memberships scope missing (list) at " + label,
          );
          return summary;
        }
        summary.spacesSkipped++;
        summary.errors.push(`skip ${label}: members.list failed`);
        continue;
      }

      const humans = members.filter(
        (m) => (m.member?.type ?? "HUMAN") === "HUMAN" && m.member?.name,
      );
      const currentResources = new Set(
        humans.map((m) => m.member!.name as string),
      );

      // Adds: intended emails not already present. We re-resolve the
      // gaia resource (cached) to test membership; if it didn't
      // resolve we still attempt the add — Chat resolves users/<email>
      // server-side and the create call is idempotent (409 = success).
      const addEmails: string[] = [];
      for (const email of intendedEmails) {
        const res = await lookupUserGaiaResource(adminEmail, email);
        if (res && currentResources.has(res)) continue; // already in
        addEmails.push(email);
      }

      // Removals: current humans not in the intended set, excluding
      // protected memberships.
      const removable = humans.filter((m) => {
        if (m.role === "ROLE_MANAGER") return false; // creator/manager
        const r = m.member!.name as string;
        if (opResource && r === opResource) return false; // operating id
        return !intendedResources.has(r);
      });

      // SAFETY RAILS on removals.
      let doRemovals = true;
      let suppressReason = "";
      if (intendedResources.size === 0) {
        doRemovals = false;
        suppressReason = "intended set empty (blank Keys roster?)";
      } else if (removable.length > MAX_REMOVALS_PER_SPACE) {
        doRemovals = false;
        suppressReason = `removals ${removable.length} > cap ${MAX_REMOVALS_PER_SPACE}`;
      } else if (
        humans.length > 0 &&
        removable.length / humans.length > MAX_REMOVAL_FRACTION
      ) {
        doRemovals = false;
        suppressReason = `removals ${removable.length}/${humans.length} > ${MAX_REMOVAL_FRACTION}`;
      }
      if (!doRemovals && removable.length > 0) {
        summary.removalsSuppressed.push({ space: label, reason: suppressReason });
        console.log(
          `[chatSpaceSync] SUPPRESSED removals for ${label}: ${suppressReason} (would have removed ${removable.length})`,
        );
      }

      // Plan log (both modes) — the per-space audit artifact.
      if (addEmails.length || removable.length) {
        console.log(
          `[chatSpaceSync]${dryRun ? "[DRYRUN]" : ""} ${label}: ` +
            `+${addEmails.length} [${addEmails.join(", ")}] ` +
            `-${doRemovals ? removable.length : 0}` +
            (doRemovals
              ? ` [${removable.map((m) => m.member?.name).join(", ")}]`
              : ` (removals suppressed)`),
        );
      }

      // Structured per-space audit detail — resolve the removal
      // targets (users/<gaiaId>) to emails so the plan is reviewable
      // without log-diving. Best-effort: fall back to the raw resource
      // when the directory lookup can't resolve it.
      if (addEmails.length || removable.length) {
        const removeEmails: string[] = [];
        for (const m of removable) {
          const rn = m.member?.name || "";
          const em = rn
            ? await lookupEmailByGaiaResource(adminEmail, rn)
            : "";
          removeEmails.push(em || rn || "(unknown)");
        }
        summary.plan.push({
          project: project || "?",
          space: `spaces/${spaceId}`,
          adds: addEmails,
          removes: removeEmails,
          ...(doRemovals ? {} : { removalsSuppressed: suppressReason }),
        });
      }

      // Adds (idempotent — 409 ALREADY_EXISTS is success). dry-run
      // counts the plan and mutates nothing.
      summary.plannedAdds += addEmails.length;
      if (!dryRun) {
        for (const email of addEmails) {
          try {
            await chat.spaces.members.create({
              parent: spaceResource,
              requestBody: {
                member: { name: `users/${email}`, type: "HUMAN" },
              },
            });
            summary.added++;
          } catch (e) {
            if (isScopeMissing(e)) {
              summary.scopeMissing = true;
              summary.ok = false;
              summary.errors.push(
                "ABORT: chat.memberships scope missing (add) at " + label,
              );
              return summary;
            }
            const msg = e instanceof Error ? e.message : String(e);
            if (/already.*member|already.*exist/i.test(msg)) continue;
            summary.errors.push(`add ${email} @ ${label}: ${msg}`);
          }
        }
      }

      // Removals (only if rails passed). dry-run counts the plan and
      // mutates nothing.
      if (doRemovals) {
        summary.plannedRemovals += removable.length;
        if (!dryRun) {
          for (const m of removable) {
            try {
              await chat.spaces.members.delete({ name: m.name as string });
              summary.removed++;
            } catch (e) {
              if (isScopeMissing(e)) {
                summary.scopeMissing = true;
                summary.ok = false;
                summary.errors.push(
                  "ABORT: chat.memberships scope missing (delete) at " + label,
                );
                return summary;
              }
              const msg = e instanceof Error ? e.message : String(e);
              summary.errors.push(`remove @ ${label}: ${msg}`);
            }
          }
        }
      }

      summary.spacesReconciled++;
    } catch (e) {
      summary.spacesSkipped++;
      summary.errors.push(
        `skip ${label}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return summary;
}
