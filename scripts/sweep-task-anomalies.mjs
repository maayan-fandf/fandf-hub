/* eslint-disable */
// One-shot comprehensive sweep of every Comments-sheet task row,
// flagging every drift type the GT integration can produce. Read-only.
//
// Usage:  node scripts/sweep-task-anomalies.mjs
//
// Surfaces (each with a severity tag and one-line explanation per row):
//
//   E1  empty id on row_kind=task                       — task is invisible to hub
//   E2  empty id, recoverable from GT notes hub URL    — auto-fixable
//   E3  google_tasks cell unparseable JSON             — cell corruption
//   E4  google_tasks cell in old {email:{...}} shape   — pre-array shape; migration target
//   E5  awaiting_approval, no approve entry in cell    — stuck row
//   E6  awaiting_approval, approver_email empty        — semantically broken
//   E7  in_progress / awaiting_handling, no todo entry — stuck the other way
//   E8  done / cancelled, but cell has open kind=todo/approve/clarify ref
//                                                      — leak; cascade close failed
//   E9  duplicate (email, kind) entries in cell        — accumulated drift
//   I1  status=draft and cell has refs                 — informational; usually harmless
//
// Calls the Tasks API per ref to verify GT-side status (open vs
// completed vs deleted). Caches per (user, listId, taskId). For 134
// rows × ~2 refs avg → ~270 calls; at ~50ms each that's ~15s. Acceptable.

import { google } from "googleapis";
import fs from "node:fs";

const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
function envFromFile(name) {
  const line = envText.split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.replace(/^[^=]+=/, "") : "";
}

const SUBJECT = "maayan@fandf.co.il"; // canonical admin for sheet read
const SHEET_ID_COMMENTS =
  process.env.SHEET_ID_COMMENTS || envFromFile("SHEET_ID_COMMENTS");

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

const sheets = google.sheets({
  version: "v4",
  auth: jwt(["https://www.googleapis.com/auth/spreadsheets"], SUBJECT),
});

// Per-user Tasks API client cache (avoids re-creating JWTs).
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

// Per-(user, listId, taskId) result cache.
const gtCache = new Map();
async function fetchGT(ref) {
  if (!ref.u || !ref.l || !ref.t) return { __error: "incomplete-ref" };
  const key = `${ref.u}:${ref.l}:${ref.t}`;
  if (gtCache.has(key)) return gtCache.get(key);
  let result;
  try {
    const api = tasksClientFor(ref.u);
    const r = await api.tasks.get({ tasklist: ref.l, task: ref.t });
    result = { status: r.data.status, title: r.data.title, notes: r.data.notes || "" };
  } catch (e) {
    const code = e?.response?.status;
    result = { __error: code === 404 ? "deleted" : String(code || e?.message || e) };
  }
  gtCache.set(key, result);
  return result;
}

function parseCell(raw) {
  if (raw == null || raw === "") return { ok: true, kind: "empty", refs: [] };
  if (typeof raw === "string" && raw.trim() === "") return { ok: true, kind: "empty", refs: [] };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { ok: true, kind: "array", refs: parsed };
    if (parsed && typeof parsed === "object") {
      return { ok: true, kind: "object-keyed", refs: Object.values(parsed) };
    }
    return { ok: false, kind: "scalar", refs: [] };
  } catch (e) {
    return { ok: false, kind: "unparseable", refs: [], err: String(e?.message || e) };
  }
}

function extractHubIdFromNotes(notes) {
  if (!notes) return "";
  const m = String(notes).match(/https:\/\/hub\.fandf\.co\.il\/tasks\/([\w-]+)/);
  return m ? m[1] : "";
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
const I_AUTHOR = idx("author_email");
const I_APPROVER = idx("approver_email");

console.log(`Comments sheet: ${SHEET_ID_COMMENTS}`);
console.log(`Total rows: ${rows.length - 1}`);
console.log(`Sweeping…\n`);

const findings = [];
function flag(severity, code, sheetRow, ctx) {
  findings.push({ severity, code, sheetRow, ...ctx });
}

let taskRowCount = 0;
for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  const sheetRow = i + 1;
  const rowKind = String(row[I_KIND] ?? "").trim();
  if (rowKind !== "task") continue;
  taskRowCount++;

  const id = String(row[I_ID] ?? "").trim();
  const status = String(row[I_STATUS] ?? "").trim();
  const title = String(row[I_TITLE] ?? "").trim();
  const project = String(row[I_PROJECT] ?? "").trim();
  const approver = String(row[I_APPROVER] ?? "").trim().toLowerCase();
  const cellRaw = String(row[I_GT] ?? "");
  const parsed = parseCell(cellRaw);
  const ctx = { id, status, title: title.slice(0, 60), project };

  // E3: cell unparseable
  if (!parsed.ok) {
    flag("E3", "cell-unparseable", sheetRow, { ...ctx, err: parsed.err });
    continue;
  }
  // E4: old object-keyed cell shape (still parseable but pre-array)
  if (parsed.kind === "object-keyed" && parsed.refs.length > 0) {
    flag("E4", "cell-old-shape", sheetRow, ctx);
  }

  // E1/E2: empty id on a task row
  if (!id) {
    // Try to recover a hub-task-id from any ref's GT notes
    let recoverable = "";
    for (const ref of parsed.refs) {
      const gt = await fetchGT(ref);
      const hubId = extractHubIdFromNotes(gt.notes);
      if (hubId) {
        recoverable = hubId;
        break;
      }
    }
    if (recoverable) {
      flag("E2", "empty-id-recoverable", sheetRow, { ...ctx, recoverable });
    } else {
      flag("E1", "empty-id-no-recovery", sheetRow, ctx);
    }
  }

  // E9: duplicate (email, kind) entries
  const seen = new Map();
  for (const ref of parsed.refs) {
    if (!ref || typeof ref !== "object") continue;
    const k = `${(ref.u || "").toLowerCase()}|${ref.kind ?? "todo"}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  for (const [k, n] of seen) {
    if (n > 1) flag("E9", "cell-duplicate-pair", sheetRow, { ...ctx, pair: k, count: n });
  }

  // Status-shape checks — fetch GT statuses for relevant refs only.
  const refsByKind = { todo: [], approve: [], clarify: [] };
  for (const ref of parsed.refs) {
    if (!ref || typeof ref !== "object") continue;
    const k = ref.kind ?? "todo";
    if (refsByKind[k]) refsByKind[k].push(ref);
  }

  if (status === "awaiting_approval") {
    if (refsByKind.approve.length === 0) {
      // E5: stuck — no approve ref to drive the next transition
      flag("E5", "awaiting-approval-no-approve-ref", sheetRow, ctx);
    }
    if (!approver) {
      // E6: no one to approve, status will sit forever
      flag("E6", "awaiting-approval-no-approver-email", sheetRow, ctx);
    }
  }
  if (status === "in_progress" || status === "awaiting_handling") {
    if (refsByKind.todo.length === 0) {
      flag("E7", "active-no-todo-ref", sheetRow, ctx);
    }
  }
  if (status === "done" || status === "cancelled") {
    // E8: any open GT on a terminal row is a leak
    for (const ref of parsed.refs) {
      const gt = await fetchGT(ref);
      if (gt.__error === "deleted") continue;
      if (gt.__error) continue; // unknown — don't false-flag
      if (gt.status !== "completed") {
        flag("E8", "terminal-row-open-gt", sheetRow, {
          ...ctx,
          ref: { u: ref.u, kind: ref.kind, t: ref.t },
          gtStatus: gt.status,
        });
      }
    }
  }

  // I1: draft with refs
  if (status === "draft" && parsed.refs.length > 0) {
    flag("I1", "draft-with-refs", sheetRow, ctx);
  }
}

// Summary table
console.log(`Task rows: ${taskRowCount}`);
console.log(`Findings: ${findings.length}\n`);
const bySeverity = new Map();
for (const f of findings) {
  if (!bySeverity.has(f.severity)) bySeverity.set(f.severity, []);
  bySeverity.get(f.severity).push(f);
}
const order = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "I1"];
for (const sev of order) {
  const items = bySeverity.get(sev);
  if (!items || items.length === 0) continue;
  console.log(`──── ${sev}  (${items[0].code}) — ${items.length} row(s) ────`);
  for (const f of items) {
    const detail = [];
    if (f.recoverable) detail.push(`recoverable=${f.recoverable}`);
    if (f.pair) detail.push(`pair=${f.pair}`);
    if (f.count) detail.push(`count=${f.count}`);
    if (f.gtStatus) detail.push(`gt=${f.gtStatus}`);
    if (f.ref) detail.push(`ref=${f.ref.u}|${f.ref.kind}|${f.ref.t}`);
    if (f.err) detail.push(`err=${f.err}`);
    console.log(
      `  row ${String(f.sheetRow).padStart(3)}  id="${f.id || "(EMPTY)"}"  status=${f.status}  proj=${f.project}  "${f.title}"${detail.length ? "  " + detail.join(" ") : ""}`,
    );
  }
  console.log();
}
if (findings.length === 0) {
  console.log("✓ No anomalies detected. Sync is clean.");
}
