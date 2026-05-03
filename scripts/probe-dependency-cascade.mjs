/* eslint-disable */
/**
 * End-to-end probe for phase-2 dependency cascade.
 *
 * Sequence:
 *   1. Append two test rows to Comments — A (status=in_progress) and
 *      B (status=blocked, blocked_by=[A.id]).
 *   2. Read both back; confirm B parses as blocked w/ blocked_by=[A].
 *   3. Patch A's status to done via the same direct-Sheets path the
 *      hub uses (write status + status_history + updated_at on A's row).
 *   4. Invoke cascadeAfterTerminal directly (since this is a probe; in
 *      real flow tasksUpdateDirect calls it for us).
 *   5. Re-read B; assert status flipped to awaiting_handling and
 *      status_history gained the auto-unblock entry.
 *   6. Cleanup — mark both rows status=cancelled with a probe marker so
 *      they're easy to filter out (we don't delete; deletion via Sheets
 *      API requires batchUpdate with row deletion — overkill for a probe).
 *
 * Run: node scripts/probe-dependency-cascade.mjs
 *
 * SAFE: writes 2 rows to live Comments tab marked with a unique probe
 * prefix in `title`. Both end the run as `cancelled`. The user said
 * the project isn't in production use yet so this is acceptable.
 *
 * Important: this probe deliberately avoids importing from lib/ to
 * keep the .mjs file runnable directly via Node without TS transpile.
 * The cascade module IS a TS file but Node 22's --experimental-strip-
 * types handles it.
 */
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}

const SHEET_ID = process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");
const SUBJECT = "maayan@fandf.co.il";
const KEY_RAW = process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON");
if (!SHEET_ID || !KEY_RAW) {
  console.log("[FAIL] env not set");
  process.exit(1);
}

const k = JSON.parse(KEY_RAW);
const auth = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth });

// Unique probe marker. Make tasks easy to find + cleanup.
const PROBE_TAG = `PROBE-CASCADE-${Date.now().toString(36)}`;
const A_ID = `T-probeA-${Date.now().toString(36)}`;
const B_ID = `T-probeB-${Date.now().toString(36)}`;
const NOW = new Date().toISOString();

function colLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function readHeaders() {
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Comments!1:1",
  });
  const headers = (got.data.values?.[0] ?? []).map((h) => String(h ?? "").trim());
  const idx = new Map();
  headers.forEach((h, i) => idx.set(h, i));
  return { headers, idx };
}

async function readAllRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Comments",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  return res.data.values ?? [];
}

function buildCells(taskId, status, blockedBy, statusHistory) {
  return {
    id: taskId,
    timestamp: NOW,
    project: PROBE_TAG, // use project to make filtering trivial
    company: "PROBE",
    title: `${PROBE_TAG} ${taskId === A_ID ? "upstream A" : "downstream B"}`,
    body: "probe-cascade — auto-cleanup at end of run",
    row_kind: "task",
    kind: "todo",
    priority: 2,
    status,
    sub_status: "",
    author_email: SUBJECT,
    approver_email: "",
    project_manager_email: "",
    requested_date: "",
    parent_id: "",
    round_number: 1,
    drive_folder_id: "",
    drive_folder_url: "",
    chat_space_id: "",
    chat_task_name: "",
    departments: "[]",
    mentions: "",
    google_tasks: "[]",
    calendar_event_ids: "{}",
    status_history: JSON.stringify(statusHistory),
    edited_at: "",
    updated_at: NOW,
    campaign: "",
    rank: -Date.now(),
    anchor: "general",
    author_name: "probe",
    resolved: false,
    revision_of: "",
    blocks: taskId === A_ID ? JSON.stringify([B_ID]) : "[]",
    blocked_by: JSON.stringify(blockedBy),
    umbrella_id: "",
    is_umbrella: "FALSE",
  };
}

async function appendRow(headers, cells) {
  const row = headers.map((h) => (h in cells ? cells[h] : ""));
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Comments",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

async function findRowByTaskId(headers, idx, taskId) {
  const all = await readAllRows();
  const colId = idx.get("id");
  for (let i = 1; i < all.length; i++) {
    if (String(all[i]?.[colId] ?? "") === taskId) {
      return { sheetRowIndex: i + 1, row: all[i] ?? [] };
    }
  }
  return null;
}

async function setCells(sheetRow, idx, patch) {
  const data = [];
  for (const [k, v] of Object.entries(patch)) {
    const i = idx.get(k);
    if (i == null) continue;
    data.push({
      range: `Comments!${colLetter(i + 1)}${sheetRow}`,
      values: [[v]],
    });
  }
  if (data.length === 0) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });
}

async function run() {
  console.log(`[probe] tag=${PROBE_TAG}  A=${A_ID}  B=${B_ID}`);

  const { headers, idx } = await readHeaders();
  for (const need of ["blocks", "blocked_by", "umbrella_id", "is_umbrella"]) {
    if (!idx.has(need)) {
      console.log(`[FAIL] missing required column ${need} — run scripts/add-dependency-headers.mjs --apply first`);
      process.exit(1);
    }
  }

  console.log("[1/6] Appending A (in_progress) and B (blocked, blocked_by=[A]) …");
  await appendRow(
    headers,
    buildCells(A_ID, "in_progress", [], [
      { at: NOW, by: SUBJECT, from: "", to: "in_progress", note: "probe-create" },
    ]),
  );
  await appendRow(
    headers,
    buildCells(B_ID, "blocked", [A_ID], [
      { at: NOW, by: SUBJECT, from: "", to: "blocked", note: "probe-create (blocked by A)" },
    ]),
  );

  console.log("[2/6] Re-reading B; verifying parsed shape …");
  const bRow = await findRowByTaskId(headers, idx, B_ID);
  if (!bRow) { console.log("[FAIL] couldn't find B after append"); process.exit(1); }
  const bStatus = String(bRow.row[idx.get("status")] ?? "");
  const bBlockedByRaw = String(bRow.row[idx.get("blocked_by")] ?? "");
  if (bStatus !== "blocked") { console.log(`[FAIL] B.status = ${bStatus}, expected blocked`); process.exit(1); }
  if (!bBlockedByRaw.includes(A_ID)) { console.log(`[FAIL] B.blocked_by = ${bBlockedByRaw}, expected to include A`); process.exit(1); }
  console.log(`    ✓ B.status=blocked, B.blocked_by=${bBlockedByRaw}`);

  console.log("[3/6] Patching A → done (simulating upstream completion) …");
  const aRow = await findRowByTaskId(headers, idx, A_ID);
  if (!aRow) { console.log("[FAIL] couldn't find A"); process.exit(1); }
  const completedNow = new Date().toISOString();
  await setCells(aRow.sheetRowIndex, idx, {
    status: "done",
    updated_at: completedNow,
    status_history: JSON.stringify([
      { at: NOW, by: SUBJECT, from: "", to: "in_progress", note: "probe-create" },
      { at: completedNow, by: SUBJECT, from: "in_progress", to: "done", note: "probe-complete" },
    ]),
  });
  console.log("    ✓ A is done");

  console.log("[4/6] Invoking cascadeAfterTerminal directly …");
  // Dynamic import — keeps script Node-runnable without manual transpile.
  const { cascadeAfterTerminal } = await import("../lib/dependencyCascade.ts");
  const cascade = await cascadeAfterTerminal({
    subjectEmail: SUBJECT,
    completedTaskId: A_ID,
    upstreamFinalStatus: "done",
    nowIso: completedNow,
    commentsSpreadsheetId: SHEET_ID,
    // Inject our already-built sheets client so the cascade module
    // doesn't need to dynamically import `@/lib/sa` (which fails
    // under `node --experimental-strip-types` since path aliases
    // aren't resolved by the runtime).
    sheets,
  });
  console.log(`    cascade result: unblocked=${cascade.unblocked.length}, stillBlocked=${cascade.stillBlocked.length}, errors=${cascade.errors.length}`);
  if (cascade.errors.length > 0) console.log(`    errors: ${cascade.errors.join("; ")}`);
  if (cascade.unblocked.length === 0) {
    console.log(`[FAIL] cascade did not unblock any task — expected B to be unblocked`);
    process.exit(1);
  }
  if (!cascade.unblocked.find((u) => u.taskId === B_ID)) {
    console.log(`[FAIL] cascade unblocked something but not B`);
    process.exit(1);
  }
  console.log(`    ✓ cascade unblocked B`);

  console.log("[5/6] Re-reading B; verifying transition + history …");
  const bRow2 = await findRowByTaskId(headers, idx, B_ID);
  if (!bRow2) { console.log("[FAIL] B disappeared"); process.exit(1); }
  const bStatus2 = String(bRow2.row[idx.get("status")] ?? "");
  const bHistRaw = String(bRow2.row[idx.get("status_history")] ?? "");
  if (bStatus2 !== "awaiting_handling") {
    console.log(`[FAIL] B.status = ${bStatus2}, expected awaiting_handling`);
    process.exit(1);
  }
  let hist;
  try { hist = JSON.parse(bHistRaw); } catch { hist = []; }
  const lastEntry = hist[hist.length - 1] || {};
  if (lastEntry.from !== "blocked" || lastEntry.to !== "awaiting_handling" || lastEntry.by !== "system") {
    console.log(`[FAIL] B.status_history last entry mismatch:`, JSON.stringify(lastEntry));
    process.exit(1);
  }
  console.log(`    ✓ B.status=awaiting_handling`);
  console.log(`    ✓ B.status_history last: ${JSON.stringify(lastEntry)}`);

  console.log("[6/6] Cleanup — marking both as cancelled with probe note …");
  const cleanupNow = new Date().toISOString();
  for (const [tid, srow] of [[A_ID, aRow.sheetRowIndex], [B_ID, bRow2.sheetRowIndex]]) {
    await setCells(srow, idx, {
      status: "cancelled",
      updated_at: cleanupNow,
    });
  }
  console.log(`    ✓ cleanup done. Rows are still in the sheet (cancelled, marked ${PROBE_TAG}); user can hand-delete if desired.`);

  console.log(`\nALL CHECKS PASSED ✅`);
}

run().catch((e) => {
  console.log("[FATAL]", e?.message || e);
  if (e?.response?.data) console.log("detail:", JSON.stringify(e.response.data));
  process.exit(1);
});
