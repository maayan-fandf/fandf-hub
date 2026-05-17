/* eslint-disable */
/**
 * Phase 2 parity check — diff Sheets (source of truth) vs Firestore for
 * tasks / comments / pricingLog. Part of the storage migration
 * (docs/STORAGE_MIGRATION_HANDOFF.md).
 *
 * READ-ONLY on both sides. Run it repeatedly while dual-write soaks;
 * the handoff gate for Phase 3 is "parity clean across a full GT poll
 * cycle". Exit code 0 = clean, 1 = drift (CI / `/loop`-friendly).
 *
 * Apples-to-apples: the expected docs are built with the SAME shared
 * mapping (scripts/_fs-migration-map.mjs) the backfill + the live
 * dual-write (lib/firestoreSync.ts) use, so a diff means real drift,
 * not a mapping mismatch.
 *
 *   - tasks / comments : joined by doc id. Reports missing-in-FS,
 *     extra-in-FS, and per-field drift (key-sorted deep compare).
 *   - pricingLog       : multiset compare by the content-hash doc id
 *     (append-only ledger, no natural id).
 *
 * Usage (run from hub-next/):
 *   node scripts/parity-check.mjs                 # all three
 *   node scripts/parity-check.mjs --only tasks    # tasks|comments|pricing
 *   node scripts/parity-check.mjs --samples 25    # show N drift examples
 *   node scripts/parity-check.mjs --verbose       # full JSON of 1st drift
 */

import { google } from "googleapis";
import fs from "node:fs";
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
  console.error("Missing SHEET_ID_COMMENTS");
  process.exit(1);
}

/* ── args ─────────────────────────────────────────────────────────── */
const args = process.argv.slice(2);
const ONLY = (() => {
  const i = args.indexOf("--only");
  return i >= 0 ? String(args[i + 1] || "").trim() : "";
})();
const wants = (n) => !ONLY || ONLY === n;
const SAMPLES = (() => {
  const i = args.indexOf("--samples");
  if (i < 0) return 10;
  const n = parseInt(args[i + 1], 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
})();
const VERBOSE = args.includes("--verbose");

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
  return res.data.values ?? [];
}

/* ── canonical stringify (key-sorted, array order preserved) ──────── */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canon(v[k]))
      .join(",")}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

/** Per-doc field diff → list of differing keys. */
function fieldDiff(expected, actual) {
  const keys = new Set([
    ...Object.keys(expected || {}),
    ...Object.keys(actual || {}),
  ]);
  const diffs = [];
  for (const k of keys) {
    if (canon(expected?.[k]) !== canon(actual?.[k])) diffs.push(k);
  }
  return diffs.sort();
}

/* ── Firestore (SA own identity, no DWD) ──────────────────────────── */
let db;
async function getDb() {
  if (db) return db;
  const { Firestore } = await import("@google-cloud/firestore");
  db = new Firestore({
    projectId: key.project_id,
    databaseId: process.env.FIRESTORE_DATABASE_ID || "(default)",
    credentials: {
      client_email: key.client_email,
      private_key: key.private_key,
    },
  });
  return db;
}
async function readCollection(name) {
  const snap = await (await getDb()).collection(name).get();
  const map = new Map();
  snap.forEach((d) => map.set(d.id, d.data()));
  return map;
}

/* ── id-joined compare (tasks / comments) ─────────────────────────── */
function compareById(label, expectedMap, fsMap) {
  const missingInFs = [];
  const extraInFs = [];
  const drift = [];
  for (const [id, exp] of expectedMap) {
    if (!fsMap.has(id)) {
      missingInFs.push(id);
      continue;
    }
    const d = fieldDiff(exp, fsMap.get(id));
    if (d.length) drift.push({ id, fields: d });
  }
  for (const id of fsMap.keys()) {
    if (!expectedMap.has(id)) extraInFs.push(id);
  }
  const clean =
    missingInFs.length === 0 && extraInFs.length === 0 && drift.length === 0;
  console.log(
    `\n[${label}] sheet=${expectedMap.size} firestore=${fsMap.size} → ${
      clean ? "CLEAN ✓" : "DRIFT ✗"
    }`,
  );
  if (missingInFs.length)
    console.log(
      `  missing in Firestore: ${missingInFs.length} — ${missingInFs
        .slice(0, SAMPLES)
        .join(", ")}${missingInFs.length > SAMPLES ? " …" : ""}`,
    );
  if (extraInFs.length)
    console.log(
      `  extra in Firestore (not in sheet): ${extraInFs.length} — ${extraInFs
        .slice(0, SAMPLES)
        .join(", ")}${extraInFs.length > SAMPLES ? " …" : ""}`,
    );
  if (drift.length) {
    console.log(`  field drift: ${drift.length} doc(s)`);
    for (const dft of drift.slice(0, SAMPLES)) {
      console.log(`    ${dft.id}: [${dft.fields.join(", ")}]`);
    }
    if (drift.length > SAMPLES)
      console.log(`    … +${drift.length - SAMPLES} more`);
    if (VERBOSE && drift[0]) {
      const id = drift[0].id;
      console.log("  --- verbose first-drift ---");
      console.log("  expected:", canon(expectedMap.get(id)));
      console.log("  firestore:", canon(fsMap.get(id)));
    }
  }
  return clean;
}

/* ── main ─────────────────────────────────────────────────────────── */
async function main() {
  let allClean = true;

  // Read Comments once; split into task / comment expected docs.
  const values = await readTab("Comments");
  const headers = (values[0] ?? []).map((h) => String(h ?? "").trim());
  const headerIdx = new Map();
  headers.forEach((h, i) => {
    if (h) headerIdx.set(h, i);
  });
  const rowKindIdx = headerIdx.get("row_kind");
  const idIdx = headerIdx.get("id");
  const dataRows = values.slice(1);

  const taskIds = new Set();
  for (const row of dataRows) {
    if (String(row[rowKindIdx] ?? "").trim() !== "task") continue;
    const id = String(row[idIdx] ?? "").trim();
    if (id) taskIds.add(id);
  }

  if (wants("tasks")) {
    const expected = new Map();
    for (const row of dataRows) {
      if (String(row[rowKindIdx] ?? "").trim() !== "task") continue;
      const id = String(row[idIdx] ?? "").trim();
      if (!id) continue;
      expected.set(id, rowToTaskDoc(row, headerIdx));
    }
    const fsMap = await readCollection("tasks");
    allClean = compareById("tasks", expected, fsMap) && allClean;
  }

  if (wants("comments")) {
    const expected = new Map();
    for (const row of dataRows) {
      if (String(row[rowKindIdx] ?? "").trim() === "task") continue;
      const id = String(row[idIdx] ?? "").trim();
      if (!id) continue;
      expected.set(id, rowToCommentDoc(row, headerIdx, taskIds));
    }
    const fsMap = await readCollection("comments");
    allClean = compareById("comments", expected, fsMap) && allClean;
  }

  if (wants("pricing")) {
    let plog = [];
    try {
      plog = await readTab("PricingLog!A2:I");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/Unable to parse range|not found/i.test(msg)) throw e;
    }
    const expected = new Map();
    for (const r of plog) {
      const doc = pricingRowToDoc(r);
      if (!doc) continue;
      expected.set(pricingDocId(doc), doc);
    }
    const fsMap = await readCollection("pricingLog");
    allClean = compareById("pricingLog", expected, fsMap) && allClean;
  }

  console.log(
    `\n[parity] ${allClean ? "ALL CLEAN ✓ — safe to proceed" : "DRIFT DETECTED ✗ — investigate before Phase 3 cutover"}`,
  );
  process.exit(allClean ? 0 : 1);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/has not been used|NOT_FOUND|PERMISSION_DENIED|datastore/i.test(msg)) {
    console.error(
      "[parity] Firestore not reachable — finish the Phase-0 infra " +
        "(create DB / grant SA roles/datastore.user). Underlying: " +
        msg,
    );
    process.exit(2);
  }
  console.error("[parity] FATAL:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
