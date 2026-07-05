import { unstable_cache } from "next/cache";
import { driveClient, driveFolderOwner } from "@/lib/sa";

/**
 * Grants a project's client emails (Keys col E) native Drive access to
 * the media-plan so they can (a) COMMENT on the latest פריסה sheet in
 * Google Sheets, and (b) READ the parent פריסות folder to browse prior
 * plans (for finance / review).
 *
 * Mirrors `ensureProjectSharedFolder` (lib/driveSharedFolder.ts):
 *   - Idempotent: lists existing permissions, only `create`s what's
 *     missing, never removes (Keys col E is the additive source of truth).
 *   - Best-effort: per-email failures are logged, never thrown.
 *   - Cached via unstable_cache so it doesn't touch Drive on every
 *     project-page render — the grant fires once per (file, folder,
 *     emails) per TTL, then serves the cached result.
 *
 * Fired automatically from LatestPrisotCard for any project with client
 * emails; the SA (DRIVE_FOLDER_OWNER) performs the grant, so it runs
 * regardless of who's viewing. Folders accept only reader/writer (there
 * is no "commenter" role on a folder), so the folder grant is reader; the
 * file grant is commenter, downgrading to reader when the org's external-
 * sharing policy — or a non-Google email — rejects a commenter share.
 */

function cleanEmails(emails: string[]): string[] {
  const out = new Set<string>();
  for (const e of emails) {
    const lc = String(e || "").toLowerCase().trim();
    if (lc && lc.includes("@")) out.add(lc);
  }
  return Array.from(out).sort();
}

async function listPermittedEmails(
  drive: ReturnType<typeof driveClient>,
  fileId: string,
): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    let pageToken: string | undefined;
    do {
      const res = await drive.permissions.list({
        fileId,
        fields: "nextPageToken, permissions(id,type,role,emailAddress)",
        supportsAllDrives: true,
        pageSize: 100,
        pageToken,
      });
      for (const p of res.data.permissions ?? []) {
        const e = (p.emailAddress || "").toLowerCase().trim();
        if (e) set.add(e);
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  } catch (e) {
    console.log(
      "[driveClientAccess] permissions.list failed (will still try to add):",
      e instanceof Error ? e.message : String(e),
    );
  }
  return set;
}

export type PrisaClientAccess = {
  /** Emails newly granted commenter on the file this run. */
  fileCommenters: string[];
  /** Emails granted reader on the file (commenter rejected → downgraded). */
  fileReaders: string[];
  /** Emails newly granted reader on the folder this run. */
  folderReaders: string[];
  failures: { email: string; where: "file" | "folder"; reason: string }[];
};

const EMPTY: PrisaClientAccess = {
  fileCommenters: [],
  fileReaders: [],
  folderReaders: [],
  failures: [],
};

async function ensureInner(
  fileId: string,
  folderId: string,
  clientEmails: string[],
): Promise<PrisaClientAccess> {
  const subject = driveFolderOwner();
  if (!subject) return EMPTY;
  const desired = cleanEmails(clientEmails);
  if (!fileId || desired.length === 0) return EMPTY;
  const drive = driveClient(subject);
  const out: PrisaClientAccess = {
    fileCommenters: [],
    fileReaders: [],
    folderReaders: [],
    failures: [],
  };

  // File → commenter (fall back to reader if commenter is rejected).
  const onFile = await listPermittedEmails(drive, fileId);
  for (const email of desired.filter((e) => !onFile.has(e))) {
    try {
      await drive.permissions.create({
        fileId,
        sendNotificationEmail: false,
        supportsAllDrives: true,
        requestBody: { type: "user", role: "commenter", emailAddress: email },
      });
      out.fileCommenters.push(email);
    } catch (e) {
      // Policy / non-Google account rejected commenter — give reader so
      // the client can at least view natively, and record the downgrade.
      try {
        await drive.permissions.create({
          fileId,
          sendNotificationEmail: false,
          supportsAllDrives: true,
          requestBody: { type: "user", role: "reader", emailAddress: email },
        });
        out.fileReaders.push(email);
        console.log(
          `[driveClientAccess] commenter rejected for ${email} on file ${fileId}, granted reader: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      } catch (e2) {
        out.failures.push({
          email,
          where: "file",
          reason: e2 instanceof Error ? e2.message : String(e2),
        });
      }
    }
  }

  // Folder → reader (folders don't accept a "commenter" role).
  if (folderId) {
    const onFolder = await listPermittedEmails(drive, folderId);
    for (const email of desired.filter((e) => !onFolder.has(e))) {
      try {
        await drive.permissions.create({
          fileId: folderId,
          sendNotificationEmail: false,
          supportsAllDrives: true,
          requestBody: { type: "user", role: "reader", emailAddress: email },
        });
        out.folderReaders.push(email);
      } catch (e) {
        out.failures.push({
          email,
          where: "folder",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  return out;
}

/** Cache key = (fileId, folderId, sortedEmails); a Keys col E edit or a
 *  new latest פריסה busts it. 30-min TTL keeps steady-state cost near
 *  zero while letting a fresh client email propagate within the window. */
const _cached = unstable_cache(
  (fileId: string, folderId: string, emailsKey: string) => {
    const emails = emailsKey ? emailsKey.split(",") : [];
    return ensureInner(fileId, folderId, emails);
  },
  ["prisa-client-access"],
  { revalidate: 30 * 60, tags: ["prisa-client-access"] },
);

export async function ensurePrisaClientAccess(
  fileId: string,
  folderId: string,
  clientEmails: string[],
): Promise<PrisaClientAccess> {
  const f = (fileId || "").trim();
  if (!f) return EMPTY;
  const emailsKey = cleanEmails(clientEmails).join(",");
  if (!emailsKey) return EMPTY;
  return _cached(f, (folderId || "").trim(), emailsKey);
}
