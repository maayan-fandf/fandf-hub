/* eslint-disable */
/**
 * Rename existing Google Chat spaces to the canonical
 * "<company> | <project>" convention.
 *
 * Pairs with sync-chat-spaces.mjs: that script writes Keys; this one
 * writes Chat displayNames. Together they bring the
 * (Keys row ↔ Chat space ↔ displayName) triple into a consistent
 * shape across the workspace.
 *
 * Match strategy per space (priority order):
 *
 *   1. PRIMARY — the space's id is listed in some Keys row's Chat
 *      Space cell. That row is the canonical owner; rename to that
 *      row's "<company> | <project>".
 *   2. FALLBACK — the space's displayName (or its bare-project
 *      portion after stripping a "<X> | " prefix) matches EXACTLY
 *      ONE Keys project name. Safe to rename unambiguously.
 *   3. SKIP — multiple Keys rows could plausibly own this space (e.g.
 *      4× כללי) and we don't have a Keys-side reference to break the
 *      tie. Reported so the admin can fix Keys first or rename
 *      manually in Google Chat.
 *
 * Spaces that are already named correctly are skipped silently.
 *
 * Run modes:
 *   node scripts/rename-chat-spaces.mjs           # dry-run
 *   node scripts/rename-chat-spaces.mjs --apply   # actually patch
 *
 * Required DWD scope on the SA client (102907403320696302169):
 *   https://www.googleapis.com/auth/chat.spaces
 *
 * Without it, list + patch both fail with `unauthorized_client`.
 */

import { google } from "googleapis";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");
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

console.log(`Subject: ${SUBJECT}    Mode: ${APPLY ? "APPLY (will patch displayNames)" : "dry-run"}\n`);

// 1) Read Keys.
const sheets = google.sheets({ version: "v4", auth: jwt(["https://www.googleapis.com/auth/spreadsheets"]) });
const ksRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_MAIN,
  range: "Keys",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const ksRows = ksRes.data.values ?? [];
const ksHeaders = (ksRows[0] ?? []).map((h) => String(h ?? "").replace(/[​-‏‪-‮⁠­﻿]/g, "").replace(/\s+/g, " ").trim());
const iProj = ksHeaders.indexOf("פרוייקט");
const iCo = ksHeaders.indexOf("חברה");
const iChat = ksHeaders.indexOf("Chat Space") >= 0 ? ksHeaders.indexOf("Chat Space") : ksHeaders.indexOf("Chat Webhook");
if (iProj < 0 || iChat < 0) { console.error("[FAIL] Keys missing פרוייקט or Chat Space column"); process.exit(1); }

const projectsByName = new Map();         // bareName → array of { name, company, currentSpaceId }
const projectBySpaceId = new Map();       // spaceId → { name, company }
for (let r = 1; r < ksRows.length; r++) {
  const name = String(ksRows[r][iProj] ?? "").trim();
  if (!name) continue;
  const company = iCo >= 0 ? String(ksRows[r][iCo] ?? "").trim() : "";
  const cell = String(ksRows[r][iChat] ?? "").trim();
  const sid = spaceIdFromUrl(cell);
  const proj = { name, company, currentSpaceId: sid };
  const existing = projectsByName.get(name);
  if (existing) existing.push(proj);
  else projectsByName.set(name, [proj]);
  if (sid) projectBySpaceId.set(sid, proj);
}
console.log(`Read ${[...projectsByName.values()].reduce((n, a) => n + a.length, 0)} project rows; ${projectBySpaceId.size} have a Chat Space id.\n`);

// 2) List Chat spaces visible to SUBJECT.
const chat = google.chat({
  version: "v1",
  auth: jwt(["https://www.googleapis.com/auth/chat.spaces"]),
});
const allSpaces = [];
let pageToken = "";
do {
  const res = await chat.spaces.list({
    pageSize: 1000,
    pageToken: pageToken || undefined,
    filter: 'spaceType = "SPACE"',
  });
  (res.data.spaces ?? []).forEach((s) => allSpaces.push(s));
  pageToken = res.data.nextPageToken || "";
} while (pageToken);
console.log(`Listed ${allSpaces.length} Chat spaces.\n`);

// 3) Plan renames.
const planned = [];   // { space, currentName, targetName, owner, by }
const skipped = [];   // { space, reason }
const already = [];

for (const sp of allSpaces) {
  const id = (sp.name ?? "").replace(/^spaces\//, "");
  const currentName = (sp.displayName ?? "").trim();
  if (!id || !currentName) continue;

  // (1) Keys-referenced — most reliable.
  let owner = projectBySpaceId.get(id);
  let by = "primary";

  // (2) DisplayName fallback — strip any "<X> | " prefix to get the
  // bare project portion, then look up by that. Single match wins.
  if (!owner) {
    const bare = currentName.replace(/^[^|]+\|\s*/, "").trim();
    const candidates = projectsByName.get(bare) ?? [];
    if (candidates.length === 1) {
      const cand = candidates[0];
      // Refuse to rename when the Keys row already references a
      // DIFFERENT space id. This space is a duplicate of the canonical
      // one — renaming it would create two spaces with identical
      // canonical names. The right action for these is deletion, not
      // rename. (delete-chat-spaces.mjs handles that.)
      if (cand.currentSpaceId && cand.currentSpaceId !== id) {
        skipped.push({ space: sp, reason: `duplicate of canonical ${cand.currentSpaceId} for "${cand.company} | ${cand.name}" (delete this one instead of renaming)` });
        continue;
      }
      owner = cand;
      by = "fallback-by-name";
    } else if (candidates.length > 1) {
      skipped.push({ space: sp, reason: `ambiguous: "${bare}" matches ${candidates.length} Keys rows (${candidates.map((c) => c.company || "—").join(", ")})` });
      continue;
    }
  }

  if (!owner) {
    skipped.push({ space: sp, reason: `no Keys match for "${currentName}"` });
    continue;
  }

  const targetName = owner.company ? `${owner.company} | ${owner.name}` : owner.name;
  if (currentName === targetName) {
    already.push({ space: sp, owner });
  } else {
    planned.push({ space: sp, currentName, targetName, owner, by });
  }
}

console.log(`=== ${already.length} already canonical ===`);
console.log(`=== ${planned.length} renames planned ===`);
for (const p of planned) {
  console.log(`  ${p.space.name?.replace(/^spaces\//, "")}`);
  console.log(`    "${p.currentName}"`);
  console.log(`    → "${p.targetName}"   [${p.by}]`);
}
console.log(`\n=== ${skipped.length} skipped ===`);
for (const s of skipped) {
  console.log(`  ${s.space.name?.replace(/^spaces\//, "")}  "${(s.space.displayName || "").slice(0, 60)}"  — ${s.reason}`);
}

if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply to patch ${planned.length} display names.`);
  process.exit(0);
}
if (planned.length === 0) { console.log("\nNothing to apply."); process.exit(0); }

console.log(`\nApplying ${planned.length} renames...`);
let written = 0;
for (const p of planned) {
  try {
    await chat.spaces.patch({
      name: p.space.name,
      updateMask: "displayName",
      requestBody: { displayName: p.targetName },
    });
    written++;
    console.log(`  ✓ "${p.currentName}" → "${p.targetName}"`);
  } catch (e) {
    const msg = e?.message?.slice(0, 200) || String(e);
    console.log(`  ✗ "${p.currentName}" — ${msg}`);
  }
}
console.log(`\nDone. Renamed ${written}/${planned.length}.`);
