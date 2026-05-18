/* eslint-disable */
/**
 * Clear the Keys `Chat Space` cell for every row that currently has
 * one — so createChatSpaceForProject (whose idempotency keys off this
 * cell) will create FRESH threaded spaces instead of returning the
 * old ones. Part of the delete+recreate-as-threaded migration.
 *
 * RUN scripts/backup-keys-chat-space.mjs FIRST (rollback safety).
 *
 *   node scripts/clear-keys-chat-space.mjs            # dry-run
 *   node scripts/clear-keys-chat-space.mjs --apply    # actually blank
 *
 * Env: TASKS_SA_KEY_JSON, SHEET_ID_MAIN from .env.local.
 */
import { google } from "googleapis";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");
const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
const env = (n) =>
  process.env[n] ||
  (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(
    /^[^=]+=/,
    "",
  );
const key = JSON.parse(env("TASKS_SA_KEY_JSON"));
const SHEET_ID_MAIN = env("SHEET_ID_MAIN");
if (!SHEET_ID_MAIN) {
  console.error("[FAIL] SHEET_ID_MAIN not in env");
  process.exit(1);
}
const jwt = new google.auth.JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: "maayan@fandf.co.il",
});
const sheets = google.sheets({ version: "v4", auth: jwt });
function columnLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_MAIN,
  range: "Keys",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = res.data.values ?? [];
const headers = (rows[0] ?? []).map((h) =>
  String(h ?? "")
    .replace(/[​-‏‪-‮⁠­﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim(),
);
const iProj = headers.indexOf("פרוייקט");
const iChat =
  headers.indexOf("Chat Space") >= 0
    ? headers.indexOf("Chat Space")
    : headers.indexOf("Chat Webhook");
if (iProj < 0 || iChat < 0) {
  console.error("[FAIL] Keys missing פרוייקט or Chat Space column");
  process.exit(1);
}
const colA1 = columnLetter(iChat + 1);

const toClear = [];
for (let r = 1; r < rows.length; r++) {
  const name = String(rows[r][iProj] ?? "").trim();
  const cell = String(rows[r][iChat] ?? "").trim();
  if (name && cell) toClear.push({ sheetRow: r + 1, name, cell });
}

console.log(
  `${toClear.length} Keys rows have a Chat Space cell to clear. Mode: ${
    APPLY ? "APPLY" : "dry-run"
  }`,
);
for (const t of toClear)
  console.log(`  row ${t.sheetRow}  "${t.name}"  (was: ${t.cell.slice(0, 60)})`);

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to blank these cells.");
  process.exit(0);
}
let n = 0;
for (const t of toClear) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID_MAIN,
    range: `Keys!${colA1}${t.sheetRow}`,
    valueInputOption: "RAW",
    requestBody: { values: [[""]] },
  });
  n++;
  console.log(`  ✓ cleared row ${t.sheetRow} "${t.name}"`);
}
console.log(`\nDone. Cleared ${n}/${toClear.length}.`);
