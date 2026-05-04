/* eslint-disable */
/**
 * One-shot: scrub stale closed/deleted GT refs from a single task
 * row's google_tasks cell. Useful after a bounce-loop cycle leaves
 * the cell with N refs all confirmed closed — the new pollTasks
 * reconciliation handles this gracefully via per-ref fetchOne
 * verification, but cleaning up the cell makes future debugging
 * easier (smaller `google_tasks` cell, less noise).
 *
 * Usage:
 *   node scripts/cleanup-stale-gt-refs.mjs T-moju0aon-07uo            # dry-run
 *   node scripts/cleanup-stale-gt-refs.mjs T-moju0aon-07uo --apply    # write
 *
 * Safety:
 *   - Only removes refs that fetchOne confirms as `completed` OR 404
 *     (deleted). Never removes refs that are currently `needsAction`
 *     or that return any other ambiguous state.
 *   - Per-recipient impersonation via SA — same auth path the
 *     production cron uses.
 */
import { google } from "googleapis";
import fs from "node:fs";

const TASK_ID = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!TASK_ID) {
  console.log("Usage: node scripts/cleanup-stale-gt-refs.mjs <task-id> [--apply]");
  process.exit(1);
}

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}
const SHEET_ID = process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");
const KEY_RAW = process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON");
const k = JSON.parse(KEY_RAW);
const SUBJECT_FALLBACK = "maayan@fandf.co.il";

function colLetter(n) {
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// SA client per impersonated user — match lib/sa.ts pattern.
function tasksApiAs(email) {
  const auth = new google.auth.JWT({
    email: k.client_email,
    key: k.private_key,
    scopes: ["https://www.googleapis.com/auth/tasks"],
    subject: email,
  });
  return google.tasks({ version: "v1", auth });
}

const sheetsAuth = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT_FALLBACK,
});
const sheets = google.sheets({ version: "v4", auth: sheetsAuth });

async function classifyRef(ref) {
  // Returns: 'open' | 'closed' | 'deleted' | 'unknown'
  if (!ref.t || !ref.l || !ref.u) return "unknown";
  try {
    const tasks = tasksApiAs(ref.u);
    const got = await tasks.tasks.get({ tasklist: ref.l, task: ref.t });
    return got.data.status === "completed" ? "closed" : "open";
  } catch (e) {
    const code = e?.code || e?.response?.status;
    if (code === 404) return "deleted";
    return "unknown";
  }
}

async function run() {
  console.log(`[1/4] Reading row ${TASK_ID} …`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Comments",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = res.data.values ?? [];
  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const idx = (n) => headers.indexOf(n);
  const colId = idx("id");
  const colGt = idx("google_tasks");
  if (colId < 0 || colGt < 0) { console.log("[FAIL] missing id or google_tasks column"); process.exit(1); }

  let rowIndex = -1;
  let row;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i]?.[colId] ?? "") === TASK_ID) { rowIndex = i + 1; row = values[i]; break; }
  }
  if (rowIndex < 0) { console.log(`[FAIL] row ${TASK_ID} not found`); process.exit(1); }
  console.log(`    ✓ found at sheet row ${rowIndex}`);

  let refs;
  try { refs = JSON.parse(row[colGt] ?? "[]"); }
  catch { console.log("[FAIL] google_tasks cell is not valid JSON"); process.exit(1); }
  console.log(`    ${refs.length} refs in cell`);

  console.log(`[2/4] Classifying each ref …`);
  const classified = [];
  for (const r of refs) {
    const cls = await classifyRef(r);
    classified.push({ ref: r, cls });
    console.log(`    ${r.t?.slice(0,8)}…  u=${r.u?.padEnd(22)}  kind=${(r.kind || 'todo').padEnd(8)}  → ${cls}`);
  }

  console.log(`[3/4] Filtering …`);
  // Keep: open + unknown (don't lose data on transient errors).
  // Drop: closed + deleted.
  const kept = classified.filter((c) => c.cls !== "closed" && c.cls !== "deleted").map((c) => c.ref);
  const dropped = classified.length - kept.length;
  console.log(`    keep ${kept.length}, drop ${dropped}`);

  if (dropped === 0) {
    console.log(`\nNothing to clean up. Done.`);
    return;
  }

  if (!APPLY) {
    console.log(`\n[4/4] DRY-RUN — pass --apply to write.`);
    console.log(`    Would write google_tasks cell with ${kept.length} kept refs:`);
    console.log(`    ${JSON.stringify(kept)}`);
    return;
  }

  console.log(`[4/4] Writing trimmed cell …`);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Comments!${colLetter(colGt + 1)}${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[JSON.stringify(kept)]] },
  });
  console.log(`    ✓ wrote ${kept.length} refs to row ${rowIndex}.`);
}

run().catch((e) => { console.log("[FATAL]", e?.message || e); process.exit(1); });
