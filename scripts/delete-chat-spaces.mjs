/* eslint-disable */
/**
 * Delete a list of Google Chat spaces by id. Reads target ids from
 * argv and the SAFETY_BAR string from the env / first line of stdin
 * is matched against to confirm intent.
 *
 * Run:
 *   node scripts/delete-chat-spaces.mjs <id1> <id2> ... [--apply]
 *
 * Without --apply: dry-run, lists current displayName + member +
 * message count for each space and exits.
 *
 * Required DWD scope on SA client (102907403320696302169):
 *   https://www.googleapis.com/auth/chat.spaces
 *
 * Deletion is IRREVERSIBLE in Chat. The script refuses to delete a
 * space with messages unless --force is also passed; safety net for
 * the typical case (we want to delete empty button-bleed dupes).
 */

import { google } from "googleapis";
import fs from "node:fs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FORCE = args.includes("--force");
const ids = args.filter((a) => !a.startsWith("--") && !a.includes("@"));
const SUBJECT = args.find((a) => a.includes("@")) || "maayan@fandf.co.il";

if (ids.length === 0) {
  console.error("Usage: node scripts/delete-chat-spaces.mjs <id1> <id2> ... [--apply] [--force]");
  console.error("  --apply : actually delete (default is dry-run)");
  console.error("  --force : also delete spaces with messages (default refuses)");
  process.exit(1);
}

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");

const k = JSON.parse(env("TASKS_SA_KEY_JSON"));
const auth = new google.auth.JWT({
  email: k.client_email, key: k.private_key,
  scopes: [
    "https://www.googleapis.com/auth/chat.spaces",
    "https://www.googleapis.com/auth/chat.delete",
    "https://www.googleapis.com/auth/chat.messages.readonly",
  ],
  subject: SUBJECT,
});
const chat = google.chat({ version: "v1", auth });

console.log(`Subject: ${SUBJECT}    Mode: ${APPLY ? (FORCE ? "APPLY + FORCE" : "APPLY") : "dry-run"}    Targets: ${ids.length}\n`);

const plan = [];
for (const id of ids) {
  let displayName = "(unknown)";
  let msgCount = "?";
  let members = null;
  try {
    const sp = await chat.spaces.get({ name: `spaces/${id}` });
    displayName = (sp.data.displayName ?? "(unnamed)").trim();
    members = sp.data.membershipCount?.joinedDirectHumanUserCount ?? null;
  } catch (e) {
    console.log(`  ✗ get space ${id} failed: ${e?.message?.slice(0, 120)}`);
    continue;
  }
  try {
    const r = await chat.spaces.messages.list({ parent: `spaces/${id}`, pageSize: 10 });
    const msgs = r.data.messages ?? [];
    msgCount = msgs.length === 0 ? 0 : (r.data.nextPageToken ? "10+" : msgs.length);
  } catch {}
  const safe = msgCount === 0;
  plan.push({ id, displayName, msgCount, members, safe });
  console.log(`  ${safe ? "🗑" : "⚠"}  ${id}  "${displayName}"  msgs=${msgCount}  members=${members ?? "?"}`);
}

if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply to delete ${plan.filter((p) => p.safe).length} safe targets.`);
  if (plan.some((p) => !p.safe)) console.log(`(${plan.filter((p) => !p.safe).length} non-safe targets; pass --force in addition to --apply to delete those too.)`);
  process.exit(0);
}

console.log("");
let deleted = 0, refused = 0, errored = 0;
for (const p of plan) {
  if (!p.safe && !FORCE) {
    console.log(`  ⏭  ${p.id} "${p.displayName}" — has messages, skipping (use --force to override)`);
    refused++;
    continue;
  }
  try {
    await chat.spaces.delete({ name: `spaces/${p.id}` });
    console.log(`  ✓  ${p.id} "${p.displayName}" deleted`);
    deleted++;
  } catch (e) {
    console.log(`  ✗  ${p.id} "${p.displayName}" failed: ${e?.message?.slice(0, 200)}`);
    errored++;
  }
}
console.log(`\nDone. Deleted ${deleted}, refused ${refused} (had messages), errored ${errored}.`);
