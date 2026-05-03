/* eslint-disable */
// Cleanup pass complementing sweep-task-anomalies.mjs. Walks the
// Comments sheet, identifies the same anomaly classes, and (when
// --apply is passed) repairs them. Default is dry-run.
//
// Repairs:
//
//   E8 (terminal-row open GTs): close each open GT on rows whose hub
//   status is `done` / `cancelled`. Best-effort — failures logged,
//   don't block other repairs.
//
//   E9 (cell duplicates): rewrite the cell to keep ONE entry per
//   (email, kind) — the first whose GT is alive in the recipient's
//   list, falling back to the first overall. Close every other open
//   GT in the same group (defensive).
//
// Skips:
//
//   E5 / E6 (row 99 type stuck rows): need human decision (set
//   approver_email, or transition to done). Surfaced to stdout.
//
//   E4 (old object-keyed cell shape): cosmetic; 22 of 23 are on
//   terminal rows. Migration deferred.
//
// Usage:
//   node scripts/cleanup-task-anomalies.mjs            # dry-run
//   node scripts/cleanup-task-anomalies.mjs --apply    # apply

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

const APPLY = process.argv.includes("--apply");
const SUBJECT = "maayan@fandf.co.il";
const SHEET_ID_COMMENTS =
  process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");

const sheets = google.sheets({
  version: "v4",
  auth: jwt(["https://www.googleapis.com/auth/spreadsheets"], SUBJECT),
});

const tasksApiCache = new Map();
function tasksClientFor(user) {
  const lc = user.toLowerCase().trim();
  if (!tasksApiCache.has(lc)) {
    tasksApiCache.set(
      lc,
      google.tasks({
        version: "v1",
        auth: jwt(["https://www.googleapis.com/auth/tasks"], lc),
      }),
    );
  }
  return tasksApiCache.get(lc);
}

async function fetchGT(ref) {
  if (!ref?.u || !ref?.l || !ref?.t) return { __error: "incomplete-ref" };
  try {
    const api = tasksClientFor(ref.u);
    const r = await api.tasks.get({ tasklist: ref.l, task: ref.t });
    return { status: r.data.status };
  } catch (e) {
    const code = e?.response?.status;
    return { __error: code === 404 ? "deleted" : String(code || e?.message || e) };
  }
}

async function closeGT(ref) {
  const api = tasksClientFor(ref.u);
  await api.tasks.patch({
    tasklist: ref.l,
    task: ref.t,
    requestBody: { status: "completed" },
  });
}

function columnLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseCell(raw) {
  if (raw == null || raw === "") return [];
  if (typeof raw === "string" && raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return Object.values(parsed);
    return [];
  } catch {
    return [];
  }
}

const cRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: "Comments",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = cRes.data.values ?? [];
const headers = (rows[0] ?? []).map((h) => String(h ?? "").trim());
const idx = (n) => headers.indexOf(n);
const I_ID = idx("id");
const I_KIND = idx("row_kind");
const I_STATUS = idx("status");
const I_GT = idx("google_tasks");
const I_TITLE = idx("title");
const I_PROJECT = idx("project");
const I_APPROVER = idx("approver_email");
const gtCol = columnLetter(I_GT + 1);

console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`Sheet rows: ${rows.length - 1}\n`);

const e8 = []; // {sheetRow, taskId, ref}
const e9 = []; // {sheetRow, taskId, refs (deduped), closeOpen [refs to close]}
const e56 = []; // {sheetRow, taskId, status, approver}

for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  const sheetRow = i + 1;
  if (String(row[I_KIND] ?? "").trim() !== "task") continue;
  const id = String(row[I_ID] ?? "").trim();
  const status = String(row[I_STATUS] ?? "").trim();
  const title = String(row[I_TITLE] ?? "").trim();
  const project = String(row[I_PROJECT] ?? "").trim();
  const approver = String(row[I_APPROVER] ?? "").trim();
  const refs = parseCell(String(row[I_GT] ?? ""));

  // E5/E6
  if (status === "awaiting_approval") {
    const hasApprove = refs.some((r) => (r?.kind ?? "todo") === "approve");
    if (!hasApprove || !approver) {
      e56.push({ sheetRow, taskId: id, status, approver, hasApprove, title, project });
    }
  }

  // E8
  if (status === "done" || status === "cancelled") {
    for (const ref of refs) {
      if (!ref?.u || !ref?.l || !ref?.t) continue;
      const gt = await fetchGT(ref);
      if (gt.__error === "deleted") continue;
      if (gt.__error) continue;
      if (gt.status !== "completed") {
        e8.push({ sheetRow, taskId: id, title, project, ref });
      }
    }
  }

  // E9 — group by (email, kind), find groups with >1 entry
  if (status !== "done" && status !== "cancelled" && refs.length > 0) {
    const groups = new Map();
    for (const ref of refs) {
      if (!ref || typeof ref !== "object") continue;
      const k = `${(ref.u || "").toLowerCase()}|${ref.kind ?? "todo"}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(ref);
    }
    let hasDup = false;
    for (const [, list] of groups) {
      if (list.length > 1) {
        hasDup = true;
        break;
      }
    }
    if (hasDup) {
      // Pick the keeper for each group: prefer the first whose GT is
      // alive (open) in the recipient's list. Fall back to first
      // overall. Close every other open GT in the group.
      const deduped = [];
      const closeOpen = [];
      for (const [, list] of groups) {
        if (list.length === 1) {
          deduped.push(list[0]);
          continue;
        }
        let keeper = null;
        for (const ref of list) {
          const gt = await fetchGT(ref);
          if (gt.__error === "deleted") continue;
          if (!gt.__error && gt.status !== "completed") {
            // Open. First open wins.
            if (!keeper) keeper = { ref, gt };
            else closeOpen.push(ref); // close additional opens
          }
        }
        // No open found — keep the first overall (keeps cell well-formed).
        if (!keeper) {
          deduped.push(list[0]);
        } else {
          deduped.push(keeper.ref);
        }
      }
      e9.push({ sheetRow, taskId: id, title, project, deduped, closeOpen });
    }
  }
}

// ── Report
console.log(`──── E8 (leaked GTs on terminal rows) — ${e8.length} ────`);
for (const f of e8) {
  console.log(
    `  row ${f.sheetRow}  task=${f.taskId}  ${f.project}  ${f.title.slice(0, 50)}`,
  );
  console.log(`    → close GT ${f.ref.t} for ${f.ref.u} (kind=${f.ref.kind})`);
}

console.log(`\n──── E9 (cell duplicates) — ${e9.length} row(s) ────`);
for (const f of e9) {
  console.log(
    `  row ${f.sheetRow}  task=${f.taskId}  ${f.project}  ${f.title.slice(0, 50)}`,
  );
  console.log(`    → cell will be rewritten with ${f.deduped.length} entries`);
  if (f.closeOpen.length > 0) {
    console.log(`    → ${f.closeOpen.length} duplicate open GT(s) will be closed`);
    for (const r of f.closeOpen) {
      console.log(`        - ${r.t}  (${r.u}/${r.kind ?? "todo"})`);
    }
  }
}

console.log(`\n──── E5+E6 (stuck awaiting_approval) — ${e56.length} (NOT auto-fixable) ────`);
for (const f of e56) {
  const why = [];
  if (!f.hasApprove) why.push("no approve ref");
  if (!f.approver) why.push("no approver_email");
  console.log(
    `  row ${f.sheetRow}  task=${f.taskId}  ${f.project}  ${f.title.slice(0, 50)}  [${why.join(", ")}]`,
  );
}

if (!APPLY) {
  console.log(`\n[dry-run] Pass --apply to execute repairs.`);
  process.exit(0);
}

// ── Apply
console.log(`\n──── Applying repairs ────`);
let ok = 0;
let failed = 0;

// E8: close leaked GTs.
for (const f of e8) {
  try {
    await closeGT(f.ref);
    console.log(`  ✓ closed ${f.ref.t} (${f.ref.u})`);
    ok++;
  } catch (e) {
    console.log(`  ✗ close ${f.ref.t}: ${e?.message || e}`);
    failed++;
  }
}

// E9: rewrite cells, close duplicate opens.
for (const f of e9) {
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID_COMMENTS,
      range: `Comments!${gtCol}${f.sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [[JSON.stringify(f.deduped)]] },
    });
    console.log(`  ✓ rewrote cell on row ${f.sheetRow} (${f.deduped.length} entries)`);
    ok++;
  } catch (e) {
    console.log(`  ✗ rewrite row ${f.sheetRow}: ${e?.message || e}`);
    failed++;
    continue;
  }
  for (const r of f.closeOpen) {
    try {
      await closeGT(r);
      console.log(`    ✓ closed duplicate ${r.t} (${r.u})`);
      ok++;
    } catch (e) {
      console.log(`    ✗ close duplicate ${r.t}: ${e?.message || e}`);
      failed++;
    }
  }
}

console.log(`\nDone: ok=${ok} failed=${failed}`);
