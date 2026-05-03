/* eslint-disable */
// Quick check: does GT <id> exist in <userEmail>'s default tasklist,
// and what's its current status?
//
// Run from hub-next/:  node scripts/check-gt-alive.mjs <userEmail> <gtId>

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
  const raw =
    process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON");
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

const SUBJECT = (process.argv[2] || "").trim();
const GT_ID = (process.argv[3] || "").trim();
if (!SUBJECT || !GT_ID) {
  console.error("Usage: node scripts/check-gt-alive.mjs <userEmail> <gtId>");
  process.exit(1);
}

const tasksApi = google.tasks({
  version: "v1",
  auth: jwt(["https://www.googleapis.com/auth/tasks"], SUBJECT),
});
const tlRes = await tasksApi.tasklists.list({ maxResults: 5 });
const lists = tlRes.data.items || [];
console.log(`Subject: ${SUBJECT}`);
console.log(`Tasklists: ${lists.map((l) => l.title).join(", ")}`);

for (const l of lists) {
  try {
    const r = await tasksApi.tasks.get({ tasklist: l.id, task: GT_ID });
    console.log(`\n✓ Found in "${l.title}" (id=${l.id}):`);
    console.log(`  status:    ${r.data.status}`);
    console.log(`  title:     ${r.data.title}`);
    console.log(`  updated:   ${r.data.updated}`);
    console.log(`  completed: ${r.data.completed || "(open)"}`);
    process.exit(0);
  } catch (e) {
    const code = e?.response?.status;
    if (code === 404) {
      console.log(`  not in "${l.title}"`);
      continue;
    }
    console.log(`  error in "${l.title}": ${code} ${e?.message || e}`);
  }
}
console.log("\n✗ GT not found in any of the user's lists.");
