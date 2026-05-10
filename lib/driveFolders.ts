/**
 * Drive-folder helpers shared by the task write path and the folder
 * picker UI.
 *
 * All ops target the same Shared Drive (env TASKS_SHARED_DRIVE_ID) the
 * task pipeline already uses. Impersonation uses the DRIVE_FOLDER_OWNER
 * so new folders land under the same team account.
 *
 * The "campaign folder" is the 3rd level of the hierarchy:
 *     <Shared Drive> / <company> / <project> / <campaign>
 * The picker scopes listings and creates to a campaign subtree.
 */

import type { drive_v3 } from "googleapis";
import { unstable_cache } from "next/cache";
import { driveClient, driveFolderOwner, sheetsClient } from "@/lib/sa";

export type FolderRef = {
  id: string;
  name: string;
  viewUrl: string;
};

export type FolderChild = {
  id: string;
  name: string;
  modifiedTime: string;
  hasChildren: boolean;
};

function tasksSharedDriveId(): string {
  const v = process.env.TASKS_SHARED_DRIVE_ID;
  if (!v) throw new Error("TASKS_SHARED_DRIVE_ID is not set");
  return v;
}

function driveFolderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${id}`;
}

/** Public alias of the internal `findFolder`. New external callers
 *  (lib/taskTemplates.ts, lib/draftFolders.ts) reuse this primitive
 *  rather than duplicating the q-string + driveId boilerplate. */
export async function findChildFolderByName(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
  sharedDriveId: string,
): Promise<string | null> {
  return findFolder(drive, parentId, name, sharedDriveId);
}

/** Public alias of the internal `getOrCreate`. */
export async function getOrCreateChildFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
  sharedDriveId: string,
): Promise<string> {
  return getOrCreate(drive, parentId, name, sharedDriveId);
}

/** Exposes the Shared Drive id so callers building their own queries
 *  don't need to duplicate the env-var read + null check. */
export function getTasksSharedDriveId(): string {
  return tasksSharedDriveId();
}

async function findFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
  sharedDriveId: string,
): Promise<string | null> {
  const safe = name.replace(/'/g, "\\'");
  const q = [
    "mimeType='application/vnd.google-apps.folder'",
    `name='${safe}'`,
    `'${parentId}' in parents`,
    "trashed=false",
  ].join(" and ");
  const res = await drive.files.list({
    q,
    fields: "files(id, name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: sharedDriveId,
  });
  return res.data.files?.[0]?.id ?? null;
}

async function createFolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
): Promise<FolderRef> {
  const safe = (name || "(unnamed)").replace(/[\\/]/g, "-");
  const created = await drive.files.create({
    requestBody: {
      name: safe,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id, name, webViewLink",
    supportsAllDrives: true,
  });
  const id = created.data.id;
  if (!id) throw new Error("Drive folder create returned no id");
  return {
    id,
    name: created.data.name || safe,
    viewUrl: created.data.webViewLink || driveFolderUrl(id),
  };
}

async function getOrCreate(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
  sharedDriveId: string,
): Promise<string> {
  const existing = await findFolder(drive, parentId, name, sharedDriveId);
  if (existing) return existing;
  const ref = await createFolder(drive, parentId, name);
  return ref.id;
}

/**
 * READ-ONLY lookup of the campaign folder at
 * `<company>/<project>/<campaign>` inside the Shared Drive. Returns
 * `null` for `folderId` if any segment is missing — the caller is
 * expected to treat this as "not yet — will be created at task save
 * time" and render an empty state.
 *
 * This is the function called by the picker UI on every company /
 * project / campaign change. It MUST NOT create folders — an earlier
 * version called `ensureCampaignFolderId` here, which meant every
 * keystroke in the campaign input silently materialized an empty
 * folder at the project level. The cleanup-prone bug was caught in
 * production testing on 2026-04-24.
 *
 * If `campaign` is empty, returns the project-level folder (or null if
 * the project folder itself doesn't exist yet).
 */
export async function findCampaignFolderId(
  subjectEmail: string,
  args: { company: string; project: string; campaign: string },
): Promise<{ folderId: string | null; viewUrl: string | null }> {
  const sharedDriveId = tasksSharedDriveId();
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  let parent: string | null = sharedDriveId;
  const co = args.company.trim();
  if (co) {
    parent = await findFolder(drive, parent, co, sharedDriveId);
    if (!parent) return { folderId: null, viewUrl: null };
  }
  const proj = args.project.trim() || "(no-project)";
  parent = await findFolder(drive, parent, proj, sharedDriveId);
  if (!parent) return { folderId: null, viewUrl: null };
  const campaign = args.campaign.trim();
  if (campaign) {
    parent = await findFolder(drive, parent, campaign, sharedDriveId);
    if (!parent) return { folderId: null, viewUrl: null };
  }
  return { folderId: parent, viewUrl: driveFolderUrl(parent) };
}

/**
 * Cached project-level folder URL lookup for the project-overview header
 * "Drive" button. Wraps `findCampaignFolderId` with an empty `campaign`
 * (i.e. resolves to the `<company>/<project>` folder) and caches the
 * result by `(company, project)` for 1h.
 *
 * The folder hierarchy almost never moves — companies/projects are
 * named once and their Drive folders persist. The previous direct
 * call did 2 sequential Drive API round-trips on every page load
 * (~400–1000ms uncached). With this wrapper, only the first hit per
 * hour pays that cost; subsequent hits are O(1).
 *
 * Drive folder IDs are global across users (shared-drive members
 * see the same hierarchy), so the cache key intentionally omits
 * `subjectEmail`. If a user lacks permission, the underlying call
 * returns `{ folderId: null, viewUrl: null }` — caller falls back
 * to the search URL, which works for everyone.
 */
const findProjectFolderUrlInner = unstable_cache(
  async (
    company: string,
    project: string,
  ): Promise<{ folderId: string | null; viewUrl: string | null }> => {
    return findCampaignFolderId(driveFolderOwner() || "", {
      company,
      project,
      campaign: "",
    });
  },
  ["project-folder-url"],
  { revalidate: 60 * 60, tags: ["drive-folders"] },
);

export async function findProjectFolderUrlCached(
  company: string,
  project: string,
): Promise<{ folderId: string | null; viewUrl: string | null }> {
  if (!company.trim() || !project.trim()) {
    return { folderId: null, viewUrl: null };
  }
  return findProjectFolderUrlInner(company.trim(), project.trim());
}

/**
 * Resolves (and creates if missing) the campaign folder. Only used on
 * task save — never from the picker UI directly. Before this was
 * split, the picker called this function on every keystroke in the
 * campaign input and filled Drive with partial-name folders.
 */
export async function ensureCampaignFolderId(
  subjectEmail: string,
  args: { company: string; project: string; campaign: string },
): Promise<{ folderId: string; viewUrl: string }> {
  const sharedDriveId = tasksSharedDriveId();
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  let parent = sharedDriveId;
  const co = args.company.trim();
  if (co) parent = await getOrCreate(drive, parent, co, sharedDriveId);
  parent = await getOrCreate(
    drive,
    parent,
    args.project.trim() || "(no-project)",
    sharedDriveId,
  );
  const campaign = args.campaign.trim();
  if (campaign) {
    parent = await getOrCreate(drive, parent, campaign, sharedDriveId);
  }
  return { folderId: parent, viewUrl: driveFolderUrl(parent) };
}

/**
 * Lists immediate subfolders of `parentId` inside the Shared Drive.
 * Results are sorted by modifiedTime desc so recent work surfaces first
 * in the picker. `hasChildren` is a coarse hint — we do one extra query
 * per parent (page-size 1) to check if any child folder exists, which is
 * cheap and avoids a chevron with no content behind it.
 */
/**
 * Returns the latest Google Sheet inside `<project>/פריסות/` for a project.
 * Used by the project-overview page to surface the most-recently-updated
 * "spread" file at a glance, instead of forcing the user to navigate the
 * Drive folder hierarchy. Returns `null` when:
 *   - the project's Drive folder doesn't exist yet
 *   - there's no `פריסות` subfolder
 *   - the subfolder has no Google Sheets
 *
 * Two Drive round-trips total: one to find the פריסות folder, one to
 * list its sheets ordered by modifiedTime desc with pageSize=1. Caller
 * is expected to wrap with React's `cache()` for per-request dedup —
 * we don't use unstable_cache because the multi-instance propagation
 * issue around drive lookups (see feedback_unstable_cache_multi_instance.md)
 * makes cross-request caching unreliable for files that change daily.
 */
export type LatestPrisot = {
  id: string;
  name: string;
  modifiedTime: string;
  webViewLink: string;
  thumbnailLink: string;
  /** Mime type from Drive — used by the card to choose between the
   *  HTML-table render (sheets), the inline image render (image/*),
   *  and the thumbnail fallback. */
  mimeType: string;
  /** YYYY-MM-DD if the filename contains a date, "" otherwise. The
   *  pickLatestPrisotForCompanyOrProject ranker prefers this over
   *  modifiedTime since users sometimes re-open old sheets without the
   *  data actually being more recent. */
  dateInName: string;
  /** Where the sheet was found — "project" = under the actual project's
   *  פריסות, "general" = the company's כללי project served as the
   *  fallback. Renders as a small badge in the UI. */
  source: "project" | "general";
  /** Three-state approval signal. "approved" = file went through the
   *  Drive Approvals API and received APPROVED, OR the file is manually
   *  locked via contentRestrictions (Sheets' "Approved version" UI).
   *  "pending" = an Approvals API flow is IN_PROGRESS. "none" = no
   *  active approval flow + not locked. */
  approvalState: "approved" | "pending" | "none";
  /** True for backwards-compat with old call sites. Equivalent to
   *  approvalState === "approved". */
  approved: boolean;
  /** ISO timestamp of when the file was locked/approved (the
   *  contentRestriction's restrictionTime). Empty when not approved. */
  approvedTime: string;
};

/** Mime types we surface from a פריסות folder — sheets + the common
 *  image formats. Anything else (PDFs, Docs, raw bytes) is ignored
 *  because the renderer doesn't have a meaningful display path for them
 *  and the user only puts spreads/images in this folder by convention. */
const PRISOT_MIMES = [
  "application/vnd.google-apps.spreadsheet",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
];

const DATE_IN_NAME_RE = /(\d{4})-(\d{1,2})-(\d{1,2})/;
function extractDateFromName(name: string): string {
  const m = name.match(DATE_IN_NAME_RE);
  if (!m) return "";
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/**
 * Fetches the Drive Approvals API state for one file. The googleapis
 * SDK doesn't expose `drive.approvals` as a typed sub-resource yet, so
 * we hit the REST endpoint directly with the SA's Bearer token.
 *
 * Returns:
 *   "approved" — at least one APPROVED approval exists
 *   "pending"  — at least one IN_PROGRESS approval exists, none APPROVED
 *   "none"     — no approvals, all CANCELLED/DECLINED, or API unavailable
 *                (silently fails so workspace tenants without the
 *                Approvals feature don't 4xx-spam every page render)
 *
 * The endpoint is `GET /drive/v3/files/{fileId}/approvals`. Same Drive
 * scope our existing reads use — no extra OAuth scope needed.
 */
type ApprovalState = "approved" | "pending" | "none";
async function fetchApprovalState(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<ApprovalState> {
  try {
    const auth2 = drive.context._options.auth as
      | { getAccessToken: () => Promise<{ token?: string | null }> }
      | undefined;
    const tokenResp = await auth2?.getAccessToken?.();
    const token = tokenResp?.token;
    if (!token) return "none";
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId,
    )}/approvals?supportsAllDrives=true`;
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    // 404 = file not found OR Approvals API not enabled for this file.
    // 403 = Approvals not enabled for the workspace. Both → "none".
    if (!r.ok) {
      // Log every non-2xx — including 403/404 — so we can tell from
      // App Hosting logs whether the badge says "לא מאושר" because
      // the API is unavailable for this workspace tier vs because
      // the file genuinely has no pending approval. Body is capped
      // so a runaway HTML error page doesn't bloat the log.
      const errBody = await r.text().catch(() => "");
      console.warn(
        `[fetchApprovalState] ${r.status} for fileId=${fileId}: ${errBody.slice(
          0,
          240,
        )}`,
      );
      return "none";
    }
    const data = (await r.json().catch(() => ({}))) as {
      approvals?: Array<{
        id?: string;
        status?: string;
        requestTime?: string;
        completionTime?: string;
      }>;
    };
    const approvals = data.approvals || [];
    if (approvals.length === 0) {
      // Empty 200 means the file has no approvals at all — log so
      // the "user says it's pending but hub shows לא מאושר" case
      // can be diagnosed from logs (vs the 403 case above).
      console.log(
        `[fetchApprovalState] empty approvals[] for fileId=${fileId}`,
      );
      return "none";
    }
    // Look at the LATEST approval only — sequence
    //   [APPROVED, IN_PROGRESS]
    // means a previously-approved file had a new review round started
    // and should read as "pending", not "approved". Sort by requestTime
    // desc; fall through to whatever the API order was when timestamps
    // are missing.
    const sorted = [...approvals].sort((a, b) =>
      String(b.requestTime || "").localeCompare(String(a.requestTime || "")),
    );
    const latest = sorted[0];
    const status = String(latest?.status || "").toUpperCase();
    if (status === "APPROVED") return "approved";
    if (status === "IN_PROGRESS") return "pending";
    // CANCELED / DECLINED / unknown — file is not in an active flow,
    // no badge. (Google's enum uses "CANCELED" with one L; we match
    // the explicit positive states above and let everything else fall
    // through to "none" — same effect, more forgiving to enum drift.)
    return "none";
  } catch (e) {
    console.warn(
      `[fetchApprovalState] failed for fileId=${fileId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return "none";
  }
}

async function findLatestPrisotInner(
  subjectEmail: string,
  company: string,
  project: string,
  source: "project" | "general",
): Promise<LatestPrisot | null> {
  if (!company.trim() || !project.trim()) return null;
  const { folderId: projectFolderId } = await findProjectFolderUrlCached(
    company,
    project,
  );
  if (!projectFolderId) return null;
  const sharedDriveId = tasksSharedDriveId();
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  const prisotFolderId = await findFolder(
    drive,
    projectFolderId,
    "פריסות",
    sharedDriveId,
  );
  if (!prisotFolderId) return null;
  const mimeQ = "(" + PRISOT_MIMES.map((m) => `mimeType='${m}'`).join(" or ") + ")";
  const res = await drive.files.list({
    q: [
      mimeQ,
      `'${prisotFolderId}' in parents`,
      "trashed=false",
    ].join(" and "),
    fields:
      "files(id, name, mimeType, modifiedTime, webViewLink, thumbnailLink, " +
      "contentRestrictions(readOnly, reason, restrictionTime), " +
      // capabilities tells us at a glance whether THIS file supports
      // the approval workflow at all — Drive surfaces canApprove /
      // canRequestApproval per file based on (a) workspace plan,
      // (b) file mimeType, (c) file location (Shared Drive vs My
      // Drive), (d) viewer's role. When `canRequestApproval=false`
      // for our impersonated identity, the GET /approvals call
      // typically returns 200 with empty approvals[] regardless of
      // the file's actual state in the UI. Logged below for
      // diagnosis when the badge ends up "none".
      "capabilities(canApprove, canRequestApproval))",
    orderBy: "modifiedTime desc",
    // We need to find the file with the latest date-IN-NAME, not the
    // latest modifiedTime — pull a small page and rank client-side.
    pageSize: 30,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: sharedDriveId,
  });
  const items = res.data.files ?? [];
  if (items.length === 0) return null;
  // Rank: prefer the file with the latest date-in-name. Files without
  // a parseable date in their name fall through to modifiedTime order
  // (the API already returned them sorted that way). When everything
  // has a date, the date-in-name wins.
  let best: typeof items[number] | null = null;
  let bestKey = "";
  for (const f of items) {
    if (!f.id) continue;
    const dateInName = extractDateFromName(f.name || "");
    const modified = f.modifiedTime || "";
    // Composite key: date-in-name first (so it always wins), then
    // modifiedTime as tiebreaker. Both are ISO-like, so string-compare
    // works correctly.
    const key = (dateInName || "0000-00-00") + "|" + modified;
    if (key > bestKey) {
      bestKey = key;
      best = f;
    }
  }
  if (!best?.id) return null;
  // Approval signal: combine the Drive Approvals API state with the
  // legacy contentRestrictions readOnly fallback. The formal API is
  // authoritative when present; readOnly catches manually-locked files
  // that didn't go through the Approvals workflow but the user still
  // considers "signed off" (e.g. via Sheets' "Approved version" UI).
  const restriction = best.contentRestrictions?.[0];
  const isLocked = !!restriction?.readOnly;
  const approvedTime = restriction?.restrictionTime || "";
  const apiState = await fetchApprovalState(drive, best.id);
  // Resolve the three-state badge. `approved` wins; `pending` second;
  // `none` last. Manual locks count as approved since users mark
  // files locked specifically to declare them final.
  let approvalState: ApprovalState;
  if (apiState === "approved" || isLocked) approvalState = "approved";
  else if (apiState === "pending") approvalState = "pending";
  else approvalState = "none";
  // Diagnostic log when the badge resolves to "none" — captures the
  // file mimeType + capabilities so we can tell from App Hosting
  // logs whether the issue is "this file type doesn't support
  // approvals" (image, etc.), "this workspace plan doesn't expose
  // the API" (caps both false), or "the file genuinely has no
  // pending approval" (caps say it could but the API has nothing).
  // Reported by maayan on /projects/כללי?company=גיא ודורון.
  if (approvalState === "none") {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const caps = (best as any).capabilities || {};
    /* eslint-enable @typescript-eslint/no-explicit-any */
    console.log(
      `[approvalState=none] fileId=${best.id} mime=${best.mimeType} ` +
        `canRequestApproval=${caps.canRequestApproval} canApprove=${caps.canApprove} ` +
        `isLocked=${isLocked} reason=${restriction?.reason || ""}`,
    );
  }
  return {
    id: best.id,
    name: best.name || "(ללא שם)",
    modifiedTime: best.modifiedTime || "",
    webViewLink:
      best.webViewLink ||
      `https://docs.google.com/spreadsheets/d/${best.id}/edit`,
    thumbnailLink: best.thumbnailLink || "",
    mimeType: best.mimeType || "",
    dateInName: extractDateFromName(best.name || ""),
    source,
    approvalState,
    approved: approvalState === "approved",
    approvedTime,
  };
}

/**
 * Reads the first tab of a Google Sheet AND its per-cell formatting
 * (background, foreground, bold, alignment, …), merge ranges, column
 * widths, and frozen-row count, so LatestPrisotCard can render an
 * HTML table that visually approximates the Google Sheets view —
 * not a stripped-down monochrome grid. Used by the project overview's
 * "פריסה אחרונה" card.
 *
 * Bounded to A1:T50 (20 columns × 50 rows) to keep payloads reasonable.
 * Trailing all-empty rows + columns are trimmed before return — but
 * trim is now value-aware (a cell with formatting but no text counts
 * as empty for trim purposes; styled blank cells in the middle of
 * the grid are preserved).
 */
export type PrisotCellFormat = {
  /** CSS rgb() string for background; undefined when default white. */
  bg?: string;
  /** CSS rgb() string for foreground; undefined when default black. */
  fg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Font size in pt (Sheets' native unit). Undefined = default. */
  fontSize?: number;
  align?: "left" | "center" | "right";
  /** True when wrapStrategy=WRAP. Default (CLIP/OVERFLOW) keeps nowrap. */
  wrap?: boolean;
};

export type PrisotMerge = {
  /** Inclusive start row (0-indexed within the trimmed rows array). */
  r1: number;
  /** Inclusive start column. */
  c1: number;
  /** Exclusive end row (so rowSpan = r2 - r1). */
  r2: number;
  /** Exclusive end column. */
  c2: number;
};

export type PrisotData = {
  /** Title of the tab read (typically the first tab — Sheets' default). */
  sheetTitle: string;
  /** Range that was actually read, e.g. "Sheet1!A1:T50". */
  range: string;
  /** 2-D array of cell display strings (post-trim). All rows are padded
   *  to the same column count so the renderer can index without bounds
   *  checks. */
  rows: string[][];
  /** Per-cell format, same shape as `rows`. `null` = no format / default. */
  formats: (PrisotCellFormat | null)[][];
  /** Pixel widths per column (post-trim, same length as a row). Empty
   *  array when the API didn't return columnMetadata. */
  colWidths: number[];
  /** Merged ranges, post-trim. Top-left cell renders with rowSpan/colSpan;
   *  the rest are skipped. */
  merges: PrisotMerge[];
  /** Frozen-row count from the sheet's gridProperties. The renderer can
   *  apply a sticky-header treatment to the first N rows. */
  frozenRows: number;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type RgbColor = { red?: number; green?: number; blue?: number };

function rgbToCss(rgb?: RgbColor): string | undefined {
  if (!rgb) return undefined;
  const r = Math.round((rgb.red ?? 0) * 255);
  const g = Math.round((rgb.green ?? 0) * 255);
  const b = Math.round((rgb.blue ?? 0) * 255);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Returns true when the color is so close to white we should treat it
 *  as "no override" (let the theme variable handle background — important
 *  for dark-mode legibility). */
function isWhiteIsh(rgb?: RgbColor): boolean {
  if (!rgb) return true;
  return (rgb.red ?? 0) >= 0.99 && (rgb.green ?? 0) >= 0.99 && (rgb.blue ?? 0) >= 0.99;
}

/** Returns true when the color is so close to black we should treat it
 *  as "no override" (let the theme variable handle text color). */
function isBlackIsh(rgb?: RgbColor): boolean {
  if (!rgb) return true;
  return (rgb.red ?? 0) <= 0.02 && (rgb.green ?? 0) <= 0.02 && (rgb.blue ?? 0) <= 0.02;
}

function extractCellFormat(cell: any): PrisotCellFormat | null {
  const ef = cell?.effectiveFormat;
  if (!ef) return null;
  const out: PrisotCellFormat = {};
  const bg = ef.backgroundColorStyle?.rgbColor || ef.backgroundColor;
  if (bg && !isWhiteIsh(bg)) out.bg = rgbToCss(bg);
  const tf = ef.textFormat || {};
  const fg = tf.foregroundColorStyle?.rgbColor || tf.foregroundColor;
  if (fg && !isBlackIsh(fg)) out.fg = rgbToCss(fg);
  if (tf.bold) out.bold = true;
  if (tf.italic) out.italic = true;
  if (tf.underline) out.underline = true;
  if (typeof tf.fontSize === "number" && tf.fontSize > 0) out.fontSize = tf.fontSize;
  const ha = String(ef.horizontalAlignment || "").toUpperCase();
  if (ha === "LEFT" || ha === "CENTER" || ha === "RIGHT") {
    out.align = ha.toLowerCase() as "left" | "center" | "right";
  }
  if (String(ef.wrapStrategy || "").toUpperCase() === "WRAP") out.wrap = true;
  return Object.keys(out).length === 0 ? null : out;
}

export async function readPrisotData(
  subjectEmail: string,
  fileId: string,
): Promise<PrisotData | null> {
  if (!fileId) return null;
  try {
    const sheets = sheetsClient(driveFolderOwner() || subjectEmail);
    // Resolve the first non-hidden GRID tab. We need its title for the
    // ranges arg below.
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: fileId,
      fields: "sheets(properties(title,index,sheetType,hidden))",
    });
    const tab = (meta.data.sheets || []).find((s) => {
      const p = s.properties || {};
      return !p.hidden && (p.sheetType || "GRID") === "GRID";
    });
    const sheetTitle = tab?.properties?.title || "";
    if (!sheetTitle) {
      console.warn(
        `[readPrisotData] no visible GRID tab for fileId=${fileId}`,
      );
      return null;
    }
    const range = `${sheetTitle}!A1:T50`;
    // Single round-trip: includeGridData=true with a bounded range
    // returns formattedValue + effectiveFormat + merges + grid metadata
    // for just that window. Field selection keeps the payload small.
    const full: any = await sheets.spreadsheets.get({
      spreadsheetId: fileId,
      ranges: [range],
      includeGridData: true,
      fields: [
        "sheets.properties(title,index,sheetType,hidden,gridProperties(frozenRowCount))",
        "sheets.merges(startRowIndex,endRowIndex,startColumnIndex,endColumnIndex)",
        "sheets.data(startRow,startColumn,rowMetadata.pixelSize,columnMetadata.pixelSize",
        "rowData.values(formattedValue,effectiveFormat(backgroundColor,backgroundColorStyle.rgbColor",
        "horizontalAlignment,wrapStrategy,textFormat(bold,italic,underline,fontSize,foregroundColor,foregroundColorStyle.rgbColor))))",
      ].join(","),
    });
    const sheet = (full.data.sheets || []).find((s: any) => {
      const p = s.properties || {};
      return !p.hidden && (p.sheetType || "GRID") === "GRID";
    });
    if (!sheet) return null;
    const grid = sheet.data?.[0];
    if (!grid) return null;
    const rowData: any[] = grid.rowData || [];
    const colMeta: any[] = grid.columnMetadata || [];
    const frozenRows: number =
      sheet.properties?.gridProperties?.frozenRowCount || 0;

    // Extract values + formats into parallel 2-D arrays.
    const rawRows: string[][] = [];
    const rawFormats: (PrisotCellFormat | null)[][] = [];
    for (const r of rowData) {
      const cells: any[] = r?.values || [];
      const valRow: string[] = [];
      const fmtRow: (PrisotCellFormat | null)[] = [];
      for (const c of cells) {
        valRow.push(String(c?.formattedValue ?? ""));
        fmtRow.push(extractCellFormat(c));
      }
      rawRows.push(valRow);
      rawFormats.push(fmtRow);
    }
    if (rawRows.length === 0) {
      console.warn(
        `[readPrisotData] empty values for fileId=${fileId} range=${range}`,
      );
      return null;
    }

    // Trim trailing empty rows + columns — trim is value-aware (a cell
    // with only formatting and no text doesn't count as content).
    const { rows, formats, lastCol } = trimEmptyWithFormats(rawRows, rawFormats);
    if (rows.length === 0) return null;

    // Column widths — slice + clamp to the trimmed width. Sheets sometimes
    // omits columnMetadata entries beyond the explicitly-sized columns,
    // so missing entries fall back to a sensible default.
    const colWidths: number[] = [];
    for (let c = 0; c <= lastCol; c++) {
      const px = Number(colMeta[c]?.pixelSize);
      colWidths.push(Number.isFinite(px) && px > 0 ? px : 100);
    }

    // Merges — clamp to the trim window so the indices line up with
    // the post-trim rows array. Merges that fall entirely outside the
    // trim window are dropped.
    const merges: PrisotMerge[] = [];
    const sheetMerges: any[] = sheet.merges || [];
    const trimRows = rows.length;
    const trimCols = lastCol + 1;
    for (const m of sheetMerges) {
      const r1 = Math.max(0, m.startRowIndex || 0);
      const c1 = Math.max(0, m.startColumnIndex || 0);
      const r2 = Math.min(trimRows, m.endRowIndex || 0);
      const c2 = Math.min(trimCols, m.endColumnIndex || 0);
      if (r2 > r1 && c2 > c1) merges.push({ r1, c1, r2, c2 });
    }

    return {
      sheetTitle,
      range,
      rows,
      formats,
      colWidths,
      merges,
      frozenRows,
    };
  } catch (e) {
    // Surface the failure mode (403 access denied, 404 deleted, etc.)
    // so the broken-on-some-projects case is diagnosable from logs.
    const code =
      (e as { code?: number; response?: { status?: number } }).code ??
      (e as { response?: { status?: number } }).response?.status;
    console.warn(
      `[readPrisotData] failed for fileId=${fileId} code=${code}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Trim trailing all-empty rows and trailing all-empty columns. "Empty"
 *  means the cell has no formattedValue text — we ignore formatting
 *  alone, since hundreds of unformatted blank cells at the bottom of
 *  every Sheet would otherwise survive trim and bloat the table. */
function trimEmptyWithFormats(
  rows: string[][],
  formats: (PrisotCellFormat | null)[][],
): {
  rows: string[][];
  formats: (PrisotCellFormat | null)[][];
  lastCol: number;
} {
  let lastNonEmpty = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i] || []).some((c) => String(c ?? "").trim() !== "")) {
      lastNonEmpty = i;
    }
  }
  if (lastNonEmpty < 0) return { rows: [], formats: [], lastCol: -1 };
  const trimmedRows = rows.slice(0, lastNonEmpty + 1);
  const trimmedFormats = formats.slice(0, lastNonEmpty + 1);
  let lastCol = -1;
  for (const row of trimmedRows) {
    for (let c = (row?.length ?? 0) - 1; c > lastCol; c--) {
      if (String(row[c] ?? "").trim() !== "") {
        lastCol = c;
        break;
      }
    }
  }
  if (lastCol < 0) return { rows: [], formats: [], lastCol: -1 };
  const outRows = trimmedRows.map((row) => {
    const out = (row || []).slice(0, lastCol + 1);
    while (out.length < lastCol + 1) out.push("");
    return out;
  });
  const outFormats = trimmedFormats.map((row) => {
    const out = (row || []).slice(0, lastCol + 1);
    while (out.length < lastCol + 1) out.push(null);
    return out;
  });
  return { rows: outRows, formats: outFormats, lastCol };
}

/** Backwards-compat wrapper for any external callers that imported the
 *  pre-2026-05-04 single-folder helper. New callers should use
 *  pickLatestPrisotForCompanyOrProject which handles the כללי fallback. */
export async function findLatestPrisotForProject(
  subjectEmail: string,
  company: string,
  project: string,
): Promise<LatestPrisot | null> {
  return findLatestPrisotInner(subjectEmail, company, project, "project");
}

/**
 * Two-step latest-spread resolution that rules over a project page:
 *
 *   1. Look up the project's own `<project>/פריסות/` folder, take the
 *      file with the latest date-in-name (falling back to modifiedTime
 *      when names lack a date).
 *   2. ALSO look up `<company>/כללי/פריסות/` and take the same.
 *   3. Pick the winner by date-in-name; the company-level כללי file
 *      overrides the project file ONLY when its date-in-name is
 *      STRICTLY more recent. On equal dates the project's own file
 *      wins — reported by Maayan 2026-05-06 against
 *      "גיא ודורון לוי / אורנבך", where כללי and the project both
 *      had a spread for the same date and the page kept showing the
 *      כללי one. The semantics: a כללי spread is a fallback /
 *      portfolio-wide drop, so when the project ALSO published its
 *      own version for that same date, the project's is the source of
 *      truth for that project's page. modifiedTime is no longer a
 *      tiebreaker — it leaked through previously when the כללי file
 *      happened to be touched later, even with identical dates.
 *      When the project has no folder at all, the כללי file fills in
 *      (sub-rule of the same comparison — null always loses).
 *
 * No-op when company is "" or project is already "כללי" (no fallback
 * to itself).
 */
export async function pickLatestPrisotForCompanyOrProject(
  subjectEmail: string,
  company: string,
  project: string,
): Promise<LatestPrisot | null> {
  if (!company.trim()) return null;
  const proj = project.trim();
  // Run both lookups in parallel; either may be null.
  const [own, general] = await Promise.all([
    proj ? findLatestPrisotInner(subjectEmail, company, proj, "project") : null,
    proj && proj !== "כללי"
      ? findLatestPrisotInner(subjectEmail, company, "כללי", "general")
      : null,
  ]);
  if (!own && !general) return null;
  if (!own) return general;
  if (!general) return own;
  // Compare by date-in-name only. Equal dates → project's own wins.
  const ownDate = own.dateInName || "0000-00-00";
  const genDate = general.dateInName || "0000-00-00";
  return genDate > ownDate ? general : own;
}

export async function listFolderChildren(
  subjectEmail: string,
  parentId: string,
): Promise<FolderChild[]> {
  const sharedDriveId = tasksSharedDriveId();
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  const res = await drive.files.list({
    q: [
      "mimeType='application/vnd.google-apps.folder'",
      `'${parentId}' in parents`,
      "trashed=false",
    ].join(" and "),
    fields: "files(id, name, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: sharedDriveId,
  });
  const items = res.data.files ?? [];
  // Coarse "has children" probe: one list per folder, page-size 1. For
  // a typical campaign folder (≤20 subfolders) this is ≤20 extra cheap
  // requests, all running in parallel.
  const probes = await Promise.all(
    items.map(async (f) => {
      if (!f.id) return false;
      try {
        const probe = await drive.files.list({
          q: [
            "mimeType='application/vnd.google-apps.folder'",
            `'${f.id}' in parents`,
            "trashed=false",
          ].join(" and "),
          fields: "files(id)",
          pageSize: 1,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          corpora: "drive",
          driveId: sharedDriveId,
        });
        return (probe.data.files?.length ?? 0) > 0;
      } catch {
        return false;
      }
    }),
  );
  return items.map((f, i) => ({
    id: f.id || "",
    name: f.name || "",
    modifiedTime: f.modifiedTime || "",
    hasChildren: probes[i],
  }));
}

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  /** Small Drive icon URL (16x16 or 32x32). Use for tile rendering
   *  when no thumbnail is available. */
  iconLink: string;
  /** Open-in-Drive URL — opens the file in its native viewer (Docs,
   *  Sheets, Drive PDF preview, etc.) in a new tab. */
  webViewLink: string;
  modifiedTime: string;
  /** Size in bytes; missing for native Google Docs / Sheets etc. */
  size?: string;
  /** Optional thumbnail URL (cosmetic; v1 doesn't render but the field
   *  is exposed so the upcoming preview pass can slot in). */
  thumbnailLink?: string;
};

/**
 * Lists FILES (non-folder items) directly under a parent folder.
 * Mirrors `listFolderChildren` (which lists folders only) — used by
 * the TaskFilesPanel tile grid on /tasks/[id].
 */
export async function listFolderFiles(
  subjectEmail: string,
  parentId: string,
): Promise<DriveFile[]> {
  const sharedDriveId = tasksSharedDriveId();
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  const res = await drive.files.list({
    q: [
      // Inverse of the folder filter — everything that isn't a folder.
      "mimeType!='application/vnd.google-apps.folder'",
      `'${parentId}' in parents`,
      "trashed=false",
    ].join(" and "),
    fields:
      "files(id, name, mimeType, iconLink, webViewLink, modifiedTime, size, thumbnailLink)",
    orderBy: "modifiedTime desc",
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "drive",
    driveId: sharedDriveId,
  });
  const items = res.data.files ?? [];
  return items.map((f) => ({
    id: f.id || "",
    name: f.name || "",
    mimeType: f.mimeType || "",
    iconLink: f.iconLink || "",
    webViewLink: f.webViewLink || "",
    modifiedTime: f.modifiedTime || "",
    size: f.size || undefined,
    thumbnailLink: f.thumbnailLink || undefined,
  }));
}

/**
 * Uploads a file to the given parent folder. Used by TaskFilesPanel's
 * drag-drop upload zone. Goes through the SA (impersonating the
 * driveFolderOwner) so the resulting file is owned by the shared
 * drive's owner — not the uploading user — which keeps file
 * ownership consistent across the team. The user's `drive.file`
 * OAuth scope is bypassed entirely for this path.
 */
export async function uploadFileToFolder(
  subjectEmail: string,
  parentId: string,
  fileName: string,
  mimeType: string,
  body: Buffer,
): Promise<DriveFile> {
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentId],
      mimeType: mimeType || "application/octet-stream",
    },
    media: {
      mimeType: mimeType || "application/octet-stream",
      body: bufferToReadable(body),
    },
    fields:
      "id, name, mimeType, iconLink, webViewLink, modifiedTime, size, thumbnailLink",
    supportsAllDrives: true,
  });
  const f = res.data;
  return {
    id: f.id || "",
    name: f.name || fileName,
    mimeType: f.mimeType || mimeType,
    iconLink: f.iconLink || "",
    webViewLink: f.webViewLink || "",
    modifiedTime: f.modifiedTime || "",
    size: f.size || undefined,
    thumbnailLink: f.thumbnailLink || undefined,
  };
}

// googleapis' `media.body` accepts a Readable stream. The route wraps
// the multipart File data into a Buffer; this helper converts it.
function bufferToReadable(buf: Buffer): NodeJS.ReadableStream {
  // Lazy require so the module-load cost only fires for upload calls.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Readable } = require("node:stream") as typeof import("node:stream");
  return Readable.from(buf);
}

/**
 * Creates a subfolder under the given parent. Used by the picker's
 * "+ new folder" action.
 */
export async function createChildFolder(
  subjectEmail: string,
  parentId: string,
  name: string,
): Promise<FolderRef> {
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  return createFolder(drive, parentId, name);
}

// `buildLocalDrivePaths` was here, but it's a pure string helper used
// by both server pages and a "use client" component (TasksQueue's
// per-row Drive Desktop button). Importing it from this file caused
// webpack to chase the entire driveFolders module graph (which pulls
// in `googleapis` via lib/sa) into the client bundle, OOM'ing
// `next build`. Moved to lib/localDrivePath.ts which has zero server
// imports.

/**
 * Returns the configured Shared Drive's display name. Cached for 1
 * hour in-process — the name effectively never changes.
 *
 * Used to construct the user-facing local path when Google Drive for
 * Desktop is installed: the in-Drive path is the same on every
 * machine (`Shared drives/<name>/<company>/<project>`); only the
 * mount point differs (G:\ on Windows, /Volumes/GoogleDrive/ on Mac).
 * The "copy local path" button copies the in-Drive suffix.
 */
let _sharedDriveNameCache: { name: string; expiresAt: number } | null = null;

export async function getSharedDriveName(
  subjectEmail: string,
): Promise<string> {
  const sharedDriveId = process.env.TASKS_SHARED_DRIVE_ID;
  if (!sharedDriveId) return "";
  if (_sharedDriveNameCache && _sharedDriveNameCache.expiresAt > Date.now()) {
    return _sharedDriveNameCache.name;
  }
  try {
    const drive = driveClient(driveFolderOwner() || subjectEmail);
    const res = await drive.drives.get({
      driveId: sharedDriveId,
      fields: "name",
    });
    const name = res.data.name || "";
    _sharedDriveNameCache = { name, expiresAt: Date.now() + 60 * 60 * 1000 };
    return name;
  } catch {
    return "";
  }
}

/**
 * Reads a folder's current name + webViewLink. Used when a task is
 * re-pointed to an existing folder so we can persist a stable
 * `drive_folder_url` alongside the ID.
 */
export async function getFolderRef(
  subjectEmail: string,
  folderId: string,
): Promise<FolderRef> {
  const drive = driveClient(driveFolderOwner() || subjectEmail);
  const res = await drive.files.get({
    fileId: folderId,
    fields: "id, name, webViewLink",
    supportsAllDrives: true,
  });
  return {
    id: res.data.id || folderId,
    name: res.data.name || "",
    viewUrl: res.data.webViewLink || driveFolderUrl(folderId),
  };
}
