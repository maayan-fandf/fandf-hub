/* eslint-disable */
// PRE-CHECK for the delete+recreate-as-threaded migration.
// Creates ONE throwaway space using the EXACT request body the
// flag-on createChatSpaceForProject path uses (spaceType SPACE,
// externalUserAllowed:false, spaceThreadingState:THREADED_MESSAGES,
// NO accessSettings = restricted), then reports the resulting
// spaceThreadingState — from the create response AND a fresh
// spaces.get — so we know definitively whether API-created spaces
// actually come out threaded before deleting the 24 real ones.
//
// Leaves a clearly-named throwaway space ("ZZ THREADING PROBE —
// safe to delete") for you to delete in the Admin console.
//
// Usage:  node scripts/probe-threaded-space.mjs
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
function envFromFile(name) {
  const l = envText.split("\n").find((x) => x.startsWith(name + "="));
  return l ? l.replace(/^[^=]+=/, "").trim() : "";
}
const key = JSON.parse(
  process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON"),
);

// Only chat.spaces.create (the scope the in-app create path uses and
// is definitely DWD-authorized). The create RESPONSE already echoes
// the resulting spaceThreadingState, so a separate readonly get is
// not required for the verdict.
const jwt = new google.auth.JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ["https://www.googleapis.com/auth/chat.spaces.create"],
  subject: "maayan@fandf.co.il",
});
const chat = google.chat({ version: "v1", auth: jwt });

// Best-effort confirm read with a separate readonly client (skipped
// silently if that scope isn't DWD-authorized for scripts).
let chatRO = null;
try {
  const jwtRO = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ["https://www.googleapis.com/auth/chat.spaces.readonly"],
    subject: "maayan@fandf.co.il",
  });
  chatRO = google.chat({ version: "v1", auth: jwtRO });
} catch {
  chatRO = null;
}

const displayName = "ZZ THREADING PROBE — safe to delete " + Date.now();

let created;
try {
  const r = await chat.spaces.create({
    requestBody: {
      spaceType: "SPACE",
      displayName,
      externalUserAllowed: false,
      spaceThreadingState: "THREADED_MESSAGES",
    },
  });
  created = r.data;
  console.log("CREATE ok.");
  console.log("  name:", created.name);
  console.log("  spaceUri:", created.spaceUri);
  console.log(
    "  spaceThreadingState (from create response):",
    created.spaceThreadingState,
  );
} catch (e) {
  console.log("CREATE error:", e?.response?.status, e?.message);
  process.exit(1);
}

// Re-read to confirm the persisted value (best-effort).
if (chatRO) {
  try {
    const g = await chatRO.spaces.get({ name: created.name });
    console.log(
      "  spaceThreadingState (from spaces.get):",
      g.data.spaceThreadingState,
    );
  } catch (e) {
    console.log(
      "  (confirm get skipped:",
      e?.response?.status,
      e?.message,
      ")",
    );
  }
}

const ts = created.spaceThreadingState;
console.log("");
if (ts === "THREADED_MESSAGES") {
  console.log(
    "✅ PASS — API-created spaces ARE threaded. The delete+recreate plan will produce quiet spaces.",
  );
} else {
  console.log(
    `❌ FAIL — got spaceThreadingState=${ts}, not THREADED_MESSAGES. ` +
      "API ignored/overrode the field. DO NOT delete the real spaces — " +
      "recreating would just produce 24 fresh NOISY spaces. Replan first.",
  );
}
console.log(
  `\nThrowaway space "${displayName}" (${created.name}) — delete it in ` +
    "Admin console → Apps → Google Chat → Manage spaces.",
);
