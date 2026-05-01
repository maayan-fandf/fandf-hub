/* eslint-disable */
/**
 * Sync Google Chat space URLs into Keys.
 *
 * Scans every Chat space the SA can see (via DWD impersonation of an
 * admin), then for each space whose displayName matches a Keys
 * project name, compares to the project's existing Chat Space cell:
 *
 *   - Empty cell → "missing"  (script proposes a write)
 *   - Cell points to a different space id → "mismatch"  (script
 *     proposes overwriting, with the existing value logged for audit)
 *   - Cell already matches → "ok"  (skip)
 *
 * Also reports rows where the displayName matches AMBIGUOUSLY (more
 * than one space with that name) — script never auto-picks; the
 * admin has to disambiguate manually.
 *
 * Run modes:
 *   node scripts/sync-chat-spaces.mjs           # dry-run (default)
 *   node scripts/sync-chat-spaces.mjs --apply   # actually write
 *
 * Env: TASKS_SA_KEY_JSON, SHEET_ID_MAIN read from .env.local.
 * Subject defaults to maayan@fandf.co.il (admin used for impersonation).
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
  return new google.auth.JWT({
    email: k.client_email,
    key: k.private_key,
    scopes,
    subject: SUBJECT,
  });
}

function columnLetter(n) {
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
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

function urlForSpaceId(id) {
  return `https://mail.google.com/chat/u/0/#chat/space/${id}`;
}

const SHEET_ID_MAIN = env("SHEET_ID_MAIN");
if (!SHEET_ID_MAIN) { console.error("[FAIL] SHEET_ID_MAIN not in env"); process.exit(1); }

console.log(`Subject: ${SUBJECT}    Mode: ${APPLY ? "APPLY (will write)" : "dry-run"}\n`);

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

const keysProjects = []; // { rowIdx, name, company, currentCell, currentSpaceId }
for (let r = 1; r < ksRows.length; r++) {
  const name = String(ksRows[r][iProj] ?? "").trim();
  if (!name) continue;
  const cell = String(ksRows[r][iChat] ?? "").trim();
  keysProjects.push({
    rowIdx: r,
    sheetRow: r + 1,
    name,
    company: iCo >= 0 ? String(ksRows[r][iCo] ?? "").trim() : "",
    currentCell: cell,
    currentSpaceId: spaceIdFromUrl(cell),
  });
}
console.log(`Read ${keysProjects.length} project rows from Keys.\n`);

// 2) List all Chat spaces visible to SUBJECT.
const chat = google.chat({
  version: "v1",
  auth: jwt(["https://www.googleapis.com/auth/chat.spaces.readonly", "https://www.googleapis.com/auth/chat.spaces"]),
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
console.log(`Listed ${allSpaces.length} Chat spaces visible to ${SUBJECT}.\n`);

// 3) Index spaces by displayName.
const spacesByName = new Map(); // displayName(trim) → array of {id, name, displayName}
for (const sp of allSpaces) {
  const dn = (sp.displayName ?? "").trim();
  if (!dn) continue;
  const id = (sp.name ?? "").replace(/^spaces\//, "");
  const existing = spacesByName.get(dn);
  if (existing) existing.push({ id, name: sp.name, displayName: dn });
  else spacesByName.set(dn, [{ id, name: sp.name, displayName: dn }]);
}

// 4) Match Keys projects → spaces.
//
// Naming convention (enforced by chatSpaceCreate.ts going forward):
//   "<company> | <project>"
//
// We try that first because it disambiguates collisions like 4×
// כללי / 2× אחוזת אפרידר. Falls back to bare "<project>" so legacy
// spaces created before the convention still get matched (those
// remain ambiguous when the project name itself collides — admin
// has to rename one or both manually in Google Chat).
const ok = [];
const missing = [];
const mismatch = [];
const ambiguous = [];
const noMatch = [];

for (const proj of keysProjects) {
  const conventionKey = proj.company ? `${proj.company} | ${proj.name}` : "";
  const conventionCandidates = conventionKey ? (spacesByName.get(conventionKey) ?? []) : [];
  const fallbackCandidates = spacesByName.get(proj.name) ?? [];

  let candidates;
  let matchedBy;
  if (conventionCandidates.length === 1) {
    candidates = conventionCandidates;
    matchedBy = "convention";
  } else if (conventionCandidates.length > 1) {
    candidates = conventionCandidates;
    matchedBy = "convention-ambiguous";
  } else if (fallbackCandidates.length > 0) {
    candidates = fallbackCandidates;
    matchedBy = "fallback";
  } else {
    candidates = [];
    matchedBy = "none";
  }

  if (candidates.length === 0) { noMatch.push(proj); continue; }
  if (candidates.length > 1) {
    ambiguous.push({ proj, candidates, matchedBy });
    continue;
  }
  const sp = candidates[0];
  if (!proj.currentCell) {
    missing.push({ proj, sp, matchedBy });
  } else if (proj.currentSpaceId !== sp.id) {
    mismatch.push({ proj, sp, matchedBy });
  } else {
    ok.push({ proj, sp, matchedBy });
  }
}

// 5) Report.
console.log(`=== ${ok.length} already in sync ===`);
console.log(`=== ${missing.length} missing (Keys cell empty, single space matched by name) ===`);
for (const m of missing) {
  console.log(`  row ${m.proj.sheetRow}  "${m.proj.name}" (${m.proj.company || "—"})  → space id ${m.sp.id}  [${m.matchedBy}]`);
}
console.log(`\n=== ${mismatch.length} MISMATCH (Keys cell points to a different space than the active one) ===`);
for (const m of mismatch) {
  console.log(`  row ${m.proj.sheetRow}  "${m.proj.name}" (${m.proj.company || "—"})  [matched by ${m.matchedBy}]`);
  console.log(`    current Keys → ${m.proj.currentSpaceId} (cell: "${m.proj.currentCell.slice(0, 80)}")`);
  console.log(`    active space → ${m.sp.id}`);
}
console.log(`\n=== ${ambiguous.length} AMBIGUOUS (multiple Chat spaces share the displayName — rename in Google Chat to "<company> | <project>" to disambiguate) ===`);
for (const a of ambiguous) {
  const expectedName = a.proj.company ? `${a.proj.company} | ${a.proj.name}` : a.proj.name;
  console.log(`  row ${a.proj.sheetRow}  "${a.proj.name}" (${a.proj.company || "—"})  — should be named "${expectedName}"  [${a.matchedBy}]`);
  console.log(`    candidates:`);
  for (const c of a.candidates) console.log(`      - ${c.id}`);
}
console.log(`\n=== ${noMatch.length} no Chat space found by name ===`);
const noMatchExamples = noMatch.slice(0, 10);
for (const n of noMatchExamples) console.log(`  "${n.name}"`);
if (noMatch.length > noMatchExamples.length) console.log(`  ...and ${noMatch.length - noMatchExamples.length} more.`);

// 6) Apply.
const writeQueue = APPLY ? [...missing, ...mismatch] : [];
if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply to write ${missing.length + mismatch.length} corrections.`);
  process.exit(0);
}
if (writeQueue.length === 0) { console.log("\nNothing to apply."); process.exit(0); }

console.log(`\nApplying ${writeQueue.length} writes...`);
const colA1 = columnLetter(iChat + 1);
let written = 0;
for (const item of writeQueue) {
  const url = urlForSpaceId(item.sp.id);
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID_MAIN,
      range: `Keys!${colA1}${item.proj.sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [[url]] },
    });
    written++;
    console.log(`  ✓ row ${item.proj.sheetRow}  "${item.proj.name}" ← ${item.sp.id}`);
  } catch (e) {
    console.log(`  ✗ row ${item.proj.sheetRow}  "${item.proj.name}" — ${e?.message?.slice(0, 200)}`);
  }
}
console.log(`\nDone. Wrote ${written}/${writeQueue.length}.`);
console.log(`Hub will see fresh values within Keys' 5min cache TTL (or instantly via /api/admin/debug-project?bust=1).`);
