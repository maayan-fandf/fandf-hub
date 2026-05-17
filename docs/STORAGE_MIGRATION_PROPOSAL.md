# Storage migration proposal — move the hot path off Google Sheets

Status: **proposal / decision pending**. Author: Claude, 2026-05-18.
Nothing here is built. This is for a deliberate go / no-go.

## TL;DR

Google Sheets is now the performance ceiling for the hub. The fix is
**not** "rip out Sheets" — it's: move the **code-owned hot data**
(tasks, comments, the pricing/time ledgers) to **Firestore (Native
mode)** behind the lib modules that already abstract every read/write,
and **leave the human/Supermetrics/dashboard sheets on Sheets**. The
legacy Apps Script dashboard is **not** a blocker (verified — see
below). Recommended: do it, phased, dual-write then flag-flip reads.

## Why

The `Comments` tab is a single sheet holding every task + every
comment + status history + pricing/time fields. Observed this session:

- **Quota**: the F&F GCP project hit the 300 reads/min/project Sheets
  cap during normal browsing (already worked around with a 5s
  process-local cache in `tasksDirect.readCommentsTab`).
- **2 MB cache ceiling**: `/morning` and the project page throw
  `unhandledRejection` — "items over 2MB can not be cached
  (3.1–3.9 MB)" — because a full Comments payload exceeds Next's
  `unstable_cache` limit. (Separate fix in flight.)
- **Full-tab scans**: every task/comment read pulls the *entire*
  `Comments` range and filters in JS. No indexes, no per-row fetch.
- **No transactions**: `tasksUpdateDirect` does read-modify-write
  under a hand-rolled `withTaskLock` to append `status_history` etc.
- The task detail page even read the whole tab twice (just fixed:
  parallelized; the real cure is one shared read or a real DB).

None of this gets better with more caching — it's structural.

## What moves vs. what stays

| Data | Today (Sheets) | Plan |
|---|---|---|
| Tasks (`row_kind=task`) | `Comments` tab | **→ Firestore `tasks`** |
| Comments + replies (`row_kind=comment`) | `Comments` tab | **→ Firestore `comments`** |
| Pricing ledger | `PricingLog` tab | **→ Firestore `pricingLog`** |
| Time ledger | `TimeLog` tab | **→ Firestore `timeLog`** (or drop — manual log UI was removed; status-time is derived. Decide.) |
| Rate card | `Pricingsetup` tab | **stays** (human-edited via /admin/pricing; small, low-traffic) |
| Keys (projects/roster/ad accounts) | Keys workbook | **stays** (human-edited; read by hub *and* legacy dashboard) |
| Metrics (GADS+FB, ALL CLIENTS, daily) | Sheets | **stays** (Supermetrics-fed + human-edited; read by the Apps Script dashboard) |
| names↔emails, chat-spaces, webhooks | Sheets | **stays** (config, human-edited) |

Principle: move data the **code owns and humans never hand-edit**;
keep data that is a **human or integration surface**.

## Legacy Apps Script dashboard is NOT a blocker (verified)

- `pollTaskCompletions()` (old GT-sync that touched `Comments`) is a
  **retired no-op since 2026-04-30** (`dashboard-clasp/Code.js`).
- The dashboard's own comment UI (buttons/drawer/mention picker) and
  its cold-load Comments read were **removed 2026-05-12**;
  `tpl.commentsEnabled = false` makes the remaining branches inert.
- Live comment/task writes go through hub-next's own
  `commentsWriteDirect` / `tasksWriteDirect` (direct Sheets), **not**
  the Apps Script `_hubApiHandle_` routes (those are vestigial
  fallback to delete).

⇒ Moving `Comments` off Sheets does not touch the dashboard render.

## The seam (the key enabler)

Every live task/comment access already funnels through a small set of
hub-next lib modules. Migration = swap their internals, keep their
signatures:

- `lib/tasksDirect.ts` — `tasksGet`/`tasksList`/`getAccessScope` (reads)
- `lib/tasksWriteDirect.ts` — `tasksCreateDirect`/`tasksUpdateDirect`
- `lib/commentsDirect.ts` — comment reads (project/task/mentions)
- `lib/commentsWriteDirect.ts` — comment writes
- `lib/pricingLog.ts`, `lib/timeLog.ts` — ledgers
- `lib/pollTasks.ts` (+ `userFastSync.ts`) — GT two-way sync (Cloud
  Scheduler; hub-side, already behind the seam)

There is already a feature-flag precedent (`useSATasksReads` /
`useSATasksWrites` / `useSACommentsReads` in `lib/sa.ts`) that switched
Apps Script → direct-Sheets. The same pattern switches Sheets →
Firestore with zero call-site changes.

## Why Firestore (not Postgres/Turso)

- Same GCP project + the existing service-account IAM — no new vendor,
  no new secrets, server-only access (no client SDK, locked rules).
- Serverless-native: Firebase App Hosting has no connection pool;
  Cloud SQL/Postgres needs a pooler (real ops cost). Firestore has
  none of that.
- The data is already row + JSON-blob shaped (status_history,
  google_tasks, time_pauses) → maps cleanly to documents/subfields.
- Relational joins aren't needed (access is by project/assignee/id).
- (Turso/SQLite is a cheaper alt but adds a vendor and still needs an
  access layer; Firestore is the natural fit here.)

## Data model (Firestore Native)

- `tasks/{taskId}` — one doc per task. Fields = current columns;
  `status_history`, `description_history`, `time_pauses`,
  `google_tasks` as array/map fields. Composite indexes:
  `(project, status)`, `(company, project)`, `(assignees array-contains, status)`,
  `(umbrella_id)`, `(blocks)/(blocked_by)` as needed.
- `comments/{commentId}` — `taskId`, `parentId`, body, mentions,
  resolved, timestamps. Index `(taskId, createdAt)`.
- `pricingLog/{autoId}` — append-only; `taskId`, company, project,
  month, price, **billed** (the override), createdBy. Index
  `(month, company)`, `(taskId)`.
- `timeLog/{autoId}` — only if we keep manual time at all.

IDs reuse the existing `T-…` task ids / comment ids so links,
GT refs, and cross-references keep working unchanged.

## Phased plan

0. **Prep (~1–2 d)**: enable Firestore Native in GCP `64182441464`;
   server-only security rules; add `@google-cloud/firestore` (admin)
   to hub-next; finalize schema + indexes; add `USE_FIRESTORE_TASKS`
   flag (default off).
1. **Backfill (~1–2 d)**: idempotent, re-runnable script reads the
   `Comments` tab → writes `tasks` + `comments` docs (and the
   ledgers). Verifiable row counts.
2. **Dual-write + parity (~3–5 d)**: `tasksWriteDirect` /
   `commentsWriteDirect` / `pricingLog` / `timeLog` write **both**
   Sheets (still source of truth) and Firestore. A diff job asserts
   parity. GT sync (`pollTasks`) writes both via the same seam.
3. **Read cutover behind flag (~1 wk elapsed, low active)**: flip
   reads in `tasksDirect`/`commentsDirect` to Firestore via
   `USE_FIRESTORE_TASKS` — **all-at-once** (hub not yet operational)
   once parity is clean; Sheets still dual-written for instant
   rollback. Watch perf + correctness.
4. **Firestore = source of truth (~2 d)**: stop Sheets writes for
   moved data. Replace `withTaskLock` read-modify-write with Firestore
   transactions (cleaner, removes the lock hack). **No standing Sheets
   export** — existing CSV exports cover on-demand needs.
5. **Cleanup (~2 d)**: delete the Sheets reader/cache/quota
   workarounds for moved data; delete the vestigial Apps Script
   `_hubApiHandle_` comment/task routes + retired `pollTaskCompletions`;
   update memory + this doc.

**Rough total: ~3 focused weeks calendar** (incl. a soak window),
bounded because the seam already exists and the dashboard is decoupled.

## Risks & mitigations

- **GT two-way sync timing** — dual-write in phase 2; cut over only
  after parity holds across a full poll cycle.
- **Rollback** — keep Sheets dual-written through phase 3 so a flag
  flip reverts instantly.
- **Concurrency** — Firestore transactions *replace* `withTaskLock`;
  net correctness improvement, but the append-history logic must be
  ported carefully.
- **Hidden hand-edits** — confirm nobody manually edits the `Comments`
  tab (the architecture says it's code-owned; verify with the team).
  If a human spreadsheet view is needed, phase 4's export covers it.
- **Cost** — trivial at this scale (tens of thousands of docs); list
  views need the composite indexes above.

## Decisions — RESOLVED 2026-05-18

1. **Go** — proceed with the phased plan.
2. **TimeLog** — DROPPED (legacy; manual UI already removed). No
   `timeLog` collection; delete `lib/timeLog.ts` + `/api/tasks/time`
   + the dead `/admin/time` merge.
3. **Phase-3 audience** — ALL-AT-ONCE (hub not yet operational; no
   users to soak-protect — flip the flag for everyone once parity is
   clean).
4. **Human Sheets export** — NO standing/recurring export (it's the
   long-haul coupling being removed). On-demand needs covered by
   existing CSV exports; ad-hoc only, zero standing cost, only if a
   concrete need later appears.

Execution detail lives in **`STORAGE_MIGRATION_HANDOFF.md`** — the
self-contained brief for the session that does the work.

## Independent quick wins (do regardless of the migration)

- ✅ Shipped: task page no longer reads `Comments` twice serially
  (`dbdbc97`).
- Optional: make tasks + comments share **one** cached `Comments`
  read per request (needs comment-write cache-invalidation). Buys
  time; harmless if the migration proceeds.
