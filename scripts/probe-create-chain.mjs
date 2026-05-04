/* eslint-disable */
/**
 * STATUS: SKIP under direct `node --experimental-strip-types` —
 * this probe tries to import `lib/tasksCreateChain.ts` which
 * transitively pulls in `@/lib/*` modules whose Next.js path
 * aliases aren't resolved by Node's runtime. To run the chain
 * end-to-end use either:
 *   (a) the UI flow once phase 5b lands ("צור כשרשרת" toggle)
 *   (b) HTTP POST to /api/worktasks/create-chain via the dev server
 *
 * The orchestrator's correctness is otherwise covered by:
 *   - TS compile (proves payload + return shape)
 *   - phase-1 cycle-check unit tests (covers wouldCreateCycle)
 *   - phase-2/3 probes (cover tasksCreateDirect path with id +
 *     blocked_by + umbrella_id payloads, which is what the
 *     chain orchestrator stitches together)
 *
 * End-to-end probe for phase-5 chain creation.
 *
 * Sequence:
 *   1. Call tasksCreateChainDirect with a 4-step "FB ads visual"
 *      chain (copy → art → studio → media) — but use placeholder
 *      assignees=[] so we don't pollute real users' Google Tasks.
 *   2. Read all 5 created rows back from the sheet.
 *   3. Verify wiring:
 *        - umbrella row has is_umbrella=TRUE, no GTs, no Drive folder
 *        - children all have umbrella_id = umbrella.id
 *        - blocks/blocked_by chain: copy.blocks=[art], art.blocked_by=[copy], etc.
 *        - status: copy=awaiting_handling, art/studio/media=blocked
 *   4. Cleanup — cancel all 5.
 *
 * Run: node scripts/probe-create-chain.mjs
 *
 * SAFE: writes 5 rows to live Comments tab marked PROBE-CHAIN-<tag>
 * in project + title. All end the run as cancelled. Project not in
 * production use yet so this is acceptable.
 *
 * NOTE: this probe imports tasksCreateChainDirect which itself
 * imports tasksCreateDirect → which transitively pulls Drive folder
 * creation, GT spawn, notifications, etc. We pass assignees=[] +
 * skip drive_folder_id so the side effects all no-op naturally.
 * Drive folder creation for child rows would still fire — to keep
 * this probe self-contained we use a unique project name that has
 * no Keys row, so the Drive folder builder fails silently and the
 * row still writes (best-effort). Acceptable for a probe.
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

// Set the env vars the lib/sa.ts loader expects.
process.env.TASKS_SA_KEY_JSON = KEY_RAW;
process.env.SHEET_ID_COMMENTS = SHEET_ID;

const k = JSON.parse(KEY_RAW);
const auth = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth });

const TAG = `PROBE-CHAIN-${Date.now().toString(36)}`;

function colLetter(n) { let s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

async function readHeaders() {
  const got = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Comments!1:1" });
  const headers = (got.data.values?.[0] ?? []).map((h) => String(h ?? "").trim());
  const idx = new Map(); headers.forEach((h, i) => idx.set(h, i));
  return { headers, idx };
}
async function readRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: "Comments",
    valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING",
  });
  return res.data.values ?? [];
}
async function findById(idx, taskId) {
  const all = await readRows();
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

async function run() {
  console.log(`[probe] tag=${TAG}`);
  const { idx } = await readHeaders();

  // Use the existing test project name so assertProjectAccess passes.
  // We'll filter results by the unique TAG marker in titles for cleanup.
  const PROJECT = "כללי";

  console.log("[1/4] Calling tasksCreateChainDirect with 4-step chain …");
  const { tasksCreateChainDirect } = await import("../lib/tasksCreateChain.ts");
  let result;
  try {
    result = await tasksCreateChainDirect(SUBJECT, {
      project: PROJECT,
      company: "F&F",
      brief: "",
      campaign: "",
      umbrella: { title: `${TAG} umbrella — FB ads visual` },
      steps: [
        { title: `${TAG} step1 copy`,   assignees: [] },
        { title: `${TAG} step2 art`,    assignees: [] },
        { title: `${TAG} step3 studio`, assignees: [] },
        { title: `${TAG} step4 media`,  assignees: [] },
      ],
    });
  } catch (e) {
    console.log("[FAIL] chain creation threw:", e?.message || e);
    process.exit(1);
  }
  console.log(`    ✓ created umbrella=${result.umbrella.id}`);
  console.log(`    ✓ created ${result.children.length} children: ${result.children.map((c) => c.id).join(", ")}`);

  console.log("[2/4] Re-reading all 5 rows from sheet …");
  const u = await findById(idx, result.umbrella.id);
  if (!u) { console.log("[FAIL] umbrella row not found in sheet"); process.exit(1); }
  const childRows = [];
  for (const c of result.children) {
    const r = await findById(idx, c.id);
    if (!r) { console.log(`[FAIL] child ${c.id} not found in sheet`); process.exit(1); }
    childRows.push(r);
  }
  console.log("    ✓ all 5 rows present");

  console.log("[3/4] Verifying wiring …");
  // Umbrella checks
  const uIs = String(u.row[idx.get("is_umbrella")] ?? "").toUpperCase();
  if (uIs !== "TRUE") { console.log(`[FAIL] umbrella is_umbrella = ${uIs}, expected TRUE`); process.exit(1); }
  const uGts = String(u.row[idx.get("google_tasks")] ?? "");
  if (uGts !== "" && uGts !== "[]") { console.log(`[FAIL] umbrella google_tasks = ${uGts}, expected empty`); process.exit(1); }
  const uDrive = String(u.row[idx.get("drive_folder_id")] ?? "");
  if (uDrive !== "") { console.log(`[FAIL] umbrella drive_folder_id = ${uDrive}, expected empty`); process.exit(1); }
  console.log(`    ✓ umbrella: is_umbrella=TRUE, no GTs, no Drive`);

  // Children checks
  for (let i = 0; i < childRows.length; i++) {
    const c = childRows[i];
    const childId = result.children[i].id;
    const ui = String(c.row[idx.get("umbrella_id")] ?? "");
    if (ui !== result.umbrella.id) { console.log(`[FAIL] child ${i} umbrella_id = ${ui}, expected ${result.umbrella.id}`); process.exit(1); }

    const blocks = JSON.parse(String(c.row[idx.get("blocks")] ?? "[]"));
    const blockedBy = JSON.parse(String(c.row[idx.get("blocked_by")] ?? "[]"));
    const status = String(c.row[idx.get("status")] ?? "");

    if (i === 0) {
      // First step: blocks=[next], blocked_by=[], status=awaiting_handling
      if (blocks.length !== 1 || blocks[0] !== result.children[1].id) {
        console.log(`[FAIL] child[0].blocks = ${JSON.stringify(blocks)}, expected [${result.children[1].id}]`); process.exit(1);
      }
      if (blockedBy.length !== 0) { console.log(`[FAIL] child[0].blocked_by = ${JSON.stringify(blockedBy)}, expected []`); process.exit(1); }
      if (status !== "awaiting_handling") { console.log(`[FAIL] child[0].status = ${status}, expected awaiting_handling`); process.exit(1); }
    } else if (i === childRows.length - 1) {
      // Last step: blocks=[], blocked_by=[prev], status=blocked
      if (blocks.length !== 0) { console.log(`[FAIL] child[last].blocks = ${JSON.stringify(blocks)}, expected []`); process.exit(1); }
      if (blockedBy.length !== 1 || blockedBy[0] !== result.children[i - 1].id) {
        console.log(`[FAIL] child[last].blocked_by mismatch`); process.exit(1);
      }
      if (status !== "blocked") { console.log(`[FAIL] child[last].status = ${status}, expected blocked`); process.exit(1); }
    } else {
      // Middle: blocks=[next], blocked_by=[prev], status=blocked
      if (blocks.length !== 1 || blocks[0] !== result.children[i + 1].id) {
        console.log(`[FAIL] child[${i}].blocks mismatch`); process.exit(1);
      }
      if (blockedBy.length !== 1 || blockedBy[0] !== result.children[i - 1].id) {
        console.log(`[FAIL] child[${i}].blocked_by mismatch`); process.exit(1);
      }
      if (status !== "blocked") { console.log(`[FAIL] child[${i}].status = ${status}, expected blocked`); process.exit(1); }
    }
    console.log(`    ✓ child[${i}] (${childId}): status=${status}, blocks=${blocks.length}, blocked_by=${blockedBy.length}`);
  }

  console.log("[4/4] Cleanup — cancel all 5 rows …");
  const now = new Date().toISOString();
  for (const id of [result.umbrella.id, ...result.children.map((c) => c.id)]) {
    const r = await findById(idx, id);
    if (r) await setCells(r.sheetRowIndex, idx, { status: "cancelled", updated_at: now });
  }
  console.log(`    ✓ cleanup done (rows kept, marked ${TAG})`);

  console.log(`\nALL CHECKS PASSED ✅`);
}

run().catch((e) => {
  console.log("[FATAL]", e?.message || e);
  if (e?.stack) console.log(e.stack);
  process.exit(1);
});
