/* eslint-disable */
// Find legacy-format hub-spawned GTs in a user's tasklist that have
// no hub URL in their notes (so the existing orphan-scan misses them)
// but their title matches an active hub task by (title, project).
//
// Usage:  node scripts/find-legacy-gt-orphans.mjs <userEmail>
//
// Read-only. Output flags each candidate with the matching hub task
// id, status, and whether the cell already references this GT (in
// which case it's NOT an orphan — just a tracking quirk).
//
// Pattern detection: any of the kind-prefix titles
//   - "📋 לבצע ·"
//   - "🛠️ בעבודה ·"
//   - "✅ לאישור ·" (legacy approve, pre-2026-04 swap to 👀)
//   - "👀 לאישור ·"
//   - "❓ לבירור ·"
// followed by " · " separator splitting into {title, project}. Match
// against Comments sheet rows where row_kind=task and (title, project)
// equals.

import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}
function loadKey() {
  return JSON.parse(
    process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON"),
  );
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

const SUBJECT = (process.argv[2] || "").trim();
if (!SUBJECT) {
  console.error("Usage: node scripts/find-legacy-gt-orphans.mjs <userEmail>");
  process.exit(1);
}
const SHEET_ID_COMMENTS =
  process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");

const KIND_PREFIXES = [
  { prefix: "📋 לבצע", kind: "todo" },
  { prefix: "🛠️ בעבודה", kind: "todo" },
  { prefix: "👀 לאישור", kind: "approve" },
  { prefix: "✅ לאישור", kind: "approve" }, // legacy
  { prefix: "❓ לבירור", kind: "clarify" },
];

function parseHubFormatTitle(title) {
  if (!title) return null;
  // Strip a leading reissue marker (🔙 or legacy 🔄) before matching.
  const stripped = String(title)
    .replace(/^(?:🔙|🔄)\s+/, "")
    .trim();
  for (const { prefix, kind } of KIND_PREFIXES) {
    if (stripped.startsWith(prefix + " ·") || stripped.startsWith(prefix + " ⋅")) {
      // Title format: "<prefix> · <title> · <project>"
      const rest = stripped.slice(prefix.length).trim();
      // rest starts with the bullet + space; split by " · " to get [title, project]
      const parts = rest.split(/\s*[·⋅]\s*/).filter(Boolean);
      if (parts.length >= 2) {
        // First element is empty (consumed bullet); rest carries title + project.
        // Actually after slicing prefix, rest looks like "· title · project" → split → ["", "title", "project"]
        // Filter empties → ["title", "project"]
        const [hubTitle, hubProject] = parts;
        return { kind, hubTitle, hubProject };
      }
    }
  }
  return null;
}

const tasks = google.tasks({
  version: "v1",
  auth: jwt(["https://www.googleapis.com/auth/tasks"], SUBJECT),
});
const sheets = google.sheets({
  version: "v4",
  auth: jwt(["https://www.googleapis.com/auth/spreadsheets"], SUBJECT),
});

// 1. Pull user's open GTs.
const tlRes = await tasks.tasklists.list({ maxResults: 1 });
const list = tlRes.data.items?.[0];
if (!list) {
  console.error("No tasklist");
  process.exit(1);
}
let openGTs = [];
let pageToken;
do {
  const r = await tasks.tasks.list({
    tasklist: list.id,
    showCompleted: false,
    showHidden: false,
    maxResults: 100,
    pageToken,
  });
  openGTs = openGTs.concat(r.data.items || []);
  pageToken = r.data.nextPageToken;
} while (pageToken);

// 2. Read Comments sheet — task rows by (title, project).
const cRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: "Comments",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = cRes.data.values ?? [];
const headers = (rows[0] ?? []).map((h) => String(h ?? "").trim());
const I_ID = headers.indexOf("id");
const I_KIND = headers.indexOf("row_kind");
const I_STATUS = headers.indexOf("status");
const I_TITLE = headers.indexOf("title");
const I_PROJECT = headers.indexOf("project");
const I_GT = headers.indexOf("google_tasks");

const taskIndex = new Map(); // "title|project" → row info
for (let i = 1; i < rows.length; i++) {
  if (String(rows[i][I_KIND] ?? "").trim() !== "task") continue;
  const id = String(rows[i][I_ID] ?? "").trim();
  if (!id) continue;
  const title = String(rows[i][I_TITLE] ?? "").trim();
  const project = String(rows[i][I_PROJECT] ?? "").trim();
  const status = String(rows[i][I_STATUS] ?? "").trim();
  const gtRaw = String(rows[i][I_GT] ?? "");
  taskIndex.set(`${title}|${project}`, {
    id,
    title,
    project,
    status,
    gtRaw,
    sheetRow: i + 1,
  });
}

console.log(`Subject: ${SUBJECT}`);
console.log(`Open GTs: ${openGTs.length}`);
console.log(`Hub task rows indexed: ${taskIndex.size}\n`);

let suspects = 0;
for (const t of openGTs) {
  const parsed = parseHubFormatTitle(t.title);
  if (!parsed) continue;
  const notes = String(t.notes || "");
  const hasHubUrl = /https:\/\/hub\.fandf\.co\.il\/tasks\//.test(notes);
  const match = taskIndex.get(`${parsed.hubTitle}|${parsed.hubProject}`);
  if (!match) {
    suspects++;
    console.log(
      `  ⚠️  GT ${t.id}  "${t.title.slice(0, 70)}"  → NO matching hub task (title may have been edited or task deleted)`,
    );
    continue;
  }
  const cellHasGt = match.gtRaw.includes(t.id);
  if (cellHasGt) continue; // tracked already, not an orphan
  suspects++;
  console.log(
    `  ⚠️  GT ${t.id}  "${t.title.slice(0, 70)}"`,
  );
  console.log(
    `       → matches hub task ${match.id} (status=${match.status}, sheet row ${match.sheetRow})`,
  );
  console.log(`       → hub URL in notes? ${hasHubUrl ? "yes (should be tracked)" : "NO (legacy spawn)"}`);
  console.log(`       → kind detected: ${parsed.kind}`);
}
if (suspects === 0) {
  console.log("✓ No legacy hub-format GTs found in this user's list.");
}
console.log(`\nTotal suspects: ${suspects}`);
