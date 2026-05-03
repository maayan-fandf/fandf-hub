/* eslint-disable */
// Dump every open GT in <userEmail>'s default tasklist that links to
// hub task <hubTaskId>. Use to chase the case where a hub task is
// `done` but the user still sees it as a needsAction GT.
//
// Usage: node scripts/check-user-open-gts.mjs <userEmail> <hubTaskId>

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
const HUB_TASK_ID = (process.argv[3] || "").trim();
if (!SUBJECT || !HUB_TASK_ID) {
  console.error("Usage: node scripts/check-user-open-gts.mjs <userEmail> <hubTaskId>");
  process.exit(1);
}

const tasks = google.tasks({
  version: "v1",
  auth: jwt(["https://www.googleapis.com/auth/tasks"], SUBJECT),
});

const tlRes = await tasks.tasklists.list({ maxResults: 5 });
const lists = tlRes.data.items || [];
console.log(`Subject: ${SUBJECT}`);
console.log(`Looking for hub task: ${HUB_TASK_ID}`);
console.log(`Tasklists: ${lists.length}\n`);

for (const list of lists) {
  console.log(`── List: ${list.title} (${list.id})`);
  let pageToken;
  let openCount = 0;
  let matchCount = 0;
  do {
    const r = await tasks.tasks.list({
      tasklist: list.id,
      showCompleted: false,
      showHidden: false,
      maxResults: 100,
      pageToken,
    });
    for (const t of r.data.items || []) {
      openCount++;
      const notes = t.notes || "";
      const titleHasId = (t.title || "").includes(HUB_TASK_ID);
      const notesHasId = notes.includes(HUB_TASK_ID);
      if (titleHasId || notesHasId) {
        matchCount++;
        console.log(`\n  • id:     ${t.id}`);
        console.log(`    title:   ${t.title}`);
        console.log(`    status:  ${t.status}`);
        console.log(`    updated: ${t.updated}`);
        console.log(`    notes (${notes.split("\n").length} lines):`);
        for (const ln of notes.split("\n").slice(0, 10)) {
          console.log(`      | ${ln}`);
        }
      }
    }
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  console.log(`  total open: ${openCount}, matching ${HUB_TASK_ID}: ${matchCount}`);
}
