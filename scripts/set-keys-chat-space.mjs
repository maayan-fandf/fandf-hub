/* eslint-disable */
/**
 * One-row Keys update: write a Chat Space URL into Keys col L for a
 * specific project. Useful when Keys has the wrong space id (or none)
 * and you already know the correct one — bypasses needing the
 * chat.spaces.readonly DWD scope.
 *
 * Run:
 *   node scripts/set-keys-chat-space.mjs "<project>" "<space-id-or-url>" [<subject>]
 *
 * Examples:
 *   node scripts/set-keys-chat-space.mjs "אחוזת אפרידר" AAQAtikY5PY
 *   node scripts/set-keys-chat-space.mjs "כללי" "https://mail.google.com/chat/u/0/#chat/space/AAQAxxx"
 */

import { google } from "googleapis";
import fs from "node:fs";

const PROJECT = process.argv[2] || "";
const RAW = process.argv[3] || "";
const SUBJECT = process.argv[4] || "maayan@fandf.co.il";

if (!PROJECT || !RAW) {
  console.error('Usage: node scripts/set-keys-chat-space.mjs "<project>" "<space-id-or-url>" [<subject>]');
  process.exit(1);
}

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");

function loadKey() {
  const raw = env("TASKS_SA_KEY_JSON");
  if (!raw) throw new Error("TASKS_SA_KEY_JSON not set");
  return JSON.parse(raw);
}

function spaceIdFromAny(s) {
  const t = String(s).trim();
  if (!t) return "";
  let m;
  m = t.match(/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/([A-Za-z0-9_-]+)\/messages/); if (m) return m[1];
  m = t.match(/^https:\/\/chat\.google\.com\/(?:room|space)\/([A-Za-z0-9_-]+)/); if (m) return m[1];
  m = t.match(/[\/#]chat\/(?:space|room)\/([A-Za-z0-9_-]+)/); if (m) return m[1];
  m = t.match(/^(?:spaces\/)?([A-Za-z0-9_-]{8,})$/);
  return m ? m[1] : "";
}

function columnLetter(n) {
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const SHEET_ID_MAIN = env("SHEET_ID_MAIN");
if (!SHEET_ID_MAIN) { console.error("[FAIL] SHEET_ID_MAIN not in env"); process.exit(1); }

const id = spaceIdFromAny(RAW);
if (!id) { console.error(`[FAIL] couldn't parse a space id out of: ${RAW}`); process.exit(1); }
const url = `https://mail.google.com/chat/u/0/#chat/space/${id}`;

const k = loadKey();
const sheets = google.sheets({
  version: "v4",
  auth: new google.auth.JWT({
    email: k.client_email, key: k.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"], subject: SUBJECT,
  }),
});

const r = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_MAIN, range: "Keys", valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = r.data.values ?? [];
const headers = (rows[0] ?? []).map((h) => String(h ?? "").replace(/[​-‏‪-‮⁠­﻿]/g, "").replace(/\s+/g, " ").trim());
const iProj = headers.indexOf("פרוייקט");
const iChat = headers.indexOf("Chat Space") >= 0 ? headers.indexOf("Chat Space") : headers.indexOf("Chat Webhook");
if (iProj < 0 || iChat < 0) { console.error("[FAIL] Keys missing פרוייקט or Chat Space column"); process.exit(1); }

const target = PROJECT.toLowerCase().trim();
let rowIdx = -1, oldVal = "";
for (let i = 1; i < rows.length; i++) {
  if (String(rows[i][iProj] ?? "").trim().toLowerCase() === target) {
    rowIdx = i; oldVal = String(rows[i][iChat] ?? "").trim(); break;
  }
}
if (rowIdx < 0) { console.error(`[FAIL] project "${PROJECT}" not found in Keys`); process.exit(1); }

const sheetRow = rowIdx + 1;
const colA1 = columnLetter(iChat + 1);
console.log(`Project:   "${PROJECT}"  (Keys row ${sheetRow})`);
console.log(`Old cell:  "${oldVal}"`);
console.log(`New cell:  "${url}"`);

await sheets.spreadsheets.values.update({
  spreadsheetId: SHEET_ID_MAIN,
  range: `Keys!${colA1}${sheetRow}`,
  valueInputOption: "RAW",
  requestBody: { values: [[url]] },
});
console.log(`\n✓ Wrote.`);
console.log(`Hub will pick this up within Keys' 5min cache TTL, or instantly via:`);
console.log(`  https://hub.fandf.co.il/api/admin/debug-project?name=${encodeURIComponent(PROJECT)}&bust=1`);
