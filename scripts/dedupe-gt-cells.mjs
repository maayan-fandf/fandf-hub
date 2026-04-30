/* eslint-disable */
// One-shot: dedupe (recipient, kind) duplicate refs in every task
// row's google_tasks cell, and close the redundant GTs in the
// recipient's tasklist.
//
//   node scripts/dedupe-gt-cells.mjs              # dry-run (default)
//   node scripts/dedupe-gt-cells.mjs --commit     # actually clean
//
// Triggered by the 2026-04-30 reconciliation-loop bug, which
// spawned an extra GT per (recipient, kind) per cycle for several
// minutes. Cells now have multiple refs for the same key. This
// script keeps ONE healthy ref per group (preferring the one whose
// GT is visible in the recipient's tasklist; falling back to the
// most-recently-spawned if none are visible) and closes/drops the
// rest.
//
// Idempotent — re-running on a clean state is a no-op.
import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8") : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}
const SHEET_ID_COMMENTS = process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");
const k = JSON.parse(process.env.TASKS_SA_KEY_JSON || envFromFile("TASKS_SA_KEY_JSON"));
const COMMIT = process.argv.includes("--commit");
const SUBJECT = "maayan@fandf.co.il";

function jwt(scopes, subject) {
  return new google.auth.JWT({
    email: k.client_email,
    key: k.private_key,
    scopes,
    subject,
  });
}

const sheets = google.sheets({
  version: "v4",
  auth: jwt(["https://www.googleapis.com/auth/spreadsheets"], SUBJECT),
});

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID_COMMENTS,
  range: "Comments",
  valueRenderOption: "UNFORMATTED_VALUE",
});
const rows = res.data.values || [];
const headers = (rows[0] || []).map((h) => String(h ?? "").trim());
const I = {
  id: headers.indexOf("id"),
  kind: headers.indexOf("row_kind"),
  status: headers.indexOf("status"),
  gt: headers.indexOf("google_tasks"),
  proj: headers.indexOf("project"),
  title: headers.indexOf("title"),
};

function parseCell(v) {
  if (v == null || v === "") return [];
  let p = v;
  if (typeof v === "string") {
    try { p = JSON.parse(v); } catch { return []; }
  }
  if (Array.isArray(p)) return p;
  if (p && typeof p === "object") return Object.values(p);
  return [];
}

function columnLetter(n) {
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Collect candidate rows + per-recipient list of GT ids the script
// will need to verify against the user's tasklist.
const candidates = []; // [{rowIdx, taskId, refs: GTaskRef[]}]
const usersToList = new Set();

for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  if (String(row[I.kind] ?? "").trim() !== "task") continue;
  const refs = parseCell(I.gt < 0 ? "" : row[I.gt]);
  if (refs.length < 2) continue;
  // Group by (u, kind) to find groups >1 — only those have duplicates.
  const groups = new Map();
  for (const r2 of refs) {
    const key = `${(r2.u || "").toLowerCase()}|${r2.kind ?? "todo"}`;
    const list = groups.get(key) ?? [];
    list.push(r2);
    groups.set(key, list);
  }
  let hasDup = false;
  for (const list of groups.values()) {
    if (list.length > 1) { hasDup = true; break; }
  }
  if (!hasDup) continue;
  candidates.push({
    rowIdx: r, // 0-based in `values`
    taskId: String(row[I.id] ?? ""),
    title: String(row[I.title] ?? ""),
    project: String(row[I.proj] ?? ""),
    refs,
  });
  for (const r2 of refs) {
    if (r2.u) usersToList.add(String(r2.u).toLowerCase());
  }
}

console.log(`Rows scanned: ${rows.length - 1}`);
console.log(`Task rows with (u, kind) duplicates: ${candidates.length}`);
console.log(`Distinct users to list tasklists for: ${usersToList.size}`);
if (candidates.length === 0) {
  console.log("\nNothing to do.");
  process.exit(0);
}

// List each user's tasklist to learn which GT ids are visible.
const visibleByUser = new Map(); // email → Set<gt id>
const listIdByUser = new Map();
for (const u of usersToList) {
  const ids = new Set();
  try {
    const tasks = google.tasks({
      version: "v1",
      auth: jwt(["https://www.googleapis.com/auth/tasks"], u),
    });
    const lists = await tasks.tasklists.list({ maxResults: 1 });
    const listId = lists.data.items?.[0]?.id;
    if (listId) {
      listIdByUser.set(u, listId);
      let pt;
      do {
        const r = await tasks.tasks.list({
          tasklist: listId,
          showCompleted: false,
          showHidden: false,
          maxResults: 100,
          pageToken: pt,
        });
        for (const t of r.data.items ?? []) {
          if (t.id) ids.add(t.id);
        }
        pt = r.data.nextPageToken;
      } while (pt);
    }
  } catch (e) {
    console.log(`  warn: list failed for ${u}: ${e?.message || e}`);
  }
  visibleByUser.set(u, ids);
}

// For each candidate, decide which refs to keep / close / drop.
let closed = 0;
let droppedFromCell = 0;
const cellUpdates = []; // { range, values: [[json]] }
for (const c of candidates) {
  const groups = new Map();
  for (const r2 of c.refs) {
    const key = `${(r2.u || "").toLowerCase()}|${r2.kind ?? "todo"}`;
    const list = groups.get(key) ?? [];
    list.push(r2);
    groups.set(key, list);
  }
  const keptRefs = [];
  const toClose = []; // refs whose GTs are still open and need patching to completed
  for (const [key, list] of groups) {
    if (list.length === 1) {
      keptRefs.push(list[0]);
      continue;
    }
    const u = key.split("|")[0];
    const visible = visibleByUser.get(u) ?? new Set();
    // Prefer a ref whose GT is currently visible (open) in the user's
    // list. Fallback to the LAST one in the array (most recently
    // spawned by the buggy reconciliation loop).
    const visibleOnes = list.filter((r) => visible.has(r.t));
    let canonical;
    if (visibleOnes.length > 0) {
      canonical = visibleOnes[visibleOnes.length - 1];
    } else {
      canonical = list[list.length - 1];
    }
    keptRefs.push(canonical);
    for (const r of list) {
      if (r === canonical) continue;
      // Drop from cell. If still visible, also queue a close.
      if (visible.has(r.t)) toClose.push(r);
    }
    droppedFromCell += list.length - 1;
  }

  console.log(
    `\n${c.taskId} "${c.title}" (${c.project})`,
  );
  console.log(`  cell: ${c.refs.length} refs → ${keptRefs.length} after dedupe`);
  if (toClose.length > 0) {
    console.log(`  will close GTs: ${toClose.map((r) => r.t).join(", ")}`);
  }

  closed += toClose.length;
  // Skip close attempts entirely when we couldn't list any user's
  // tasklist (quota exhausted) — the patches would fail anyway.
  // Pair this run with a follow-up `audit-orphan-gts.mjs --cleanup`
  // tomorrow once Tasks API daily quota resets; that script picks
  // up GTs not referenced in any cell and closes them.
  const tasksApiAvailable = [...visibleByUser.values()].some((s) => s.size > 0);
  if (COMMIT && tasksApiAvailable) {
    for (const r of toClose) {
      try {
        const tasks = google.tasks({
          version: "v1",
          auth: jwt(["https://www.googleapis.com/auth/tasks"], r.u),
        });
        await tasks.tasks.patch({
          tasklist: r.l,
          task: r.t,
          requestBody: { status: "completed" },
        });
      } catch (e) {
        console.log(
          `    warn: patch failed for ${r.t} on ${r.u}: ${e?.message?.slice(0, 200) || e}`,
        );
      }
      await new Promise((res) => setTimeout(res, 250));
    }
  } else if (COMMIT) {
    // Quota path — skip silently. The dropped refs will surface in
    // tomorrow's audit-orphan-gts run as "Not in row.google_tasks
    // cell" and get closed there.
  }
  // Queue cell update (single update at the end if --commit).
  const sheetRow = c.rowIdx + 1;
  const colA1 = columnLetter(I.gt + 1);
  cellUpdates.push({
    range: `Comments!${colA1}${sheetRow}`,
    values: [[JSON.stringify(keptRefs)]],
  });
}

console.log(
  `\nSummary: ${candidates.length} rows would be cleaned. ${droppedFromCell} refs dropped from cells. ${closed} duplicate GTs would be closed.`,
);

if (!COMMIT) {
  console.log("\nDry-run only. Re-run with --commit to apply.");
  process.exit(0);
}

// Apply cell updates in one batch.
console.log(`\nWriting ${cellUpdates.length} cell update(s)…`);
await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: SHEET_ID_COMMENTS,
  requestBody: { valueInputOption: "RAW", data: cellUpdates },
});
console.log("Done.");
