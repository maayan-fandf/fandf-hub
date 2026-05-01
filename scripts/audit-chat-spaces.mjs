/* eslint-disable */
/**
 * Read-only audit of Google Chat spaces — categorizes every space the
 * SA can see and groups by canonical project ownership. Output drives
 * MANUAL cleanup decisions in the Google Chat UI; the script does not
 * delete anything.
 *
 * For each space:
 *   - id, current displayName, createTime
 *   - message count (probe with pageSize=10; "10+" if it pages)
 *   - canonical owner (which Keys row references this space, if any)
 *   - "name match" owner (Keys row whose project name matches the
 *     space's bare displayName — only used when no canonical mapping
 *     and the match is unambiguous)
 *
 * Spaces are grouped by their canonical/inferred project owner. A
 * project with multiple spaces in its group means duplicates that
 * need cleanup. The recommendation column tells you which to keep:
 *
 *   ✅ KEEP         — referenced from Keys (canonical)
 *   🗑 SAFE-TO-DELETE — not canonical, 0 messages, no Keys reference
 *   ⚠ REVIEW       — not canonical but has messages or members; merge
 *                    history into the canonical space first or re-link
 *                    Keys to this one if it's the real active space
 *
 * Run:
 *   node scripts/audit-chat-spaces.mjs
 *
 * Required DWD scope on the SA client (102907403320696302169):
 *   https://www.googleapis.com/auth/chat.spaces
 *   https://www.googleapis.com/auth/chat.messages.readonly  (already granted)
 */

import { google } from "googleapis";
import fs from "node:fs";

const SUBJECT = process.argv.find((a) => a.includes("@")) || "maayan@fandf.co.il";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) => process.env[n] || (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");

function loadKey() {
  const raw = env("TASKS_SA_KEY_JSON");
  if (!raw) throw new Error("TASKS_SA_KEY_JSON not set");
  return JSON.parse(raw);
}
function jwt(scopes) {
  const k = loadKey();
  return new google.auth.JWT({ email: k.client_email, key: k.private_key, scopes, subject: SUBJECT });
}
function spaceIdFromUrl(url) {
  if (!url) return "";
  let m;
  m = url.match(/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/([A-Za-z0-9_-]+)\/messages/); if (m) return m[1];
  m = url.match(/^https:\/\/chat\.google\.com\/(?:room|space)\/([A-Za-z0-9_-]+)/); if (m) return m[1];
  m = url.match(/[\/#]chat\/(?:space|room)\/([A-Za-z0-9_-]+)/); if (m) return m[1];
  m = url.trim().match(/^(?:spaces\/)?([A-Za-z0-9_-]{8,})$/);
  return m ? m[1] : "";
}

const SHEET_ID_MAIN = env("SHEET_ID_MAIN");
if (!SHEET_ID_MAIN) { console.error("[FAIL] SHEET_ID_MAIN not in env"); process.exit(1); }

console.log(`Subject: ${SUBJECT}    (read-only audit — no writes, no deletes)\n`);

// 1) Read Keys.
const sheets = google.sheets({ version: "v4", auth: jwt(["https://www.googleapis.com/auth/spreadsheets"]) });
const ksRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_MAIN, range: "Keys", valueRenderOption: "UNFORMATTED_VALUE",
});
const ksRows = ksRes.data.values ?? [];
const ksHeaders = (ksRows[0] ?? []).map((h) => String(h ?? "").replace(/[​-‏‪-‮⁠­﻿]/g, "").replace(/\s+/g, " ").trim());
const iProj = ksHeaders.indexOf("פרוייקט");
const iCo = ksHeaders.indexOf("חברה");
const iChat = ksHeaders.indexOf("Chat Space") >= 0 ? ksHeaders.indexOf("Chat Space") : ksHeaders.indexOf("Chat Webhook");
if (iProj < 0 || iChat < 0) { console.error("[FAIL] Keys missing פרוייקט or Chat Space column"); process.exit(1); }

const projectsByName = new Map();          // bareName → array of { name, company }
const projectBySpaceId = new Map();        // spaceId → { name, company, sheetRow }
for (let r = 1; r < ksRows.length; r++) {
  const name = String(ksRows[r][iProj] ?? "").trim();
  if (!name) continue;
  const company = iCo >= 0 ? String(ksRows[r][iCo] ?? "").trim() : "";
  const sid = spaceIdFromUrl(String(ksRows[r][iChat] ?? "").trim());
  const row = { name, company, sheetRow: r + 1 };
  const existing = projectsByName.get(name);
  if (existing) existing.push(row); else projectsByName.set(name, [row]);
  if (sid) projectBySpaceId.set(sid, row);
}
console.log(`Read ${[...projectsByName.values()].reduce((n, a) => n + a.length, 0)} projects from Keys (${projectBySpaceId.size} have a Chat Space id).\n`);

// 2) List Chat spaces.
const chat = google.chat({ version: "v1", auth: jwt(["https://www.googleapis.com/auth/chat.spaces", "https://www.googleapis.com/auth/chat.messages.readonly"]) });
const allSpaces = [];
let pageToken = "";
do {
  const res = await chat.spaces.list({ pageSize: 1000, pageToken: pageToken || undefined, filter: 'spaceType = "SPACE"' });
  (res.data.spaces ?? []).forEach((s) => allSpaces.push(s));
  pageToken = res.data.nextPageToken || "";
} while (pageToken);
console.log(`Listed ${allSpaces.length} Chat spaces.\n`);

// 3) For each space, probe message count + categorize.
console.log(`Probing message counts (this is the slow step)...\n`);
const enriched = [];
for (let i = 0; i < allSpaces.length; i++) {
  const sp = allSpaces[i];
  const id = (sp.name ?? "").replace(/^spaces\//, "");
  if (!id) continue;
  let msgCount = "?";
  try {
    const r = await chat.spaces.messages.list({ parent: `spaces/${id}`, pageSize: 10 });
    const msgs = r.data.messages ?? [];
    msgCount = msgs.length === 0 ? "0" : (r.data.nextPageToken ? "10+" : String(msgs.length));
  } catch (e) {
    msgCount = `err:${(e?.code ?? "?")}`;
  }

  // Canonical owner: Keys row that references this space id directly.
  const canonical = projectBySpaceId.get(id) || null;

  // Inferred owner: bare displayName (after stripping "<X> | " prefix)
  // matches exactly one Keys project — only used when no canonical.
  let inferred = null;
  if (!canonical) {
    const dn = (sp.displayName ?? "").trim();
    const bare = dn.replace(/^[^|]+\|\s*/, "").trim();
    const candidates = projectsByName.get(bare) ?? [];
    if (candidates.length === 1) inferred = candidates[0];
  }

  let recommendation;
  if (canonical) recommendation = "✅ KEEP";
  else if (msgCount === "0" && (sp.membershipCount?.joinedDirectHumanUserCount ?? 0) <= 1) recommendation = "🗑 SAFE-TO-DELETE";
  else recommendation = "⚠ REVIEW";

  enriched.push({
    id,
    name: sp.name,
    displayName: (sp.displayName ?? "").trim(),
    createTime: sp.createTime ?? "",
    msgCount,
    membersJoined: sp.membershipCount?.joinedDirectHumanUserCount ?? null,
    canonical,
    inferred,
    recommendation,
    groupKey: canonical
      ? `${canonical.company || "—"} | ${canonical.name}`
      : inferred
        ? `${inferred.company || "—"} | ${inferred.name}`
        : `(orphan) ${sp.displayName ?? "(unnamed)"}`,
  });
  process.stdout.write(`  ${i + 1}/${allSpaces.length}\r`);
}
process.stdout.write("\n\n");

// 4) Group by ownership and print.
const groups = new Map();
for (const e of enriched) {
  const k = e.groupKey;
  if (groups.has(k)) groups.get(k).push(e);
  else groups.set(k, [e]);
}
const sortedKeys = [...groups.keys()].sort((a, b) => {
  const aOrphan = a.startsWith("(orphan)");
  const bOrphan = b.startsWith("(orphan)");
  if (aOrphan !== bOrphan) return aOrphan ? 1 : -1;
  return a.localeCompare(b);
});

let dupGroups = 0;
let safeToDelete = 0;
let toReview = 0;
let canonical = 0;

for (const key of sortedKeys) {
  const list = groups.get(key);
  const isDuplicate = list.length > 1 && !key.startsWith("(orphan)");
  if (isDuplicate) dupGroups++;
  console.log(`${isDuplicate ? "🔁 " : "   "}${key}${list.length > 1 ? `   (${list.length} spaces)` : ""}`);
  for (const s of list) {
    const ageDays = s.createTime ? Math.round((Date.now() - new Date(s.createTime).getTime()) / 86400000) : null;
    const meta = [
      `id=${s.id}`,
      `name="${s.displayName.slice(0, 40)}"`,
      `msgs=${s.msgCount}`,
      s.membersJoined != null ? `members=${s.membersJoined}` : null,
      ageDays != null ? `age=${ageDays}d` : null,
    ].filter(Boolean).join("  ");
    console.log(`    ${s.recommendation}    ${meta}`);
    if (s.recommendation.includes("KEEP")) canonical++;
    if (s.recommendation.includes("SAFE")) safeToDelete++;
    if (s.recommendation.includes("REVIEW")) toReview++;
  }
}

console.log(`\n────`);
console.log(`Total spaces: ${enriched.length}`);
console.log(`  ✅ canonical (KEEP):       ${canonical}`);
console.log(`  🗑 safe-to-delete:         ${safeToDelete}   (no Keys ref, 0 messages, ≤1 member)`);
console.log(`  ⚠ review needed:          ${toReview}   (has messages/members but not in Keys)`);
console.log(`Duplicate groups: ${dupGroups}   (project owns >1 space — pick one canonical, delete others manually in Google Chat)`);
console.log(`\nNext steps:`);
console.log(`  1. Delete the 🗑 SAFE-TO-DELETE spaces in Google Chat (they have no history to lose).`);
console.log(`  2. For each 🔁 group with multiple spaces, decide which is canonical:`);
console.log(`     - If the canonical (referenced from Keys) is the right one → delete the other(s).`);
console.log(`     - If a non-canonical one has the real history → re-link Keys via:`);
console.log(`         node scripts/set-keys-chat-space.mjs "<project>" "<correct-space-id>"`);
console.log(`     - Then run audit again to confirm cleanup.`);
console.log(`  3. After cleanup, run rename-chat-spaces.mjs --apply to bring displayNames into convention.`);
