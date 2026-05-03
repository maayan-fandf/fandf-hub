/* eslint-disable */
/**
 * Adds the four phase-1 dependency columns to the live Comments tab
 * header row IF they aren't already present:
 *   blocks, blocked_by, umbrella_id, is_umbrella
 *
 * Idempotent: re-running after success is a no-op.
 *
 * DRY-RUN by default. Pass --apply to actually mutate the sheet.
 *
 * Run:
 *   node scripts/add-dependency-headers.mjs           # dry-run preview
 *   node scripts/add-dependency-headers.mjs --apply   # write headers
 *
 * Order rationale: appended to the right of the current rightmost
 * header. Existing readers/writers resolve columns by header name
 * (see rowToTask + cells builder), so column order doesn't matter for
 * correctness — appending is the safest spot since it touches no
 * existing columns.
 */
import { google } from "googleapis";
import fs from "node:fs";

const NEW_HEADERS = ["blocks", "blocked_by", "umbrella_id", "is_umbrella"];
const APPLY = process.argv.includes("--apply");

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}

const SHEET_ID = process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");
const SUBJECT = "maayan@fandf.co.il";
const KEY_RAW = process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON");

if (!SHEET_ID) { console.log("[FAIL] SHEET_ID_COMMENTS not set"); process.exit(1); }
if (!KEY_RAW)  { console.log("[FAIL] TASKS_SA_KEY_JSON not set"); process.exit(1); }

const k = JSON.parse(KEY_RAW);
const auth = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth });

function colLetter(n) {
  // 1 -> A, 27 -> AA
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function run() {
  console.log(`[1/3] Reading current header row from Comments …`);
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Comments!1:1",
  });
  const headers = (got.data.values?.[0] ?? []).map((h) => String(h ?? "").trim());
  console.log(`    ✓ ${headers.length} existing headers`);
  console.log(`    rightmost: "${headers[headers.length - 1]}" (col ${colLetter(headers.length)})`);

  console.log(`[2/3] Computing diff …`);
  const present = new Set(headers);
  const missing = NEW_HEADERS.filter((h) => !present.has(h));
  if (missing.length === 0) {
    console.log(`    ✓ all 4 new headers already present — nothing to do.`);
    return;
  }
  console.log(`    missing: ${missing.join(", ")}`);
  const startCol = headers.length + 1; // 1-indexed col to write first new header into
  const endCol = headers.length + missing.length;
  const range = `Comments!${colLetter(startCol)}1:${colLetter(endCol)}1`;
  console.log(`    will append into range: ${range}`);

  if (!APPLY) {
    console.log(`\n[3/3] DRY-RUN — pass --apply to write.`);
    console.log(`    Action that WOULD execute:`);
    console.log(`      sheets.values.update(range="${range}", values=[${JSON.stringify(missing)}])`);
    return;
  }

  console.log(`[3/3] Writing headers …`);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [missing] },
  });
  console.log(`    ✓ wrote ${missing.length} headers.`);

  // Verify by re-reading
  const verify = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Comments!1:1",
  });
  const newHeaders = (verify.data.values?.[0] ?? []).map((h) => String(h ?? "").trim());
  const verified = NEW_HEADERS.every((h) => newHeaders.includes(h));
  console.log(`    verify: ${verified ? "✓ all 4 headers now present" : "✗ verification FAILED"}`);
}

run().catch((e) => {
  console.log("[FATAL]", e?.message || e);
  if (e?.response?.data) console.log("detail:", JSON.stringify(e.response.data));
  process.exit(1);
});
