/**
 * Pure helper for the Drive Desktop local-path string. Lives in its
 * own module — NO server-side imports — because it's consumed by both
 * server pages AND a "use client" component (TasksQueue per-row
 * button). When this lived in lib/driveFolders.ts it transitively
 * pulled `googleapis` into the client bundle through driveFolders' own
 * imports, which OOM'd `next build` (webpack chasing a 40MB+ module
 * graph for what's a 25-line string-builder).
 *
 * Path shape (in-Drive suffix identical, mount points differ):
 *   Windows: `G:\Shared drives\<driveName>\<company>\<project>[\<campaign>]`
 *   macOS:   `~/Library/CloudStorage/GoogleDrive-<userEmail>/Shared drives/<driveName>/<company>/<project>[/<campaign>]`
 *
 * Stops at the campaign level on purpose — the per-task subfolder
 * isn't recoverable from a Drive web URL, so we land Explorer/Finder
 * one step up and let the user drill in. Both strings empty when
 * driveName or project is missing; mac is empty when userEmail is
 * missing (`~` expands in Finder's "Go to Folder" so we don't need
 * to know the local Mac username).
 */
export function buildLocalDrivePaths(opts: {
  driveName: string;
  company?: string;
  project: string;
  campaign?: string;
  userEmail?: string;
}): { windows: string; mac: string } {
  const { driveName, company = "", project, campaign = "", userEmail = "" } =
    opts;
  if (!driveName || !project) return { windows: "", mac: "" };
  const tailParts = [driveName, company, project];
  if (campaign) tailParts.push(campaign);
  const winTail = tailParts.join("\\");
  const macTail = tailParts.join("/");
  const windows = `G:\\Shared drives\\${winTail}`;
  const mac = userEmail
    ? `~/Library/CloudStorage/GoogleDrive-${userEmail}/Shared drives/${macTail}`
    : "";
  return { windows, mac };
}
