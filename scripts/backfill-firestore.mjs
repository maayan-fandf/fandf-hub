/* eslint-disable */
/**
 * Phase 1 backfill — Sheets `Comments` + `PricingLog` → Firestore.
 * Part of the storage migration (docs/STORAGE_MIGRATION_HANDOFF.md).
 *
 * READS Sheets only; WRITES Firestore only. Never mutates the sheet.
 * Sheets stays the source of truth through Phase 3, so running this is
 * safe and reversible (drop the collections to undo).
 *
 * IDEMPOTENT + re-runnable: every doc is written by a DETERMINISTIC id
 * with a full `.set()` (overwrite), so re-running converges — no dupes.
 *   - tasks/{taskId}       taskId = the row's existing `T-…` id
 *   - comments/{commentId} commentId = the row's existing `c-…` id
 *   - pricingLog/{plog-<sha1(content)>}  content-hash id, IDENTICAL to
 *       lib/firestoreSync.ts pricingDocId. This is the key correctness
 *       constraint: the Phase-2 dual-write of a NEW ledger entry and a
 *       later backfill re-run of the SAME sheet row produce the SAME
 *       doc id → no double-count, and parity is an exact multiset
 *       compare. Two byte-identical ledger rows (same second, task,
 *       price, creator) collapse to one doc — indistinguishable
 *       charges on an append-only ledger; acceptable + safer than
 *       id drift. (A sheet-row-number id would NOT survive the
 *       dual-write join, since an appended entry doesn't know its row.)
 *
 * AUTH (two contexts, mirrors lib/firestore.ts vs lib/sa.ts):
 *   - Sheets read  → SA with domain-wide delegation, subject=maayan
 *     (same as scripts/add-*-column.mjs).
 *   - Firestore    → SA's OWN identity (no subject). Firestore uses
 *     plain GCP IAM (roles/datastore.user), not DWD.
 *
 * The mapping is a faithful port of BOTH rowToTask copies
 * (lib/tasksDirect.ts + lib/tasksWriteDirect.ts), the comment readers
 * (lib/commentsDirect.ts), and lib/pricingLog.ts. Firestore rejects
 * `undefined` → graceful/missing values become `null` (tasks) or the
 * documented default; arrays/maps are stored as native types.
 *
 * Usage (run from hub-next/):
 *   node scripts/backfill-firestore.mjs --dry-run       # counts only, no Firestore
 *   node scripts/backfill-firestore.mjs --limit 50      # smoke: first 50 of each
 *   node scripts/backfill-firestore.mjs --only tasks    # tasks|comments|pricing
 *   node scripts/backfill-firestore.mjs                 # full backfill
 */

import { google } from "googleapis";
import fs from "node:fs";
// Shared mapping — backfill + parity-check import the SAME logic so a
// parity check is meaningful (and stays aligned with lib/firestoreSync).
import {
  rowToTaskDoc,
  rowToCommentDoc,
  pricingRowToDoc,
  pricingDocId,
} from "./_fs-migration-map.mjs";

/* ── env ──────────────────────────────────────────────────────────── */
const envText = fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8")
  : "";
const env = (n) =>
  process.env[n] ||
  (envText.split("\n").find((l) => l.startsWith(n + "=")) || "").replace(
    /^[^=]+=/,
    "",
  );

const SUBJECT = "maayan@fandf.co.il";
const key = JSON.parse(env("TASKS_SA_KEY_JSON"));
const SHEET_ID_COMMENTS = env("SHEET_ID_COMMENTS");
if (!SHEET_ID_COMMENTS) {
  console.error("Missing SHEET_ID_COMMENTS in env/.env.local");
  process.exit(1);
}

/* ── args ─────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  if (i < 0) return Infinity;
  const n = parseInt(args[i + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();
const ONLY = (() => {
  const i = args.indexOf("--only");
  return i >= 0 ? String(args[i + 1] || "").trim() : "";
})();
const wants = (name) => !ONLY || ONLY === name;

/* ── Sheets read (DWD) ────────────────────────────────────────────── */
const sheetsAuth = new google.auth.JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  subject: SUBJECT,
});
const sheets = google.sheets({ version: "v4", auth: sheetsAuth });

async function readTab(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID_COMMENTS,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  return (res.data.values ?? []);
}

/* ── main ─────────────────────────────────────────────────────────── */
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  console.log(
    `[backfill] mode=${DRY_RUN ? "DRY-RUN" : "WRITE"} limit=${LIMIT === Infinity ? "∞" : LIMIT} only=${ONLY || "(all)"}`,
  );

  // ── read Comments ──────────────────────────────────────────────
  const values = await readTab("Comments");
  if (!values.length) {
    console.log("[backfill] Comments tab empty — nothing to do.");
    return;
  }
  const headers = values[0].map((h) => String(h ?? "").trim());
  const headerIdx = new Map();
  headers.forEach((h, i) => {
    if (h) headerIdx.set(h, i);
  });
  const rowKindIdx = headerIdx.get("row_kind");
  const idIdx = headerIdx.get("id");
  if (rowKindIdx == null || idIdx == null) {
    console.error("[backfill] Comments tab missing row_kind / id headers.");
    process.exit(1);
  }
  const dataRows = values.slice(1);

  // First pass: collect task ids (for comment.taskId resolution).
  const taskIds = new Set();
  for (const row of dataRows) {
    if (String(row[rowKindIdx] ?? "").trim() !== "task") continue;
    const id = String(row[idIdx] ?? "").trim();
    if (id) taskIds.add(id);
  }

  const taskDocs = [];
  const commentDocs = [];
  let skippedEmptyId = 0;
  for (const row of dataRows) {
    const rk = String(row[rowKindIdx] ?? "").trim();
    const id = String(row[idIdx] ?? "").trim();
    if (rk === "task") {
      if (!id) {
        skippedEmptyId++;
        continue;
      }
      taskDocs.push(rowToTaskDoc(row, headerIdx));
    } else {
      if (!id) {
        skippedEmptyId++;
        continue;
      }
      commentDocs.push(rowToCommentDoc(row, headerIdx, taskIds));
    }
  }

  // ── read PricingLog ────────────────────────────────────────────
  let pricingDocs = [];
  if (wants("pricing")) {
    let plog = [];
    try {
      plog = await readTab("PricingLog!A2:I");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Unable to parse range|not found/i.test(msg)) {
        console.log("[backfill] PricingLog tab absent — 0 ledger rows.");
      } else {
        throw e;
      }
    }
    plog.forEach((r) => {
      const doc = pricingRowToDoc(r); // null = readPricingLog-skip row
      if (doc) pricingDocs.push(doc);
    });
  }

  // Apply --limit / --only.
  const tSlice = wants("tasks") ? taskDocs.slice(0, LIMIT) : [];
  const cSlice = wants("comments") ? commentDocs.slice(0, LIMIT) : [];
  const pSlice = wants("pricing") ? pricingDocs.slice(0, LIMIT) : [];

  console.log(
    `[backfill] parsed: tasks=${taskDocs.length} comments=${commentDocs.length} pricingLog=${pricingDocs.length} skipped(empty id)=${skippedEmptyId}`,
  );
  console.log(
    `[backfill] will write: tasks=${tSlice.length} comments=${cSlice.length} pricingLog=${pSlice.length}`,
  );

  if (DRY_RUN) {
    const sample = tSlice[0] || cSlice[0] || pSlice[0];
    if (sample) console.log("[backfill] sample doc:", JSON.stringify(sample).slice(0, 600));
    console.log("[backfill] DRY-RUN — no Firestore writes performed.");
    return;
  }

  // ── Firestore (SA own identity, no DWD) ────────────────────────
  const { Firestore } = await import("@google-cloud/firestore");
  const db = new Firestore({
    projectId: key.project_id,
    databaseId: process.env.FIRESTORE_DATABASE_ID || "(default)",
    credentials: {
      client_email: key.client_email,
      private_key: key.private_key,
    },
  });

  async function writeAll(collName, docs, idOf) {
    let written = 0;
    for (const part of chunk(docs, 450)) {
      const batch = db.batch();
      for (const d of part) {
        batch.set(db.collection(collName).doc(idOf(d)), d);
      }
      await batch.commit();
      written += part.length;
      process.stdout.write(
        `\r[backfill] ${collName}: ${written}/${docs.length}   `,
      );
    }
    if (docs.length) process.stdout.write("\n");
    return written;
  }

  try {
    let wT = 0,
      wC = 0,
      wP = 0;
    if (tSlice.length) wT = await writeAll("tasks", tSlice, (d) => d.id);
    if (cSlice.length) wC = await writeAll("comments", cSlice, (d) => d.id);
    if (pSlice.length)
      wP = await writeAll("pricingLog", pSlice, (d) => pricingDocId(d));

    console.log(
      `[backfill] DONE — wrote tasks=${wT} comments=${wC} pricingLog=${wP}`,
    );

    // ── spot-check: read back a few docs ─────────────────────────
    console.log("[backfill] spot-check:");
    for (const d of tSlice.slice(0, 3)) {
      const snap = await db.collection("tasks").doc(d.id).get();
      const t = snap.data();
      console.log(
        `  tasks/${d.id} exists=${snap.exists} status=${t?.status} project=${t?.project} title="${String(t?.title || "").slice(0, 40)}" assignees=${JSON.stringify(t?.assignees)}`,
      );
    }
    for (const d of cSlice.slice(0, 2)) {
      const snap = await db.collection("comments").doc(d.id).get();
      const c = snap.data();
      console.log(
        `  comments/${d.id} exists=${snap.exists} taskId="${c?.taskId}" parent_id="${c?.parent_id}" resolved=${c?.resolved}`,
      );
    }
    for (const d of pSlice.slice(0, 1)) {
      const pid = pricingDocId(d);
      const snap = await db.collection("pricingLog").doc(pid).get();
      const p = snap.data();
      console.log(
        `  pricingLog/${pid} exists=${snap.exists} month=${p?.month} taskId=${p?.taskId} price=${p?.price} billed=${p?.billed}`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      /has not been used|NOT_FOUND|PERMISSION_DENIED|forbidden|datastore|5 NOT_FOUND|7 PERMISSION_DENIED/i.test(
        msg,
      )
    ) {
      console.error(
        "\n[backfill] Firestore write failed — looks like the Phase-0 infra isn't ready.\n" +
          "  Required (see lib/firestore.ts header):\n" +
          "   A. Console → Firestore → Create database (NATIVE mode)\n" +
          "   B. Console → IAM → grant the SA roles/datastore.user\n" +
          "   C. firebase deploy --only firestore:rules,firestore:indexes\n" +
          `  Underlying error: ${msg}`,
      );
      process.exit(2);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error("[backfill] FATAL:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
