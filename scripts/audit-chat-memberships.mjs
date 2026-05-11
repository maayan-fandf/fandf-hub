/* eslint-disable */
/**
 * Audit-and-repair Chat space memberships.
 *
 * For every Keys row that has a Chat Space, build the expected roster
 * from cols C (מנהל קמפיינים) / D (EMAIL Manager) / J (Access — internal
 * only) / K (Client-facing) plus the hub admins, resolve names→emails
 * via the "names to emails" tab, and compare against the space's
 * current members.
 *
 * Three modes:
 *   (default)  Dry-run — print roster vs current state per space.
 *   --apply    Add every missing member (idempotent: 409 = no-op).
 *              NEVER removes anyone.
 *   --verbose  Include the per-email roster lines, not just summaries.
 *
 * Filter (combine with any mode):
 *   --project=<exact-project-name>     Only this project.
 *   --space=<spaceId>                  Only this space.
 *
 * Requires DWD scope on SA client 102907403320696302169:
 *   https://www.googleapis.com/auth/chat.memberships    (write + list)
 *   https://www.googleapis.com/auth/spreadsheets        (already granted)
 *
 * If chat.memberships isn't authorized, the script will detect that
 * (auth fails for the listing pass) and downgrade to "roster-only" —
 * still useful for previewing who'd be added once the scope lands.
 */
import { google } from "googleapis";
import fs from "node:fs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const VERBOSE = args.includes("--verbose");
const PROJECT_FILTER = (args.find((a) => a.startsWith("--project=")) || "").slice("--project=".length);
const SPACE_FILTER = (args.find((a) => a.startsWith("--space=")) || "").slice("--space=".length);

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
const env = (n) =>
  process.env[n] ||
  (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(/^[^=]+=/, "");

const SHEET_ID_MAIN = env("SHEET_ID_MAIN");
const SHEET_ID_COMMENTS = env("SHEET_ID_COMMENTS");
if (!SHEET_ID_MAIN || !SHEET_ID_COMMENTS) {
  console.error("[FAIL] SHEET_ID_MAIN or SHEET_ID_COMMENTS not in env");
  process.exit(1);
}

const k = JSON.parse(env("TASKS_SA_KEY_JSON"));
function jwt(scopes, subject = "maayan@fandf.co.il") {
  return new google.auth.JWT({
    email: k.client_email,
    key: k.private_key,
    scopes,
    subject,
  });
}

const HUB_ADMIN_EMAILS = ["maayan@fandf.co.il", "nadav@fandf.co.il", "felix@fandf.co.il"];

function spaceIdFromUrl(url) {
  if (!url) return "";
  let m;
  m = url.match(/^https:\/\/chat\.googleapis\.com\/v1\/spaces\/([A-Za-z0-9_-]+)\/messages/); if (m) return m[1];
  m = url.match(/^https:\/\/chat\.google\.com\/(?:room|space)\/([A-Za-z0-9_-]+)/); if (m) return m[1];
  m = url.match(/[\/#]chat\/(?:space|room)\/([A-Za-z0-9_-]+)/); if (m) return m[1];
  m = url.trim().match(/^(?:spaces\/)?([A-Za-z0-9_-]{8,})$/);
  return m ? m[1] : "";
}

// ── 1. names → emails map ──────────────────────────────────────────────
const sheets = google.sheets({ version: "v4", auth: jwt(["https://www.googleapis.com/auth/spreadsheets"]) });
const n2e = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: "names to emails",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const n2eRows = n2e.data.values ?? [];
const n2eHeaders = (n2eRows[0] ?? []).map((h) => String(h ?? "").trim().toLowerCase());
const iName = n2eHeaders.findIndex((h) => ["full name", "name", "fullname"].includes(h));
const iEmail = n2eHeaders.findIndex((h) => ["email", "e-mail", "mail"].includes(h));
// Normalize NBSP/figure-space/etc. to plain ASCII space and collapse runs
// — n2e has been seen with U+00A0 inside "Daniel paz" which silently
// breaks otherwise-correct name lookups.
function normName(s) {
  // NBSP, figure/em/en/narrow/etc. spaces, ZWSP, bidi marks → ASCII space.
  // (n2e was seen with U+00A0 embedded in "Daniel paz".)
  return String(s ?? "")
    .replace(/[  -​‎‏  　﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
const nameToEmail = new Map();
const firstNameToEmail = new Map();   // fallback: first-name → email (only if unique)
const firstNameAmbiguous = new Set(); // first names that map to >1 person
for (let i = 1; i < n2eRows.length; i++) {
  const n = normName(n2eRows[i][iName]);
  const e = normName(n2eRows[i][iEmail]);
  if (!n || !e) continue;
  nameToEmail.set(n, e);
  const first = n.split(" ")[0];
  if (firstNameToEmail.has(first) && firstNameToEmail.get(first) !== e) {
    firstNameAmbiguous.add(first);
  } else {
    firstNameToEmail.set(first, e);
  }
}

function resolveOne(token) {
  const t = normName(token);
  if (!t) return "";
  if (t.includes("@")) return t;
  // 1) exact full-name match.
  const hit = nameToEmail.get(t);
  if (hit) return hit;
  // 2) first-name fallback ("Omer Lutzky" → "omer"), only if unambiguous.
  const first = t.split(" ")[0];
  if (!firstNameAmbiguous.has(first) && firstNameToEmail.has(first)) {
    return firstNameToEmail.get(first);
  }
  return "";
}
function splitCell(cell) {
  return String(cell || "")
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── 2. Read Keys, build per-space roster ───────────────────────────────
const keysRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_MAIN,
  range: "Keys",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const krows = keysRes.data.values ?? [];
const kheaders = (krows[0] ?? []).map((h) =>
  String(h ?? "").replace(/[​-‏‪-‮⁠­﻿]/g, "").replace(/\s+/g, " ").trim()
);
const iProj = kheaders.indexOf("פרוייקט");
const iCo = kheaders.indexOf("חברה");
const iMedia = kheaders.indexOf("מנהל קמפיינים");
const iAcct = kheaders.indexOf("EMAIL Manager");
const iAccess = kheaders.indexOf("Access — internal only");
let iClient = kheaders.indexOf("Client-facing");
if (iClient < 0) iClient = kheaders.findIndex((h) => h.startsWith("Client-facing"));
const iChat = kheaders.findIndex((h) => h === "Chat Space" || h === "Chat Webhook");

const targets = [];
const unresolvedNames = new Set();
for (let r = 1; r < krows.length; r++) {
  const row = krows[r];
  const proj = String(row[iProj] ?? "").trim();
  const co = String(row[iCo] ?? "").trim();
  const sid = spaceIdFromUrl(String(row[iChat] ?? "").trim());
  if (!proj || !sid) continue;
  if (PROJECT_FILTER && proj !== PROJECT_FILTER) continue;
  if (SPACE_FILTER && sid !== SPACE_FILTER) continue;
  const candidates = new Set();
  const trackResolve = (token) => {
    const e = resolveOne(token);
    if (e) candidates.add(e);
    else if (token && !String(token).includes("@") && String(token).trim()) unresolvedNames.add(String(token).trim());
  };
  trackResolve(row[iMedia]);
  trackResolve(row[iAcct]);
  for (const t of splitCell(row[iAccess])) trackResolve(t);
  if (iClient >= 0) for (const t of splitCell(row[iClient])) trackResolve(t);
  for (const a of HUB_ADMIN_EMAILS) candidates.add(a.toLowerCase());
  candidates.delete("maayan@fandf.co.il"); // creator, implicit member
  const emails = [...candidates].filter((e) => e.endsWith("@fandf.co.il")).sort();
  targets.push({ project: proj, company: co, spaceId: sid, expected: emails });
}

if (targets.length === 0) {
  console.log("No targets after filtering. Check --project / --space spelling.");
  process.exit(0);
}

// ── 3. Try to list current members (needs chat.memberships scope) ──────
let canList = true;
try {
  await jwt(["https://www.googleapis.com/auth/chat.memberships"]).authorize();
} catch {
  canList = false;
}
const chatRW = canList
  ? google.chat({
      version: "v1",
      auth: jwt(["https://www.googleapis.com/auth/chat.memberships"]),
    })
  : null;

// Chat memberships return `users/<gaia-numeric-id>` not emails. Build a
// gaia→email map via Directory API so the diff is meaningful.
const directory = google.admin({
  version: "directory_v1",
  auth: jwt(["https://www.googleapis.com/auth/admin.directory.user.readonly"]),
});
const gaiaToEmail = new Map();
async function resolveGaia(gaiaId) {
  if (!gaiaId) return "";
  if (gaiaToEmail.has(gaiaId)) return gaiaToEmail.get(gaiaId);
  try {
    const r = await directory.users.get({ userKey: gaiaId, projection: "basic" });
    const e = String(r.data.primaryEmail || "").toLowerCase();
    gaiaToEmail.set(gaiaId, e);
    return e;
  } catch {
    gaiaToEmail.set(gaiaId, "");
    return "";
  }
}

if (canList) {
  for (const t of targets) {
    try {
      const members = [];
      let pageToken;
      do {
        const r = await chatRW.spaces.members.list({
          parent: `spaces/${t.spaceId}`,
          pageSize: 200,
          pageToken,
        });
        for (const m of r.data.memberships || []) members.push(m);
        pageToken = r.data.nextPageToken || undefined;
      } while (pageToken);
      // Resolve each membership's gaia → email. Skip BOTs (they don't
      // have a primary email; counting them inflates the diff).
      const currentEmails = new Set();
      for (const m of members) {
        if (m.member?.type !== "HUMAN") continue;
        const ref = String(m.member?.name || "").replace(/^users\//, "");
        if (!ref) continue;
        if (ref.includes("@")) {
          currentEmails.add(ref.toLowerCase());
        } else {
          const e = await resolveGaia(ref);
          if (e) currentEmails.add(e);
        }
      }
      t.current = currentEmails;
    } catch (e) {
      t.listError = e?.message?.split("\n")[0] || String(e);
    }
  }
}

// ── 4. Print summary ────────────────────────────────────────────────────
console.log(`Audit mode:     ${APPLY ? "APPLY (will add missing)" : "DRY-RUN"}`);
console.log(`Scope status:   ${canList ? "✅ chat.memberships granted (can list+write)" : "❌ chat.memberships missing (roster preview only)"}`);
console.log(`Spaces audited: ${targets.length}`);
if (unresolvedNames.size > 0) {
  console.log(`\n⚠ Names in Keys that didn't resolve via "names to emails":`);
  for (const n of unresolvedNames) console.log(`    - ${n}`);
  console.log(`  (these were skipped — fix the typo in Keys or add them to the names-to-emails tab)`);
}
console.log();

let totalMissing = 0;
const rows = [];
for (const t of targets) {
  const expected = t.expected.length;
  const current = t.current ? t.current.size : null;
  const missing = canList && t.current
    ? t.expected.filter((e) => !t.current.has(e))
    : t.expected;
  totalMissing += missing.length;
  rows.push({
    label: `${t.company} | ${t.project}`,
    spaceId: t.spaceId,
    expected,
    current: current ?? "?",
    missing: missing.length,
    missingList: missing,
    listError: t.listError,
  });
}

const maxLabel = Math.max(...rows.map((r) => r.label.length), 30);
console.log(`${"Project".padEnd(maxLabel)}  spaceId         expect  current  missing`);
console.log("─".repeat(maxLabel + 45));
for (const r of rows) {
  const flag = r.missing > 0 ? "⚠" : "✓";
  console.log(
    `${r.label.padEnd(maxLabel)}  ${r.spaceId.padEnd(14)}  ${String(r.expected).padStart(6)}  ${String(r.current).padStart(7)}  ${String(r.missing).padStart(7)} ${flag}`
  );
  if (r.listError) console.log(`  list error: ${r.listError}`);
  if (VERBOSE && r.missingList.length > 0) {
    for (const e of r.missingList) console.log(`    + ${e}`);
  }
}
console.log("─".repeat(maxLabel + 45));
console.log(`Total missing memberships: ${totalMissing}`);

// ── 5. Apply ────────────────────────────────────────────────────────────
if (!APPLY) {
  if (totalMissing > 0) {
    console.log(`\nRun with --apply to add the ${totalMissing} missing memberships. Re-run with --verbose to see each one.`);
  }
  process.exit(0);
}

if (!canList) {
  console.error(`\n[ABORT] chat.memberships scope isn't authorized — can't apply.`);
  console.error(`Grant scope https://www.googleapis.com/auth/chat.memberships on DWD client 102907403320696302169 first.`);
  process.exit(1);
}

console.log(`\nApplying ${totalMissing} memberships…`);
let added = 0, alreadyIn = 0, failed = 0;
for (const r of rows) {
  for (const email of r.missingList) {
    try {
      await chatRW.spaces.members.create({
        parent: `spaces/${r.spaceId}`,
        requestBody: { member: { name: `users/${email}`, type: "HUMAN" } },
      });
      added++;
      console.log(`  + ${r.label} ← ${email}`);
    } catch (e) {
      const msg = e?.message || String(e);
      const code = e?.code || e?.response?.status;
      if (code === 409 || /already.*member|already.*exist/i.test(msg)) {
        alreadyIn++;
      } else {
        failed++;
        console.log(`  ! ${r.label} ← ${email} — ${msg.split("\n")[0]}`);
      }
    }
  }
}
console.log(`\nDone. added=${added}  already_member=${alreadyIn}  failed=${failed}`);
