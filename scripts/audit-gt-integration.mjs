/* eslint-disable */
// Comprehensive GT-integration audit. Complements audit-orphan-gts.mjs
// (which goes GT → sheet) by also walking sheet → GT and inspecting
// the "other" bucket where titles look hub-style but notes don't carry
// the canonical hub deep-link.
//
// Run from hub-next/:
//   node scripts/audit-gt-integration.mjs <userEmail>
//
// Read-only. Reports four sections:
//
//   1. Open GTs in user's tasklist + buckets (mirrors audit-orphan-gts).
//   2. "Other" bucket deep-dive — full task object (title, notes,
//      created, due) so we can tell legacy-format hub GTs from genuine
//      manual / Gmail-origin tasks.
//   3. Sheet → GT direction:
//      - For each open hub task whose google_tasks cell references this
//        user (entry.u === <userEmail>), check that the referenced GT
//        id actually exists in the user's tasklist.
//      - Flag: PHANTOM (cell references GT, GT not found),
//              CLOSED-BUT-OPEN-IN-SHEET (GT marked completed but task
//              row still open),
//              LIVE (both open).
//   4. Cross-list summary by project + status, so we can tell at a
//      glance if any one project/status is over-represented in the
//      stale set.
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}

const SUBJECT = (process.argv[2] || "maayan@fandf.co.il")
  .toLowerCase()
  .trim();
const SHEET_ID_COMMENTS =
  process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");

if (!SHEET_ID_COMMENTS) {
  console.error("SHEET_ID_COMMENTS not in env or .env.local");
  process.exit(1);
}

function loadKey() {
  const raw =
    process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON");
  if (!raw) throw new Error("TASKS_SA_KEY_JSON not set");
  return JSON.parse(raw);
}

function jwt(scopes, subject) {
  const k = loadKey();
  return new google.auth.JWT({
    email: k.client_email,
    key: k.private_key,
    scopes,
    subject,
  });
}

const HUB_PREFIX = "https://hub.fandf.co.il/tasks/";

function extractHubTaskId(notes) {
  if (!notes) return "";
  const m = String(notes).match(
    /https:\/\/hub\.fandf\.co\.il\/tasks\/([^\s\n)]+)/,
  );
  return m ? m[1].trim() : "";
}

const banner = (s) =>
  console.log(`\n${"=".repeat(8)} ${s} ${"=".repeat(8)}`);

console.log(`Subject: ${SUBJECT}`);
console.log(`Comments sheet: ${SHEET_ID_COMMENTS}`);

const tasksApi = google.tasks({
  version: "v1",
  auth: jwt(["https://www.googleapis.com/auth/tasks"], SUBJECT),
});
const tlRes = await tasksApi.tasklists.list({ maxResults: 5 });
const lists = tlRes.data.items || [];
const defaultList = lists[0];
if (!defaultList) {
  console.error("No tasklists");
  process.exit(1);
}

// Pull both open AND completed (we want closed GTs too, to detect the
// poll-lag case where GT closed but sheet row still open).
async function listAll(opts) {
  let acc = [];
  let pageToken;
  do {
    const res = await tasksApi.tasks.list({
      tasklist: defaultList.id,
      maxResults: 100,
      pageToken,
      ...opts,
    });
    acc = acc.concat(res.data.items || []);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return acc;
}

const allOpen = await listAll({ showCompleted: false, showHidden: false });
// showCompleted defaults to true; showHidden true gets us the
// long-finished entries too. Capped — Tasks API only keeps recent
// completed tasks (~30 days?) so this won't drag in everything.
const allClosedish = await listAll({
  showCompleted: true,
  showHidden: true,
});
// allClosedish actually includes both open and closed; partition.
const allClosed = allClosedish.filter((t) => t.status === "completed");

// Build a quick id → task map across both for the inverse check.
const allById = new Map();
for (const t of [...allOpen, ...allClosed]) allById.set(t.id, t);

console.log(
  `\nTasklist: ${defaultList.title}  (open=${allOpen.length}, completed=${allClosed.length})`,
);

banner("1. Open-GT bucketing");

const hubSpawned = [];
const gmailOrigin = [];
const otherOpen = [];
for (const t of allOpen) {
  const notes = t.notes || "";
  const hasEmailLink = (t.links || []).some((l) => l.type === "email");
  if (notes.includes(HUB_PREFIX)) hubSpawned.push(t);
  else if (hasEmailLink) gmailOrigin.push(t);
  else otherOpen.push(t);
}
console.log(`  hub-spawned (hub URL in notes):  ${hubSpawned.length}`);
console.log(`  gmail-origin (email link):       ${gmailOrigin.length}`);
console.log(`  other (manual / legacy format):  ${otherOpen.length}`);

banner("2. 'Other' open GTs — full bodies");

if (otherOpen.length === 0) {
  console.log("  (none)");
} else {
  for (const t of otherOpen) {
    console.log(`\n  • id=${t.id}`);
    console.log(`    title:   ${t.title || "(empty)"}`);
    console.log(`    status:  ${t.status}`);
    console.log(`    updated: ${t.updated || "?"}`);
    console.log(`    due:     ${t.due || "?"}`);
    console.log(`    links:   ${JSON.stringify(t.links || [])}`);
    const noteLines = (t.notes || "").split("\n");
    console.log(`    notes (${noteLines.length} line${noteLines.length === 1 ? "" : "s"}):`);
    for (const ln of noteLines.slice(0, 6)) {
      console.log(`      | ${ln}`);
    }
    if (noteLines.length > 6) {
      console.log(`      | ... (+${noteLines.length - 6} lines)`);
    }
  }
}

banner("3. Sheet → GT direction");

const sheets = google.sheets({
  version: "v4",
  auth: jwt(["https://www.googleapis.com/auth/spreadsheets"], SUBJECT),
});
const cRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: "Comments",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const cRows = cRes.data.values || [];
const headers = (cRows[0] || []).map((h) => String(h ?? "").trim());
const idx = (n) => headers.indexOf(n);
const I_ID = idx("id");
const I_KIND = idx("row_kind");
const I_STATUS = idx("status");
const I_TITLE = idx("title");
const I_GTASKS = idx("google_tasks");
const I_PROJECT = idx("project");
const I_AUTHOR = idx("author_email");

const phantom = []; // GT id in cell, not in user's lists
const closedButOpen = []; // GT completed but task row still open
const live = []; // both open
const cellMisses = []; // entries that don't apply to this user (skipped silently)

const OPEN_STATUSES = new Set([
  "open",
  "in_progress",
  "awaiting_approval",
  "blocked",
  "todo",
  "",
]);

for (let r = 1; r < cRows.length; r++) {
  const row = cRows[r];
  if (String(row[I_KIND] ?? "").trim() !== "task") continue;
  const status = String(row[I_STATUS] ?? "").trim();
  if (!OPEN_STATUSES.has(status)) continue;
  let cell = {};
  try {
    cell = JSON.parse(String(row[I_GTASKS] ?? "{}") || "{}");
  } catch {}
  for (const [key, entry] of Object.entries(cell || {})) {
    if (!entry || typeof entry !== "object") continue;
    const u = String(entry.u || "").toLowerCase();
    if (u !== SUBJECT) {
      cellMisses.push({ row: r, key, u });
      continue;
    }
    const tId = String(entry.t || "").trim();
    if (!tId) continue;
    const gt = allById.get(tId);
    const ctx = {
      taskRowId: String(row[I_ID] ?? "").trim(),
      title: String(row[I_TITLE] ?? "").trim(),
      project: String(row[I_PROJECT] ?? "").trim(),
      hubStatus: status,
      gtId: tId,
      gtStatus: gt?.status || null,
    };
    if (!gt) phantom.push(ctx);
    else if (gt.status === "completed") closedButOpen.push(ctx);
    else live.push(ctx);
  }
}

console.log(
  `  Open task rows referencing ${SUBJECT} via google_tasks cell:`,
);
console.log(`    LIVE (both open):                       ${live.length}`);
console.log(`    PHANTOM (cell ref, GT not found):       ${phantom.length}`);
console.log(`    GT-CLOSED-BUT-ROW-OPEN (poller lag):    ${closedButOpen.length}`);
console.log(`  (entries for other users skipped: ${cellMisses.length})`);

if (phantom.length) {
  console.log(`\n  --- PHANTOM (${phantom.length}) ---`);
  for (const p of phantom) {
    console.log(
      `    - rowId=${p.taskRowId}  proj="${p.project}"  hubStatus=${p.hubStatus}  gtId=${p.gtId}  title="${p.title.slice(0, 60)}"`,
    );
  }
}
if (closedButOpen.length) {
  console.log(`\n  --- GT CLOSED BUT ROW OPEN (${closedButOpen.length}) ---`);
  for (const c of closedButOpen) {
    console.log(
      `    - rowId=${c.taskRowId}  proj="${c.project}"  hubStatus=${c.hubStatus}  gtId=${c.gtId}  title="${c.title.slice(0, 60)}"`,
    );
  }
}

banner("4. Open-task project breakdown (your assigned)");

const byProj = new Map();
for (const e of live) {
  const k = e.project || "(unknown)";
  byProj.set(k, (byProj.get(k) || 0) + 1);
}
const projRows = [...byProj.entries()].sort((a, b) => b[1] - a[1]);
if (projRows.length === 0) {
  console.log("  (no live entries)");
} else {
  for (const [p, n] of projRows) console.log(`  ${String(n).padStart(3)}  ${p}`);
}

console.log("\n--- DONE ---");
