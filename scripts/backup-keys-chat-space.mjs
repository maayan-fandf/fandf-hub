/* eslint-disable */
/**
 * Read-only: dump every Keys row's project / company / Chat Space cell
 * to a timestamped JSON file, so the delete+recreate-as-threaded
 * migration is fully reversible (restore the old pointers if needed)
 * and auditable.
 *
 * Usage:  node scripts/backup-keys-chat-space.mjs
 * Env: TASKS_SA_KEY_JSON, SHEET_ID_MAIN from .env.local.
 */
import { google } from "googleapis";
import fs from "node:fs";

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
const iCo = headers.indexOf("חברה");
const iChat =
  headers.indexOf("Chat Space") >= 0
    ? headers.indexOf("Chat Space")
    : headers.indexOf("Chat Webhook");
if (iProj < 0 || iChat < 0) {
  console.error("[FAIL] Keys missing פרוייקט or Chat Space column");
  process.exit(1);
}

const backup = [];
for (let r = 1; r < rows.length; r++) {
  const name = String(rows[r][iProj] ?? "").trim();
  if (!name) continue;
  backup.push({
    sheetRow: r + 1,
    project: name,
    company: iCo >= 0 ? String(rows[r][iCo] ?? "").trim() : "",
    chatSpaceCell: String(rows[r][iChat] ?? "").trim(),
  });
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = `keys-chat-space-backup-${stamp}.json`;
fs.writeFileSync(
  outFile,
  JSON.stringify(
    { takenAt: new Date().toISOString(), chatSpaceColIndex: iChat, rows: backup },
    null,
    2,
  ),
);
const withSpace = backup.filter((b) => b.chatSpaceCell).length;
console.log(
  `Backed up ${backup.length} Keys project rows (${withSpace} have a Chat Space cell) → ${outFile}`,
);
