/* eslint-disable */
// Quick: dump a Chat space resource (displayName, type, member count, age)
// to figure out what an unfamiliar space ID is.
//
// Usage:  node scripts/inspect-chat-space.mjs <spaceIdOrFullName>
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local","utf8") : "";
function envFromFile(name){const l=envText.split("\n").find(x=>x.startsWith(name+"="));return l?l.replace(/^[^=]+=/,""):"";}
const arg = (process.argv[2]||"").trim();
if (!arg) { console.error("Usage: node scripts/inspect-chat-space.mjs <spaceId>"); process.exit(1); }
const fullName = arg.startsWith("spaces/") ? arg : `spaces/${arg}`;

const key = JSON.parse(process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON"));
const jwt = new google.auth.JWT({
  email: key.client_email, key: key.private_key,
  scopes: ["https://www.googleapis.com/auth/chat.spaces.readonly", "https://www.googleapis.com/auth/chat.messages.readonly"],
  subject: "maayan@fandf.co.il",
});
const chat = google.chat({version:"v1", auth:jwt});

try {
  const r = await chat.spaces.get({ name: fullName });
  console.log("Space:", JSON.stringify(r.data, null, 2));
} catch(e) {
  console.log("spaces.get error:", e?.response?.status, e?.message);
}

// List recent messages to gauge activity.
try {
  const r = await chat.spaces.messages.list({ parent: fullName, pageSize: 5 });
  const msgs = r.data.messages || [];
  console.log(`\nLast ${msgs.length} messages (most recent first):`);
  for (const m of msgs.slice(0, 5)) {
    console.log(`  ${m.createTime}  by ${m.sender?.name || "?"}: ${(m.text||"").slice(0,80)}`);
  }
} catch(e) {
  console.log("\nmessages.list error:", e?.response?.status, e?.message);
}
