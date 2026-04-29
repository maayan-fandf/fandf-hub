/* eslint-disable */
// Diagnostic: verify the gmail.readonly DWD scope is granted in
// Workspace Admin → Security → API controls → Domain-wide delegation
// for SA client 102907403320696302169.
//
// Run from hub-next/:
//   node scripts/diagnose-gmail-readonly-scope.mjs [subjectEmail]
//
// Default subject is maayan@fandf.co.il. Pass any other @fandf.co.il
// address to spot-check that the impersonation works for that user.
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}

const SUBJECT = (process.argv[2] || "maayan@fandf.co.il").toLowerCase().trim();

function loadKey() {
  const raw = process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON");
  if (!raw) throw new Error("TASKS_SA_KEY_JSON not set in env or .env.local");
  return JSON.parse(raw);
}

const k = loadKey();
console.log(`SA client_id: ${k.client_id}`);
console.log(`SA client_email: ${k.client_email}`);
console.log(`Subject (impersonating): ${SUBJECT}`);
console.log(`Scope under test: https://www.googleapis.com/auth/gmail.readonly`);
console.log("---");

const auth = new google.auth.JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  subject: SUBJECT,
});

// Step 1 — request access token. JWT-level failure (e.g. unauthorized_client)
// surfaces here BEFORE any API call.
try {
  await auth.authorize();
  console.log("[OK] JWT.authorize() succeeded — token granted.");
} catch (e) {
  const msg = e?.message || String(e);
  console.log("[FAIL] JWT.authorize() rejected.");
  console.log(`  message: ${msg}`);
  if (msg.includes("unauthorized_client")) {
    console.log("  → DWD client likely missing the gmail.readonly scope.");
    console.log("    Add it in Workspace Admin → Security → API controls →");
    console.log(`    Domain-wide delegation → client ${k.client_id}.`);
  }
  process.exit(1);
}

// Step 2 — minimal Gmail call: users.getProfile. Returns total message
// counts for the impersonated user. Cheap, no message reads.
const gmail = google.gmail({ version: "v1", auth });
try {
  const r = await gmail.users.getProfile({ userId: "me" });
  console.log("[OK] gmail.users.getProfile succeeded.");
  console.log(`  emailAddress: ${r.data.emailAddress}`);
  console.log(`  messagesTotal: ${r.data.messagesTotal}`);
  console.log(`  threadsTotal: ${r.data.threadsTotal}`);
  console.log(`  historyId: ${r.data.historyId}`);
  console.log("---");
  console.log("VERDICT: gmail.readonly scope is granted via DWD.");
  console.log("Gmail-origin task company auto-prefill should work.");
} catch (e) {
  const code = e?.response?.status;
  const errStatus = e?.response?.data?.error?.status;
  const errMsg = e?.response?.data?.error?.message || e?.message;
  console.log(`[FAIL] gmail.users.getProfile errored: ${code} ${errStatus}`);
  console.log(`  message: ${errMsg}`);
  console.log("---");
  if (code === 403) {
    console.log("VERDICT: gmail.readonly scope is NOT granted (403).");
    console.log("Add it in Workspace Admin → Security → API controls →");
    console.log(`Domain-wide delegation → client ${k.client_id} →`);
    console.log("paste this exact scope string:");
    console.log("  https://www.googleapis.com/auth/gmail.readonly");
  } else {
    console.log("VERDICT: scope check inconclusive — non-403 error.");
  }
  process.exit(1);
}
