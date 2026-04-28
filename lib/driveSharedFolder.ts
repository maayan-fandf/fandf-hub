/**
 * Per-project "תיקיה משותפת" — the single Drive folder under each
 * project that's explicitly shared with the project's client emails
 * (Keys col E). Lives at:
 *
 *     <Shared Drive> / <company> / <project> / <project> תיקיה משותפת
 *
 * The Shared Drive itself is internal-only; this folder is the one
 * place a client gets explicit Drive permissions to. The project page
 * renders the "Drive" button for client viewers pointing here so they
 * land somewhere they can actually open + write to.
 *
 * Idempotent end-to-end:
 *   - Creating the folder twice no-ops (find-or-create under the
 *     project root, same as `ensureCampaignFolderId`).
 *   - Permission grants check the folder's existing permission list
 *     and only `permissions.create` for emails that aren't on it yet.
 *   - We never *remove* permissions. Keys col E is the additive list;
 *     manually-added collaborators stay alone, matching the team's
 *     intuition that "removing a name from Keys" should be the
 *     operator's deliberate move (via Drive UI), not an auto-cleanup.
 *
 * Notification emails are suppressed (`sendNotificationEmail: false`)
 * — Drive's auto-notification email is noisy and the hub has its own
 * notification path. Clients learn about the folder via the project
 * page's Drive button.
 */

import { unstable_cache } from "next/cache";
import { driveClient, driveFolderOwner } from "@/lib/sa";
import { ensureCampaignFolderId } from "@/lib/driveFolders";

/** Suffix appended to the project name. The full folder name is
 *  `<project> ${SHARED_SUFFIX}`. Plays well with RTL — the suffix
 *  comes after the project name visually too. */
export const SHARED_FOLDER_SUFFIX = "תיקיה משותפת";

/** Returns the canonical "shared folder" name for a given project. */
export function sharedFolderNameForProject(project: string): string {
  return `${project.trim()} ${SHARED_FOLDER_SUFFIX}`;
}

/** True when `name` matches the `<project> תיקיה משותפת` pattern.
 *  Used by the campaigns picker to filter this special folder out
 *  of the campaigns list (it's not a campaign — it's a permissions
 *  surface). */
export function isSharedFolderName(name: string): boolean {
  const trimmed = (name || "").trim();
  if (!trimmed.endsWith(` ${SHARED_FOLDER_SUFFIX}`)) return false;
  // Guard against an exact-suffix folder with no project name prefix.
  return trimmed.length > SHARED_FOLDER_SUFFIX.length + 1;
}

export type ProjectSharedFolder = {
  folderId: string;
  viewUrl: string;
  /** Lower-cased, deduped client emails the helper attempted to grant
   *  on this run (whether they were already-present or newly added). */
  desiredClientEmails: string[];
  /** Subset of `desiredClientEmails` that the helper actually added
   *  during this run — useful for telemetry / debugging. */
  added: string[];
};

function cleanEmails(emails: string[]): string[] {
  const out = new Set<string>();
  for (const e of emails) {
    const lc = String(e || "").toLowerCase().trim();
    if (lc && lc.includes("@")) out.add(lc);
  }
  return Array.from(out).sort();
}

async function ensureInner(
  company: string,
  project: string,
  clientEmails: string[],
): Promise<ProjectSharedFolder> {
  const subject = driveFolderOwner();
  if (!subject) {
    throw new Error("DRIVE_FOLDER_OWNER not set");
  }
  const folderName = sharedFolderNameForProject(project);
  // ensureCampaignFolderId handles all three levels (company → project
  // → leaf) idempotently. Reusing it instead of re-walking the tree
  // keeps the path-walk logic in a single place.
  const ref = await ensureCampaignFolderId(subject, {
    company,
    project,
    campaign: folderName,
  });
  const drive = driveClient(subject);

  // Pull the existing permissions so we only `create` what's missing.
  // permissions.list paginates; the limit per page is 100 — we expect
  // ≤10 client emails per project so one page is plenty, but the loop
  // covers the long-tail case where a project has many manual perms.
  const existing = new Set<string>();
  try {
    let pageToken: string | undefined;
    do {
      const res = await drive.permissions.list({
        fileId: ref.folderId,
        fields: "nextPageToken, permissions(id,type,emailAddress)",
        supportsAllDrives: true,
        pageSize: 100,
        pageToken,
      });
      for (const p of res.data.permissions ?? []) {
        const e = (p.emailAddress || "").toLowerCase().trim();
        if (e) existing.add(e);
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  } catch (e) {
    console.log(
      "[driveSharedFolder] permissions.list failed (will still try to add):",
      e instanceof Error ? e.message : String(e),
    );
  }

  const desired = cleanEmails(clientEmails);
  const toAdd = desired.filter((e) => !existing.has(e));
  const added: string[] = [];
  for (const email of toAdd) {
    try {
      await drive.permissions.create({
        fileId: ref.folderId,
        sendNotificationEmail: false,
        supportsAllDrives: true,
        requestBody: {
          role: "writer",
          type: "user",
          emailAddress: email,
        },
      });
      added.push(email);
    } catch (e) {
      console.log(
        `[driveSharedFolder] permissions.create failed for ${email}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return {
    folderId: ref.folderId,
    viewUrl: ref.viewUrl,
    desiredClientEmails: desired,
    added,
  };
}

/** Cached wrapper. Cache key is `(company, project, sortedEmails)` so
 *  a Keys col E edit busts the cache for the next page load. 5-min
 *  TTL keeps the steady-state cost low while letting permission edits
 *  propagate quickly. Cache tag `project-shared-folder` lets us
 *  manually invalidate from a future admin action. */
const _cached = unstable_cache(
  (company: string, project: string, emailsKey: string) => {
    const emails = emailsKey ? emailsKey.split(",") : [];
    return ensureInner(company, project, emails);
  },
  ["project-shared-folder"],
  { revalidate: 5 * 60, tags: ["project-shared-folder"] },
);

export async function ensureProjectSharedFolder(
  company: string,
  project: string,
  clientEmails: string[],
): Promise<ProjectSharedFolder> {
  const co = (company || "").trim();
  const proj = (project || "").trim();
  if (!proj) throw new Error("project required");
  const emailsKey = cleanEmails(clientEmails).join(",");
  return _cached(co, proj, emailsKey);
}
