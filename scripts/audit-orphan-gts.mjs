/* eslint-disable */
// Audit: cross-reference a user's open Google Tasks against the
// Comments sheet's task rows. Flags every open GT whose corresponding
// hub WorkTask is in `done` / `cancelled` (those should have been
// closed by the status cascade).
//
// Run from hub-next/:
//   node scripts/audit-orphan-gts.mjs <userEmail>            (read-only audit)
//   node scripts/audit-orphan-gts.mjs <userEmail> --cleanup  (close orphans)
//
// `--cleanup` patches every detected orphan GT to status=completed.
// Touches only:
//   - GTs whose hub task is `done` or `cancelled` (never should have stayed open)
//   - GTs that are not in the row's google_tasks cell (lost-update orphans)
// Live GTs and unknown-id GTs are left alone.
//
// Output sections:
//   1. Open GTs in user's tasklist (count + breakdown by kind)
//   2. For each open GT with a hub deep-link:
//        - resolved hub task id
//        - hub task status
//        - VERDICT: orphan / live / unknown-id
//   3. Summary of stale entries
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}

const SUBJECT = (process.argv[2] || "maayan@fandf.co.il").toLowerCase().trim();
const CLEANUP = process.argv.includes("--cleanup");
const SHEET_ID_COMMENTS = process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");

if (!SHEET_ID_COMMENTS) {
  console.error("SHEET_ID_COMMENTS not in env or .env.local");
  process.exit(1);
}

function loadKey() {
  const raw = process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON");
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
  const m = String(notes).match(/https:\/\/hub\.fandf\.co\.il\/tasks\/([^\s\n)]+)/);
  return m ? m[1].trim() : "";
}

console.log(`Subject: ${SUBJECT}`);
console.log(`Comments sheet: ${SHEET_ID_COMMENTS}`);
console.log("---");

// 1. List user's open GTs.
const tasksApi = google.tasks({ version: "v1", auth: jwt(["https://www.googleapis.com/auth/tasks"], SUBJECT) });
const tlRes = await tasksApi.tasklists.list({ maxResults: 5 });
const lists = tlRes.data.items || [];
console.log(`Tasklists (${lists.length}):`);
lists.forEach((l, i) => console.log(`  ${i + 1}. ${l.title} (id=${l.id})${i === 0 ? "  ← default" : ""}`));
const defaultList = lists[0];
if (!defaultList) { console.error("No tasklists"); process.exit(1); }

// Pull ALL tasks (not paginated for now — Google's max page is 100, and
// we typically have < 200). Use showCompleted:false to focus on open.
let allOpen = [];
let pageToken;
do {
  const res = await tasksApi.tasks.list({
    tasklist: defaultList.id,
    showCompleted: false,
    showHidden: false,
    maxResults: 100,
    pageToken,
  });
  allOpen = allOpen.concat(res.data.items || []);
  pageToken = res.data.nextPageToken;
} while (pageToken);

console.log(`\nOpen GTs in default list: ${allOpen.length}`);

// Categorize: hub-spawned (notes start with hub URL OR title starts with kind prefix),
// gmail-origin (links[].type === "email"), other.
const hubSpawned = [];
const gmailOrigin = [];
const other = [];
for (const t of allOpen) {
  const notes = t.notes || "";
  const links = t.links || [];
  // Hub-spawned: notes contain the hub deep-link anywhere. The actual
  // format prepends a 🔗 emoji so a startsWith check misses everything.
  const hubInNotes = notes.includes(HUB_PREFIX);
  const hasEmailLink = links.some((l) => l.type === "email");
  if (hubInNotes) hubSpawned.push(t);
  else if (hasEmailLink) gmailOrigin.push(t);
  else other.push(t);
}
console.log(`  hub-spawned (notes start with ${HUB_PREFIX}): ${hubSpawned.length}`);
console.log(`  gmail-origin (links[].type=email):           ${gmailOrigin.length}`);
console.log(`  other (legacy comment-mention or manual):    ${other.length}`);

// 2. Read Comments sheet, build {taskId → {status, google_tasks_cell, title}}.
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

if (I_ID < 0 || I_KIND < 0) {
  console.error("Comments sheet missing required columns");
  process.exit(1);
}

const taskById = new Map();
for (let r = 1; r < cRows.length; r++) {
  const row = cRows[r];
  const rk = String(row[I_KIND] ?? "").trim();
  if (rk !== "task") continue;
  const id = String(row[I_ID] ?? "").trim();
  if (!id) continue;
  let gtCell = {};
  try { gtCell = JSON.parse(String(row[I_GTASKS] ?? "{}") || "{}"); } catch {}
  taskById.set(id, {
    id,
    status: String(row[I_STATUS] ?? "").trim(),
    title: String(row[I_TITLE] ?? "").trim(),
    project: String(row[I_PROJECT] ?? "").trim(),
    author: String(row[I_AUTHOR] ?? "").trim(),
    google_tasks: gtCell,
  });
}
console.log(`\nComments sheet task rows (row_kind=task): ${taskById.size}`);

// 3. Bucket the user's open hub-spawned GTs by hub task status.
console.log("\n=== Hub-spawned open GTs ===");
const buckets = {
  orphan_done: [],
  orphan_cancelled: [],
  live: [],
  unknown_id: [],
  not_in_gt_cell: [],
};

for (const gt of hubSpawned) {
  const taskId = extractHubTaskId(gt.notes);
  const row = taskId ? taskById.get(taskId) : null;
  if (!row) { buckets.unknown_id.push({ gt, taskId }); continue; }
  // Was this GT actually persisted on the row's google_tasks cell?
  const persisted = Object.values(row.google_tasks || {}).some((e) => e && e.t === gt.id);
  const entry = { gt, taskId, row, persisted };
  if (row.status === "done") buckets.orphan_done.push(entry);
  else if (row.status === "cancelled") buckets.orphan_cancelled.push(entry);
  else if (!persisted) buckets.not_in_gt_cell.push(entry);
  else buckets.live.push(entry);
}

console.log(`Live (hub status open + persisted on row): ${buckets.live.length}`);
console.log(`ORPHAN — hub status='done':              ${buckets.orphan_done.length}`);
console.log(`ORPHAN — hub status='cancelled':         ${buckets.orphan_cancelled.length}`);
console.log(`Not in row.google_tasks cell:            ${buckets.not_in_gt_cell.length}`);
console.log(`Unknown hub task ID:                     ${buckets.unknown_id.length}`);

function fmt(entry, includeWhy = "") {
  const { gt, taskId, row } = entry;
  const title = (gt.title || "").slice(0, 70);
  return `  - ${gt.id}  task=${taskId}  status=${row?.status || "?"}  proj=${row?.project || "?"}  "${title}"${includeWhy ? "  " + includeWhy : ""}`;
}

if (buckets.orphan_done.length) {
  console.log("\n--- Orphans where hub task is DONE (should have been auto-closed) ---");
  buckets.orphan_done.forEach((e) => console.log(fmt(e)));
}
if (buckets.orphan_cancelled.length) {
  console.log("\n--- Orphans where hub task is CANCELLED ---");
  buckets.orphan_cancelled.forEach((e) => console.log(fmt(e)));
}
if (buckets.not_in_gt_cell.length) {
  console.log("\n--- GT no longer referenced by row.google_tasks (assignee removed?) ---");
  buckets.not_in_gt_cell.forEach((e) => console.log(fmt(e)));
}
if (buckets.unknown_id.length) {
  console.log("\n--- GT carries hub deep-link but no matching row ---");
  buckets.unknown_id.forEach((e) =>
    console.log(`  - ${e.gt.id}  notes-task-id="${e.taskId}"  title="${(e.gt.title || "").slice(0, 70)}"`),
  );
}

if (other.length) {
  console.log("\n=== Legacy / non-hub open GTs (sample) ===");
  other.slice(0, 20).forEach((t) =>
    console.log(`  - ${t.id}  title="${(t.title || "").slice(0, 90)}"`),
  );
  if (other.length > 20) console.log(`  ... (+${other.length - 20} more)`);
}

if (gmailOrigin.length) {
  console.log("\n=== Gmail-origin open GTs (created via right-click in Gmail) ===");
  gmailOrigin.slice(0, 20).forEach((t) =>
    console.log(`  - ${t.id}  title="${(t.title || "").slice(0, 90)}"`),
  );
  if (gmailOrigin.length > 20) console.log(`  ... (+${gmailOrigin.length - 20} more)`);
}

console.log("\n---");
console.log("VERDICT:");
const orphans = buckets.orphan_done.length + buckets.orphan_cancelled.length;
if (orphans > 0) {
  console.log(`  ${orphans} GT(s) should have been auto-closed by the status cascade but weren't.`);
  console.log(`  Likely: status transition skipped the GT close (poller / hub side bug).`);
}
if (buckets.unknown_id.length > 0) {
  console.log(`  ${buckets.unknown_id.length} GT(s) reference a hub task id that doesn't exist in the sheet —`);
  console.log(`  task row may have been deleted while the GT survived.`);
}
if (buckets.not_in_gt_cell.length > 0) {
  console.log(`  ${buckets.not_in_gt_cell.length} GT(s) exist for a live hub task but aren't tracked in its`);
  console.log(`  google_tasks cell — likely from a reassignment that didn't close the old GT,`);
  console.log(`  or duplicate creation.`);
}
if (orphans === 0 && buckets.unknown_id.length === 0 && buckets.not_in_gt_cell.length === 0) {
  console.log("  No mismatches detected — all open GTs match their hub status.");
}

if (CLEANUP) {
  const targets = [
    ...buckets.orphan_done,
    ...buckets.orphan_cancelled,
    ...buckets.not_in_gt_cell,
  ];
  if (targets.length === 0) {
    console.log("\n--cleanup: nothing to do.");
    process.exit(0);
  }
  console.log(`\n--cleanup: closing ${targets.length} orphan GT(s)...`);
  let closed = 0;
  let failed = 0;
  // The Tasks API returns 403 "caller does not have permission" when
  // bursting writes (not a 429). Observed: ~4 patches/min as a single
  // SA-impersonating user before the wall hits, then ~60s before the
  // window resets. So we retry on 403 with exponential backoff up to
  // 60s, and pace at 1 req/sec from the start.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < targets.length; i++) {
    const entry = targets[i];
    let attempt = 0;
    let waitMs = 2000;
    let done = false;
    while (!done && attempt < 5) {
      try {
        await tasksApi.tasks.patch({
          tasklist: defaultList.id,
          task: entry.gt.id,
          requestBody: { status: "completed" },
        });
        closed++;
        process.stdout.write(`.`);
        done = true;
      } catch (e) {
        const code = e?.response?.status;
        const isQuotaWall = code === 403 || code === 429;
        if (isQuotaWall && attempt < 4) {
          process.stdout.write(`!`);
          await sleep(waitMs);
          waitMs *= 2;
          attempt++;
        } else {
          failed++;
          console.log(`\n  failed ${entry.gt.id}: ${code} ${e?.message || e}`);
          done = true;
        }
      }
    }
    // Steady-state pacing between successful calls.
    if (i < targets.length - 1) await sleep(1000);
  }
  console.log(`\n--cleanup done: closed=${closed} failed=${failed}`);
}
