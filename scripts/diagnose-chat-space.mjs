/* eslint-disable */
// Diagnostic: read Keys col L for אחוזת אפרידר, parse space ID, attempt Chat list.
// Run: node scripts/diagnose-chat-space.mjs
import { google } from "googleapis";
import fs from "node:fs";

// Hand-roll .env.local parsing — script is one-off; pulling in dotenv
// for this would require a dep install we don't need.
const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}

const TARGET = process.argv[2] || "אחוזת אפרידר";
const SUBJECT = process.argv[3] || "maayan@fandf.co.il";

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

function parseSpaceId(url) {
  if (!url) return "";
  let m;
  m = url.match(/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/([^/]+)\/messages/);
  if (m) return m[1];
  m = url.match(/^https:\/\/chat\.google\.com\/(?:room|space)\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  m = url.match(/[/#]chat\/(?:space|room)\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  m = url.trim().match(/^(?:spaces\/)?([A-Za-z0-9_-]{8,})$/);
  return m ? m[1] : "";
}

const SHEET_ID_MAIN = process.env.SHEET_ID_MAIN || envFromFile("SHEET_ID_MAIN");

if (!SHEET_ID_MAIN) {
  console.log("[FAIL] SHEET_ID_MAIN not in env");
  process.exit(1);
}

console.log(`Target project: "${TARGET}"`);
console.log(`Subject email: "${SUBJECT}"`);
console.log("---");

// Step 1 — read Keys and find the row.
const sheets = google.sheets({
  version: "v4",
  auth: jwt(["https://www.googleapis.com/auth/spreadsheets"], SUBJECT),
});
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
console.log("Headers:", headers);
const iProj = headers.indexOf("פרוייקט");
// Accept the new "Chat Space" name + the legacy "Chat Webhook"
// during the rename transition.
const iWebhook = headers.indexOf("Chat Space") >= 0
  ? headers.indexOf("Chat Space")
  : headers.indexOf("Chat Webhook");
console.log(`iProj=${iProj} iWebhook=${iWebhook}`);
if (iProj < 0 || iWebhook < 0) {
  console.log("[FAIL] Keys missing פרוייקט or Chat Space/Chat Webhook column");
  process.exit(1);
}

// Step 2 — find the matching row (case-insensitive).
const target = TARGET.toLowerCase().trim();
let webhookCell = "";
let projName = "";
let matchedRowIdx = -1;
for (let i = 1; i < rows.length; i++) {
  const name = String(rows[i][iProj] ?? "").trim();
  if (name.toLowerCase() === target) {
    webhookCell = String(rows[i][iWebhook] ?? "").trim();
    projName = name;
    matchedRowIdx = i;
    break;
  }
}
console.log(`Matched row index: ${matchedRowIdx} (project name as stored: "${projName}")`);
console.log(`Chat Webhook cell length: ${webhookCell.length}`);
console.log(`Chat Webhook cell (raw): ${JSON.stringify(webhookCell)}`);

if (!webhookCell) {
  // Show every project name in Keys + char-codes to check for invisible Unicode
  console.log("[INFO] No webhook cell. Listing all project names from Keys to check for Unicode mismatches:");
  for (let i = 1; i < rows.length; i++) {
    const name = String(rows[i][iProj] ?? "").trim();
    if (name && (name.includes("אפרידר") || name.includes(target.slice(0, 3)))) {
      const codes = [...name].map((c) => c.codePointAt(0).toString(16)).join(" ");
      console.log(`  row ${i}: "${name}"  codepoints: ${codes}`);
    }
  }
  process.exit(0);
}

// Step 3 — parse space ID.
const spaceId = parseSpaceId(webhookCell);
console.log(`Parsed space ID: "${spaceId}"`);
if (!spaceId) {
  console.log("[FAIL] Webhook URL didn't match any known shape.");
  process.exit(0);
}

// Step 4 — attempt Chat list.
console.log("---");
console.log(`Calling chat.spaces.messages.list as ${SUBJECT}...`);
const chat = google.chat({
  version: "v1",
  auth: jwt(
    [
      "https://www.googleapis.com/auth/chat.messages",
      "https://www.googleapis.com/auth/chat.messages.readonly",
    ],
    SUBJECT.toLowerCase().endsWith("@fandf.co.il") ? SUBJECT : "maayan@fandf.co.il",
  ),
});
try {
  const r = await chat.spaces.messages.list({
    parent: `spaces/${spaceId}`,
    pageSize: 5,
    orderBy: "createTime desc",
  });
  const msgs = r.data.messages ?? [];
  console.log(`[OK] Got ${msgs.length} messages.`);
  msgs.slice(0, 3).forEach((m, i) => {
    console.log(
      `  ${i}: ${m.sender?.displayName || m.sender?.name || "?"} @ ${m.createTime}: ${(m.text || "").slice(0, 80)}`,
    );
  });

  // Step 5 — try directory lookup for the first non-empty sender id.
  console.log("---");
  const firstNumericSender = msgs.find((m) => {
    const id = (m.sender?.name || "").replace("users/", "");
    return /^\d+$/.test(id);
  });
  if (!firstNumericSender) {
    console.log("[skip] No numeric-id sender to look up.");
  } else {
    const userId = firstNumericSender.sender.name.replace("users/", "");
    console.log(`Calling admin.users.get(userKey="${userId}") as ${SUBJECT}...`);
    try {
      const directory = google.admin({
        version: "directory_v1",
        auth: jwt(
          ["https://www.googleapis.com/auth/admin.directory.user.readonly"],
          SUBJECT.toLowerCase().endsWith("@fandf.co.il") ? SUBJECT : "maayan@fandf.co.il",
        ),
      });
      const r = await directory.users.get({ userKey: userId });
      console.log(`[OK] primaryEmail: ${r.data.primaryEmail}`);
      console.log(`[OK] fullName: ${r.data.name?.fullName}`);
    } catch (e) {
      console.log("[FAIL] Directory call errored:");
      console.log(`  code: ${e?.response?.status} message: ${e?.message?.slice(0, 240)}`);
      if (e?.response?.data?.error) {
        console.log(`  error.status: ${e.response.data.error.status}`);
        console.log(`  error.message: ${e.response.data.error.message}`);
      }
    }
  }
} catch (e) {
  console.log("[FAIL] Chat API call errored:");
  console.log(`  code: ${e?.response?.status} message: ${e?.message?.slice(0, 200)}`);
  if (e?.response?.data?.error) {
    console.log(`  error.status: ${e.response.data.error.status}`);
    console.log(`  error.message: ${e.response.data.error.message}`);
  }
}
