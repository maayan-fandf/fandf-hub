/* eslint-disable */
/**
 * Probe whether the old BMBY tab's `is_meeting` boolean is redundant
 * with `סטאטוס` startsWith "פגישה" (or any other simple status pattern).
 *
 * Approach: walk all old-BMBY rows, build a 2x2 confusion matrix of
 * (is_meeting=1, status_in_meeting_set) and surface any discrepancies.
 * If we find clean 1:1 alignment, we can safely derive is_meeting from
 * סטאטוס in the new schema without consulting the upstream owner.
 *
 * Also dumps:
 *   - all distinct status values that show is_meeting=1, with counts
 *   - all distinct status values that show is_meeting=0, with counts
 *   - any row where is_meeting=1 but סטאטוס is empty (these would
 *     break a status-based derivation)
 */
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local","utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find(l=>l.startsWith(n+"="))||"").replace(/^[^=]+=/,"");
const k = JSON.parse(env("TASKS_SA_KEY_JSON"));

const OLD_BMBY_SHEET = "1YOL2RryfXlHPvg0iT5TsLCxkm7L-iTMrAEBWh5Q4Qpc";

const jwt = new google.auth.JWT({
  email: k.client_email, key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: "maayan@fandf.co.il",
});
const sheets = google.sheets({ version: "v4", auth: jwt });

console.log("Reading old BMBY tab...");
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: OLD_BMBY_SHEET,
  range: "BMBY!A1:AK10000",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = res.data.values || [];
const headers = (rows[0] || []).map((h) => String(h ?? "").trim());
const iStatus = headers.indexOf("סטאטוס");
const iStage = headers.indexOf("שלב מכירה");
const iMeeting = headers.indexOf("is_meeting");
console.log("Header positions:", { iStatus, iStage, iMeeting });
console.log("Data rows:", rows.length - 1);

// Confusion matrix counts
let bothPos = 0;        // is_meeting=1 AND status starts פגישה
let bothNeg = 0;        // is_meeting=0 AND status doesn't start פגישה
let meetingButNotPgisha = 0;   // is_meeting=1 but status doesn't start פגישה
let pgishaButNotMeeting = 0;   // status starts פגישה but is_meeting=0

const statusByMeetingFlag = new Map(); // "1"|"0" -> Map<status, count>
const discrepancies = [];

for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  const meetingRaw = String(row[iMeeting] ?? "").trim();
  const status = String(row[iStatus] ?? "").trim();
  const stage = String(row[iStage] ?? "").trim();
  const isMeeting = meetingRaw === "1" || meetingRaw.toLowerCase() === "true";
  const startsPgisha = status.startsWith("פגישה");

  if (isMeeting && startsPgisha) bothPos++;
  else if (!isMeeting && !startsPgisha) bothNeg++;
  else if (isMeeting && !startsPgisha) {
    meetingButNotPgisha++;
    if (discrepancies.length < 10) {
      discrepancies.push({ row: i + 1, type: "meeting=1 but status not פגישה", status, stage });
    }
  } else if (!isMeeting && startsPgisha) {
    pgishaButNotMeeting++;
    if (discrepancies.length < 10) {
      discrepancies.push({ row: i + 1, type: "status starts פגישה but meeting=0", status, stage });
    }
  }

  const bucket = isMeeting ? "1" : "0";
  let m = statusByMeetingFlag.get(bucket);
  if (!m) { m = new Map(); statusByMeetingFlag.set(bucket, m); }
  m.set(status, (m.get(status) || 0) + 1);
}

const total = rows.length - 1;
console.log("\n── Confusion matrix: is_meeting vs status.startsWith('פגישה') ──");
console.log(`                       startsWith('פגישה')   not                  `);
console.log(`is_meeting=1           ${String(bothPos).padStart(6)}                ${String(meetingButNotPgisha).padStart(6)}`);
console.log(`is_meeting=0           ${String(pgishaButNotMeeting).padStart(6)}                ${String(bothNeg).padStart(6)}`);
console.log(`Total rows: ${total}`);
console.log(`Agreement rate: ${(((bothPos + bothNeg) / total) * 100).toFixed(2)}%`);

if (discrepancies.length > 0) {
  console.log("\n── Sample discrepancies (up to 10) ──");
  for (const d of discrepancies) {
    console.log(`  row ${d.row} | ${d.type}`);
    console.log(`    סטאטוס:     "${d.status}"`);
    console.log(`    שלב מכירה: "${d.stage}"`);
  }
}

console.log("\n── Top status values when is_meeting=1 ──");
const m1 = statusByMeetingFlag.get("1") || new Map();
const top1 = [...m1.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [st, c] of top1) console.log(`  ${String(c).padStart(5)}  "${st}"`);

console.log("\n── Top status values when is_meeting=0 ──");
const m0 = statusByMeetingFlag.get("0") || new Map();
const top0 = [...m0.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [st, c] of top0) console.log(`  ${String(c).padStart(5)}  "${st}"`);

// Also try alternative derivations
console.log("\n── Alternative derivations comparison ──");
let bothPosStage = 0, bothNegStage = 0;
for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  const meetingRaw = String(row[iMeeting] ?? "").trim();
  const stage = String(row[iStage] ?? "").trim();
  const isMeeting = meetingRaw === "1" || meetingRaw.toLowerCase() === "true";
  const stageHasPgisha = stage.includes("פגישה");
  if (isMeeting && stageHasPgisha) bothPosStage++;
  else if (!isMeeting && !stageHasPgisha) bothNegStage++;
}
console.log(`Derivation A — status.startsWith('פגישה'): ${(((bothPos + bothNeg) / total) * 100).toFixed(2)}% match`);
console.log(`Derivation B — stage.includes('פגישה'):    ${(((bothPosStage + bothNegStage) / total) * 100).toFixed(2)}% match`);
