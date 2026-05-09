/* eslint-disable */
// One-off: revert a specific task's status to ממתין לטיפול and clear
// any pending_complete flag. Used to clean up the 2026-05-05 sapir
// incident on T-morbhf3w-lfvi (GT dismissal at 9pm flipped the hub
// to ממתין לאישור pre-fix). Run after the banner-based confirmation
// fix is deployed so the unstick doesn't get re-flipped on next poll.
//
// Run from hub-next/:
//   node scripts/unstick-task-status.mjs T-morbhf3w-lfvi
import fs from "node:fs";
import { google } from "googleapis";

const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
const env = (n) =>
  process.env[n] ||
  (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(
    /^[^=]+=/,
    "",
  );

const TASK_ID = process.argv[2] || "T-morbhf3w-lfvi";
const TARGET_STATUS = process.argv[3] || "awaiting_handling";
const SUBJECT = "maayan@fandf.co.il";

const key = JSON.parse(env("TASKS_SA_KEY_JSON"));
const auth = new google.auth.JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth });
const ssId = env("SHEET_ID_COMMENTS");

console.log(`Unsticking task ${TASK_ID} → ${TARGET_STATUS}`);

const r = await sheets.spreadsheets.values.get({
  spreadsheetId: ssId,
  range: "Comments",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const values = r.data.values ?? [];
const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
const idx = (name) => headers.indexOf(name);

const iId = idx("id");
const iRowKind = idx("row_kind");
const iStatus = idx("status");
const iPending = idx("pending_complete");
const iHist = idx("status_history");
const iUpdated = idx("updated_at");

if (iId < 0 || iStatus < 0) {
  console.error("Required columns missing:", { iId, iStatus });
  process.exit(1);
}

let rowIndex = -1;
for (let i = 1; i < values.length; i++) {
  if (
    String(values[i][iId] ?? "") === TASK_ID &&
    (iRowKind < 0 || String(values[i][iRowKind] ?? "").trim() === "task")
  ) {
    rowIndex = i;
    break;
  }
}
if (rowIndex < 0) {
  console.error(`Task not found: ${TASK_ID}`);
  process.exit(1);
}

const currentStatus = String(values[rowIndex][iStatus] ?? "");
const currentPending = String(values[rowIndex][iPending] ?? "");
console.log(
  `Current state: status=${currentStatus} pending_complete=${currentPending ? "(set)" : "(empty)"}`,
);

if (currentStatus === TARGET_STATUS && !currentPending) {
  console.log("✓ Already in target state — nothing to do.");
  process.exit(0);
}

// Append a status_history entry recording the manual unstick so the
// audit trail explains what happened.
let hist = [];
try {
  const raw = String(values[rowIndex][iHist] ?? "[]");
  hist = JSON.parse(raw);
  if (!Array.isArray(hist)) hist = [];
} catch {
  hist = [];
}
hist.push({
  from: currentStatus,
  to: TARGET_STATUS,
  by: SUBJECT,
  at: new Date().toISOString(),
  note: "תיקון ידני — ביטול שינוי סטטוס אוטומטי שגוי (2026-05-05)",
});

// Build the per-cell updates.
const colLetter = (n) => {
  let s = "";
  let x = n;
  while (x >= 0) {
    s = String.fromCharCode((x % 26) + 65) + s;
    x = Math.floor(x / 26) - 1;
  }
  return s;
};
const sheetRow = rowIndex + 1; // 1-based
const updates = [
  {
    range: `Comments!${colLetter(iStatus)}${sheetRow}`,
    values: [[TARGET_STATUS]],
  },
  {
    range: `Comments!${colLetter(iHist)}${sheetRow}`,
    values: [[JSON.stringify(hist)]],
  },
];
if (iPending >= 0) {
  updates.push({
    range: `Comments!${colLetter(iPending)}${sheetRow}`,
    values: [[""]],
  });
}
if (iUpdated >= 0) {
  updates.push({
    range: `Comments!${colLetter(iUpdated)}${sheetRow}`,
    values: [[new Date().toISOString()]],
  });
}

await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: ssId,
  requestBody: { valueInputOption: "RAW", data: updates },
});

console.log(`✓ Unstuck. Status now ${TARGET_STATUS}.`);
console.log("  History entry appended.");
console.log(`  Cleared pending_complete (${currentPending ? "was set" : "was empty"}).`);
