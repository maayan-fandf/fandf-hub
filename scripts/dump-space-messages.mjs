/* eslint-disable */
// Dump messages from a Chat space and show which would be filtered
// by the InternalDiscussionTab read-side cross-post filter.
// Run: node scripts/dump-space-messages.mjs <spaceId> [<subject>]
import { google } from "googleapis";
import fs from "node:fs";

const SPACE_ID = process.argv[2] || "";
const SUBJECT = process.argv[3] || "maayan@fandf.co.il";
if (!SPACE_ID) { console.error("Usage: node scripts/dump-space-messages.mjs <spaceId>"); process.exit(1); }

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");

const k = JSON.parse(env("TASKS_SA_KEY_JSON"));
const auth = new google.auth.JWT({
  email: k.client_email, key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/chat.messages", "https://www.googleapis.com/auth/chat.messages.readonly"],
  subject: SUBJECT,
});
const chat = google.chat({ version: "v1", auth });

const r = await chat.spaces.messages.list({ parent: `spaces/${SPACE_ID}`, pageSize: 50, orderBy: "createTime desc" });
const msgs = r.data.messages ?? [];

const AUTO_PREFIXES = ["↩️", "✅", "📋", "💬"];
const isTaskCrossPost = (text) => AUTO_PREFIXES.some((p) => text.startsWith(p)) && /\/tasks\/[\w-]+/.test(text);

console.log(`Space ${SPACE_ID}: ${msgs.length} messages\n`);
let filtered = 0;
for (let i = 0; i < msgs.length; i++) {
  const m = msgs[i];
  const text = m.text || "";
  const drop = isTaskCrossPost(text);
  if (drop) filtered++;
  console.log(`[${i}] ${drop ? "✗ FILTERED" : "✓ shown   "}  ${m.createTime}`);
  console.log(`     ${text.slice(0, 200).replace(/\n/g, " ⏎ ")}`);
  console.log("");
}
console.log(`Summary: ${msgs.length - filtered} would render in the tab, ${filtered} hidden by isTaskCrossPost filter.`);
