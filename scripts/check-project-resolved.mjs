/* eslint-disable */
// Mirror getMyProjectsDirect's Keys → Project[] mapping and confirm
// that the project page's `projectMeta?.chatSpaceUrl` would resolve.
// Run: node scripts/check-project-resolved.mjs "<project>" [<subject>]
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");

const TARGET = process.argv[2] || "אחוזת אפרידר";
const SUBJECT = process.argv[3] || "maayan@fandf.co.il";
const HUB_ADMINS = new Set(["maayan@fandf.co.il", "nadav@fandf.co.il", "felix@fandf.co.il"]);

function chatSpaceUrlFromWebhook(webhookUrl) {
  if (!webhookUrl) return "";
  let id = "";
  let m = webhookUrl.match(/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/([A-Za-z0-9_-]+)\/messages/);
  if (m) id = m[1];
  if (!id) { m = webhookUrl.match(/^https:\/\/chat\.google\.com\/(?:room|space)\/([A-Za-z0-9_-]+)/); if (m) id = m[1]; }
  if (!id) { m = webhookUrl.match(/[\/#]chat\/(?:space|room)\/([A-Za-z0-9_-]+)/); if (m) id = m[1]; }
  if (!id) { m = webhookUrl.trim().match(/^(?:spaces\/)?([A-Za-z0-9_-]{8,})$/); if (m) id = m[1]; }
  if (!id) return "";
  return `https://mail.google.com/chat/u/0/#chat/space/${id}`;
}
function parseSpaceId(url) {
  if (!url) return "";
  let m;
  m = url.match(/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/([^\/]+)\/messages/); if (m) return m[1];
  m = url.match(/^https:\/\/chat\.google\.com\/(?:room|space)\/([A-Za-z0-9_-]+)/); if (m) return m[1];
  m = url.match(/[\/#]chat\/(?:space|room)\/([A-Za-z0-9_-]+)/); if (m) return m[1];
  m = url.trim().match(/^(?:spaces\/)?([A-Za-z0-9_-]{8,})$/);
  return m ? m[1] : "";
}

const key = JSON.parse(env("TASKS_SA_KEY_JSON"));
const auth = new google.auth.JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth });
const r = await sheets.spreadsheets.values.get({
  spreadsheetId: env("SHEET_ID_MAIN"),
  range: "Keys",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = r.data.values ?? [];
const headers = (rows[0] ?? []).map((h) => String(h ?? "").replace(/[​-‏‪-‮⁠­﻿]/g, "").replace(/\s+/g, " ").trim());

const iProj = headers.indexOf("פרוייקט");
const iCo = headers.indexOf("חברה");
const iClients = headers.indexOf("Email Client");
const iInternal = headers.indexOf("Access — internal only");
const iCf = headers.indexOf("Client-facing");
const iWebhook = headers.indexOf("Chat Space") >= 0 ? headers.indexOf("Chat Space") : headers.indexOf("Chat Webhook");

const lc = SUBJECT.toLowerCase().trim();
const isAdmin = HUB_ADMINS.has(lc);
console.log(`isAdmin=${isAdmin}  iProj=${iProj}  iWebhook=${iWebhook}`);

const target = TARGET.toLowerCase().trim();
const projects = [];
for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  const name = String(row[iProj] ?? "").trim();
  if (!name) continue;
  const clientsRaw = iClients >= 0 ? String(row[iClients] ?? "").toLowerCase() : "";
  const onClients = clientsRaw.includes(lc);
  const onStaff = (iInternal >= 0 && String(row[iInternal] ?? "").toLowerCase().includes(lc)) ||
                  (iCf >= 0 && String(row[iCf] ?? "").toLowerCase().includes(lc));
  const visible = isAdmin || onClients || onStaff || lc.endsWith("@fandf.co.il");
  if (!visible) continue;
  projects.push({
    name,
    company: iCo >= 0 ? String(row[iCo] ?? "").trim() : "",
    chatSpaceUrl: iWebhook >= 0 ? chatSpaceUrlFromWebhook(String(row[iWebhook] ?? "")) : "",
  });
}

const matches = projects.filter((p) => p.name === TARGET);
console.log(`\nProject[] entries with name === "${TARGET}":`);
matches.forEach((p, i) => {
  console.log(`  [${i}] company="${p.company}"  chatSpaceUrl="${p.chatSpaceUrl}"`);
});

const found = projects.find((p) => p.name === TARGET);
console.log(`\nfind() returned:`, found ? `{ name="${found.name}", company="${found.company}", chatSpaceUrl="${found.chatSpaceUrl}" }` : "undefined");
console.log(`parseSpaceId(chatSpaceUrl) → "${parseSpaceId(found?.chatSpaceUrl ?? "")}"`);
console.log(`\n=> Page would render ${parseSpaceId(found?.chatSpaceUrl ?? "") ? "CHAT TAB" : "EMPTY STATE"}.`);
