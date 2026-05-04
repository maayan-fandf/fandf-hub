/* eslint-disable */
/**
 * End-to-end probe for phase-4 umbrella status recompute.
 *
 * Sequence:
 *   1. Append 1 umbrella row U + 2 children C1 (in_progress) + C2 (blocked)
 *      with C1.umbrella_id = C2.umbrella_id = U.id
 *   2. Verify U currently has its CREATE-TIME status (we'll write
 *      "awaiting_handling" so we can see it shift)
 *   3. Call recomputeUmbrellaStatus directly
 *      → expect U → in_progress (any active child)
 *   4. Patch C1 → done, recompute
 *      → expect U → awaiting_handling (only blocked + done left)
 *   5. Patch C2 → done, recompute
 *      → expect U → done (all children done)
 *   6. Cleanup: cancel all 3 rows, mark with PROBE-UMBRELLA tag
 *
 * Run: node scripts/probe-umbrella-recompute.mjs
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
if (!SHEET_ID || !KEY_RAW) { console.log("[FAIL] env not set"); process.exit(1); }

const k = JSON.parse(KEY_RAW);
const auth = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth });

const TAG = `PROBE-UMBRELLA-${Date.now().toString(36)}`;
const U_ID = `T-probeU-${Date.now().toString(36)}`;
const C1_ID = `T-probeC1-${Date.now().toString(36)}`;
const C2_ID = `T-probeC2-${Date.now().toString(36)}`;
const NOW = new Date().toISOString();

function colLetter(n) {
  let s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s;
}

async function readHeaders() {
  const got = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Comments!1:1" });
  const headers = (got.data.values?.[0] ?? []).map((h) => String(h ?? "").trim());
  const idx = new Map(); headers.forEach((h, i) => idx.set(h, i));
  return { headers, idx };
}
async function readAllRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: "Comments",
    valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING",
  });
  return res.data.values ?? [];
}

function buildCells({ id, status, isUmbrella, umbrellaId, title }) {
  return {
    id, timestamp: NOW, project: TAG, company: "PROBE",
    title, body: "probe-umbrella — auto-cleanup at end of run",
    row_kind: "task", kind: "todo", priority: 2, status,
    sub_status: "", author_email: SUBJECT,
    approver_email: "", project_manager_email: "",
    requested_date: "", parent_id: "", round_number: 1,
    drive_folder_id: "", drive_folder_url: "",
    chat_space_id: "", chat_task_name: "",
    departments: "[]", mentions: "", google_tasks: "[]",
    calendar_event_ids: "{}",
    status_history: JSON.stringify([{ at: NOW, by: SUBJECT, from: "", to: status, note: "probe-create" }]),
    edited_at: "", updated_at: NOW, campaign: "",
    rank: -Date.now(), anchor: "general", author_name: "probe",
    resolved: false, revision_of: "",
    blocks: "[]", blocked_by: "[]",
    umbrella_id: umbrellaId, is_umbrella: isUmbrella ? "TRUE" : "FALSE",
  };
}

async function appendRow(headers, cells) {
  const row = headers.map((h) => (h in cells ? cells[h] : ""));
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: "Comments",
    valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

async function findRow(headers, idx, taskId) {
  const all = await readAllRows();
  const colId = idx.get("id");
  for (let i = 1; i < all.length; i++) {
    if (String(all[i]?.[colId] ?? "") === taskId) return { sheetRowIndex: i + 1, row: all[i] ?? [] };
  }
  return null;
}

async function setCells(sheetRow, idx, patch) {
  const data = [];
  for (const [k, v] of Object.entries(patch)) {
    const i = idx.get(k); if (i == null) continue;
    data.push({ range: `Comments!${colLetter(i + 1)}${sheetRow}`, values: [[v]] });
  }
  if (data.length === 0) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID, requestBody: { valueInputOption: "RAW", data },
  });
}

async function getStatus(taskId, idx) {
  const r = await findRow((await readHeaders()).headers, idx, taskId);
  if (!r) throw new Error(`row ${taskId} not found`);
  return String(r.row[idx.get("status")] ?? "");
}

async function run() {
  console.log(`[probe] tag=${TAG}  U=${U_ID}  C1=${C1_ID}  C2=${C2_ID}`);
  const { headers, idx } = await readHeaders();
  const { recomputeUmbrellaStatus } = await import("../lib/umbrellaRecompute.ts");

  console.log("[1/6] Appending U(awaiting_handling, is_umbrella=TRUE) + C1(in_progress) + C2(blocked) …");
  await appendRow(headers, buildCells({ id: U_ID, status: "awaiting_handling", isUmbrella: true, umbrellaId: "", title: `${TAG} umbrella` }));
  await appendRow(headers, buildCells({ id: C1_ID, status: "in_progress", isUmbrella: false, umbrellaId: U_ID, title: `${TAG} child 1` }));
  await appendRow(headers, buildCells({ id: C2_ID, status: "blocked", isUmbrella: false, umbrellaId: U_ID, title: `${TAG} child 2` }));

  console.log("[2/6] Verifying U starts at awaiting_handling …");
  const s0 = await getStatus(U_ID, idx);
  if (s0 !== "awaiting_handling") { console.log(`[FAIL] U starts at ${s0}, expected awaiting_handling`); process.exit(1); }
  console.log("    ✓ U=awaiting_handling");

  console.log("[3/6] Recomputing — expect U → in_progress (any active child) …");
  const r1 = await recomputeUmbrellaStatus({
    subjectEmail: SUBJECT, umbrellaId: U_ID,
    commentsSpreadsheetId: SHEET_ID, nowIso: new Date().toISOString(), sheets,
  });
  console.log("    recompute:", JSON.stringify(r1));
  const s1 = await getStatus(U_ID, idx);
  if (s1 !== "in_progress") { console.log(`[FAIL] U after recompute = ${s1}, expected in_progress`); process.exit(1); }
  console.log(`    ✓ U=in_progress`);

  console.log("[4/6] Patch C1 → done, recompute — expect U → awaiting_handling (blocked + done) …");
  const c1Row = await findRow(headers, idx, C1_ID);
  await setCells(c1Row.sheetRowIndex, idx, { status: "done", updated_at: new Date().toISOString() });
  const r2 = await recomputeUmbrellaStatus({
    subjectEmail: SUBJECT, umbrellaId: U_ID,
    commentsSpreadsheetId: SHEET_ID, nowIso: new Date().toISOString(), sheets,
  });
  console.log("    recompute:", JSON.stringify(r2));
  const s2 = await getStatus(U_ID, idx);
  if (s2 !== "awaiting_handling") { console.log(`[FAIL] U = ${s2}, expected awaiting_handling`); process.exit(1); }
  console.log(`    ✓ U=awaiting_handling`);

  console.log("[5/6] Patch C2 → done, recompute — expect U → done (all done) …");
  const c2Row = await findRow(headers, idx, C2_ID);
  await setCells(c2Row.sheetRowIndex, idx, { status: "done", updated_at: new Date().toISOString() });
  const r3 = await recomputeUmbrellaStatus({
    subjectEmail: SUBJECT, umbrellaId: U_ID,
    commentsSpreadsheetId: SHEET_ID, nowIso: new Date().toISOString(), sheets,
  });
  console.log("    recompute:", JSON.stringify(r3));
  const s3 = await getStatus(U_ID, idx);
  if (s3 !== "done") { console.log(`[FAIL] U = ${s3}, expected done`); process.exit(1); }
  console.log(`    ✓ U=done`);

  console.log("[6/6] Cleanup — cancel all 3 …");
  const now2 = new Date().toISOString();
  for (const tid of [U_ID, C1_ID, C2_ID]) {
    const r = await findRow(headers, idx, tid);
    if (r) await setCells(r.sheetRowIndex, idx, { status: "cancelled", updated_at: now2 });
  }
  console.log(`    ✓ cleanup done (rows kept, marked ${TAG})`);
  console.log(`\nALL CHECKS PASSED ✅`);
}

run().catch((e) => {
  console.log("[FATAL]", e?.message || e);
  if (e?.response?.data) console.log("detail:", JSON.stringify(e.response.data));
  process.exit(1);
});
