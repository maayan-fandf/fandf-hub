# Storage migration — execution handoff (for a fresh Claude session)

You are picking this up cold. Read this whole file first. The
companion `STORAGE_MIGRATION_PROPOSAL.md` has the "why"; **this** file
is the "how" + every piece of context you need. Decisions are made;
execute the phases in order. Do not redesign — if something seems
wrong, flag it, don't silently deviate.

---

## 0. Goal (one paragraph)

Move the **code-owned hot data** off Google Sheets into **Firestore
(Native mode)**, behind the existing hub-next lib seam, without
breaking GT sync or the legacy Apps Script dashboard. Keep
human/Supermetrics/config sheets on Sheets. Dual-write first, flip
reads behind a flag, then make Firestore source of truth.

**Moves → Firestore:** tasks, comments (+replies), `pricingLog`.
**Stays on Sheets:** Keys, Pricingsetup (rate card), metrics tabs
(GADS+FB / ALL CLIENTS / daily), names↔emails, chat-spaces, webhooks.
**Dropped entirely (decided):** `TimeLog` — see §7.

---

## 1. Environment & conventions (READ — non-obvious)

- **Repo layout**: working root is `…/claude fandf dashboard`. The
  Next.js app is the nested git repo **`hub-next/`** (its own
  `.git`). The root is NOT a git repo. Run all git from `hub-next/`:
  `cd hub-next && git …`. The Apps Script project is
  `dashboard-clasp/` (separate, clasp-managed).
- **Deploy**: pushing `hub-next` to `origin/main` **auto-deploys** to
  Firebase App Hosting (production `hub.fandf.co.il`). There is no
  staging. So: `npm run typecheck` MUST pass before every push.
- **Verify**: authenticated routes (`/tasks`, `/projects`, `/morning`,
  `/admin/*`) **redirect to /signin in local/preview** — you cannot
  drive OAuth. Verification = `npm run typecheck` + (optional) a
  `preview_start` server checked via `preview_logs` for compile
  errors. **The user verifies behavior in their real browser.** Never
  claim a UI/flow is verified.
- **git hygiene**: NEVER `git add -A`/`.` — the repo is public and
  untracked files have leaked secrets before. Stage explicit paths.
  Commit trailer: `Co-Authored-By: Claude Opus 4.7 (1M context)
  <noreply@anthropic.com>`. Push autonomously after tsc is green
  (user expects this; don't stall).
- **Secrets/infra** (verify exact values in `hub-next/.env.local` and
  the Firebase/GCP console — these are from project memory):
  - `SHEET_ID_COMMENTS` — the workbook holding `Comments`,
    `PricingLog`, `TimeLog`, `Pricingsetup`.
  - SA JWT key env (used by `scripts/*.mjs`): `TASKS_SA_KEY_JSON`
    (impersonates `maayan@fandf.co.il` via domain-wide delegation;
    see `lib/sa.ts`).
  - GCP project `64182441464`. Firestore Native goes in this project;
    auth via the same service account (server-only; no client SDK;
    locked security rules).
- **Memory you MUST load** (the user's auto-memory dir; `MEMORY.md` is
  the index — read these entries before touching code):
  - `reference_pricing_billing_architecture.md` — tasks/pricing/time
    data model, the graceful-column pattern, every column added.
  - `reference_gt_sync_architecture.md` — GT two-way sync topology.
  - `feedback_unstable_cache_multi_instance.md`,
    `feedback_no_nested_unstable_cache.md` — why caching is done with
    React `cache()` + process-local Map, NOT `unstable_cache`.
  - `feedback_sheets_api_quota.md` — the 300/min quota that forced the
    Comments cache; the pain this migration removes.
  - `feedback_git_add_dash_a_security.md`, `feedback_push_autonomously.md`,
    `feedback_preview_before_push.md`, `feedback_oauth_blocks_preview_verify.md`.
  - `feedback_dual_apps_script_deploy.md` + `feedback_dashboard_manifest_flip.md`
    — ONLY if you end up deleting Apps Script routes in §6 cleanup.

---

## 2. The seam — exact modules/functions to swap

Every live task/comment access funnels through these. Migration =
swap their **internals**, keep their **signatures**. There is already
a flag precedent in `lib/sa.ts` (`useSATasksReads` /
`useSATasksWrites` / `useSACommentsReads`) that switched Apps Script →
direct-Sheets; add `USE_FIRESTORE_TASKS` the same way.

Reads:
- `lib/tasksDirect.ts`
  - `readCommentsTab(subjectEmail)` → `{headers, rows[], headerIdx}` —
    React `cache()` + 5s process-local TTL (`_commentsCacheValue`,
    `invalidateCommentsCache()`). The full-`Comments`-tab reader.
  - `tasksGetDirect(user, taskId)`, `tasksListDirect(user, filters)`,
    `getAccessScope(subjectEmail)`, `rowToTask(row, headerIdx)`.
- `lib/commentsDirect.ts`
  - `readCommentsOnce(subjectEmail)` → `{rows, headerIdx}` — a SEPARATE,
    **uncached** full-`Comments` read (the perf smell; Firestore makes
    it per-doc).
  - `taskCommentsDirect`, `projectComments`, `myMentions`.
- `lib/appsScript.ts` wrappers: `tasksGet`, `tasksList`,
  `getTaskComments` (React `cache()`-wrapped) — dispatch on the flags.

Writes:
- `lib/tasksWriteDirect.ts` — `tasksCreateDirect(subjectEmail, input)`,
  `tasksUpdateDirect(subjectEmail, taskId, patch: TasksUpdatePatch)`
  (wraps `withTaskLock` → read-modify-write; appends `status_history`;
  `SIMPLE_DIRECT` field list incl. `price`, `inprogress_minutes`;
  `appendTimePause`), `invalidateCommentsCache()` is called here after
  writes. Second local `rowToTask` copy lives here — keep in sync.
- `lib/commentsWriteDirect.ts` — `postReplyDirect` (+ edit / delete /
  resolve). This is the LIVE comment-write path (NOT Apps Script).
- `lib/pricingLog.ts` — `readPricingLog`, `logTaskPricing` (fire-and-
  forget append), `updatePricingLogBilled` (the per-entry `billed`
  override). Tab cols **A:I**: created_at_il, task_id, company,
  project, departments, kind, price, created_by, **billed**.

GT two-way sync (must keep working — dual-write in phase 2):
- `lib/pollTasks.ts` (Cloud Scheduler `poll-tasks` job) +
  `lib/userFastSync.ts`. Reads/writes tasks via the seam above.
  `google_tasks` cell = JSON map keyed by assignee email
  `{ "x@…": {u,l,t,d} }`. GT dismissal ≠ completion (banner-confirm
  flow). Due-date sync is one-way (hub canonical).

Admin/report surfaces that read the seam (smoke-test after cutover):
`/admin/billing` (+ `/api/admin/billing/edit`), `/admin/time`,
`/tasks`, `/tasks/[id]`, `/projects/[project]`, `/morning`.

---

## 3. `Comments` tab schema (the data you're moving)

One tab, `row_kind` discriminates `task` vs `comment`. Header row =
field names; `headerIdx` maps name→col. Key shapes:

- **Task row** (`row_kind=task`): id (`T-…`), title, body
  (=description), company, project, brief/campaign, departments
  (JSON array), kind, priority, status, sub_status, approver_email,
  project_manager_email, assignees (JSON array), requested_date,
  created_at, updated_at, parent_id, round_number, revision_of,
  drive_folder_id/url, chat_space_id, chat_task_name,
  calendar_event_ids (JSON obj), google_tasks (JSON obj map),
  status_history (JSON array `{at,by,from,to,note}`),
  description_history (JSON array), edited_at, rank, file_order,
  pending_complete, blocks (JSON array), blocked_by (JSON array),
  umbrella_id, is_umbrella, **price** (col AQ / idx 42),
  **inprogress_minutes** (col AR / idx 43, graceful),
  **time_pauses** (col AS / idx 44, JSON array
  `{at,action:'pause'|'resume',by}`).
- **Comment row** (`row_kind=comment`): task workflow cols empty;
  carries body, mentions, resolved, parent_id (→ task id or parent
  comment for replies), timestamps.
- "Graceful column" pattern: writers only set a column if its header
  exists; `rowToTask` parses with `undefined` fallback. Added via
  `scripts/add-*-column.mjs` clones. Preserve this leniency in the
  Firestore mapping (missing field → undefined/default).

Derived, NOT stored (do not migrate as data): status-time is computed
by `lib/inProgressTime.ts` `deriveInProgressTime(status_history,
status, time_pauses)` → `{minutes, rawMinutes, isRunning, isPaused}`.
`/admin/time` synthesizes its rows from `tasks` at request time.

---

## 4. Firestore data model

- `tasks/{taskId}` — taskId = existing `T-…` id (preserve, links/GT
  refs depend on it). All task fields; JSON columns become real
  array/map fields. Composite indexes (create in phase 0):
  `(project, status)`, `(company, project)`,
  `(assignees array-contains, status)`, `(umbrella_id)`,
  `(parent_id)`, `(blocked_by array-contains)`,
  `(status, requested_date)`.
- `comments/{commentId}` — fields incl. `taskId`, `parentId`,
  `resolved`, `mentions[]`, timestamps. Index `(taskId, createdAt)`,
  `(parentId)`, plus a mentions index for `myMentions`.
- `pricingLog/{autoId}` — append-only ledger. Fields: createdAtIl,
  taskId, company, project, departments, kind, price, createdBy,
  **billed** (override; null = bill `price`). Index `(month, company)`
  (store `month` = `createdAtIl.slice(0,7)`), `(taskId)`.
- NO `timeLog` collection (see §7).

Transactions: replace the `withTaskLock` read-modify-write (e.g.
`status_history` / `time_pauses` append) with a Firestore transaction
or `arrayUnion`/server-side update. This is a correctness *upgrade* —
port the append/ordering logic faithfully and test it.

---

## 5. Phased plan (execute in order)

**Phase 0 — prep.** Enable Firestore Native in GCP `64182441464`.
Server-only access via the existing SA (Application Default / the
`TASKS_SA_KEY_JSON` identity); lock security rules to deny all client
access. Add `@google-cloud/firestore` (admin) to `hub-next`. Define
the collections + composite indexes (§4). Add `USE_FIRESTORE_TASKS`
flag to `lib/sa.ts` (default off), mirroring the existing `useSA*`
flags. tsc, commit, push.

**Phase 1 — backfill.** Add `scripts/backfill-firestore.mjs` (clone
the auth boilerplate from any `scripts/add-*-column.mjs`: it builds a
`google.auth.JWT` from `TASKS_SA_KEY_JSON` subject `maayan@fandf.co.il`).
Read the full `Comments` tab + `PricingLog`; write `tasks`/`comments`/
`pricingLog` docs (id = task/comment id; pricingLog autoId).
Idempotent + re-runnable (upsert by id). Print counts; spot-check a
few docs vs sheet rows.

**Phase 2 — dual-write + parity.** In `tasksWriteDirect`,
`commentsWriteDirect`, `pricingLog`, and the GT path (`pollTasks`):
after the existing Sheets write, also write Firestore (Sheets stays
source of truth). Wrap Firestore writes so a Firestore failure NEVER
breaks the Sheets write (log + continue) until phase 4. Add a
`scripts/parity-check.mjs` that diffs Sheets vs Firestore for tasks/
comments/pricingLog and reports drift. Run it until clean across a
full GT poll cycle.

**Phase 3 — read cutover behind flag.** Implement the Firestore read
path inside `tasksDirect`/`commentsDirect`/`pricingLog` selected by
`USE_FIRESTORE_TASKS`. **Flip it for everyone at once** once
`parity-check` is clean across a full GT poll cycle — the hub is not
yet operational (no production users to soak-protect), so a phased
audience adds complexity for no benefit; the converged single path is
simpler. Sheets stays dual-written → rollback = flip the flag off.
Keep React `cache()` per-request; the 5s TTL hack and `unstable_cache`
>2MB workarounds become unnecessary (Firestore reads are indexed/
cheap) — leave them until phase 5 to avoid churn.

**Phase 4 — Firestore = source of truth.** Stop the Sheets writes for
moved data. Make the Firestore write authoritative (failures now DO
surface). Port `withTaskLock` logic to Firestore transactions. **No
standing Sheets export** — a recurring export job is exactly the
long-haul Sheets coupling/maintenance this migration removes, so do
NOT build one. On-demand spreadsheet needs are already covered by the
existing CSV exports (`/admin/billing`, `/admin/time`); add an
ad-hoc/on-demand export ONLY if a concrete recurring need actually
surfaces later (it must stay zero standing cost — no cron).

**Phase 5 — cleanup.** Delete: `lib/timeLog.ts`, `/api/tasks/time`
route, the TimeLog merge in `app/admin/time/page.tsx` (derive purely
from `tasks`); the Sheets `Comments` reader + 5s TTL cache +
`invalidateCommentsCache` plumbing + the `unstable_cache` >2MB
workarounds for moved data; the now-uncalled `readCommentsOnce`.
Optionally delete the vestigial Apps Script `_hubApiHandle_`
comment/task routes + the retired `pollTaskCompletions` no-op in
`dashboard-clasp/Code.js` — if you touch Apps Script, follow the
manifest-flip / dual-deploy discipline (memory). Update `MEMORY.md`
+ this doc.

Rough total ~3 focused weeks incl. soak. Phases 0–2 don't need the
phase-3/4 decisions.

---

## 6. Legacy Apps Script — NOT a blocker (verified 2026-05-18)

- `pollTaskCompletions()` in `dashboard-clasp/Code.js` is a **retired
  no-op since 2026-04-30** (logs and returns).
- Dashboard comment UI + its cold-load Comments read **removed
  2026-05-12**; `tpl.commentsEnabled=false` makes Index.html branches
  inert. The dashboard render has **zero** tasks/comments dependency.
- Live comment writes go through hub-next `commentsWriteDirect`
  (direct Sheets), not Apps Script `_hubApiHandle_` (vestigial).
⇒ Moving `Comments` does not affect the dashboard. Apps Script
cleanup is optional (phase 5), not a dependency.

---

## 7. Resolved decisions (do not re-litigate)

1. **Go**: proceed with the phased plan.
2. **TimeLog**: DROPPED. The manual per-person time UI was removed
   (commit `6d65576`). `/admin/time` derives status-time from each
   task's `status_history` + `inprogress_minutes`/`time_pauses`
   (which live on the task and migrate with it). Do **not** create a
   `timeLog` collection. Delete `lib/timeLog.ts`, `/api/tasks/time`,
   and the dead TimeLog merge in `/admin/time` (phase 5; can be done
   earlier as standalone cleanup — it's already unused).
3. **Phase-3 audience**: ALL-AT-ONCE. The hub is not yet operational
   — no production users to soak-protect, so flip the flag for
   everyone once parity is clean. No per-user gating.
4. **Human Sheets export**: NO standing/recurring export (it's the
   long-haul coupling we're removing). Existing CSV exports cover
   on-demand needs. Build an ad-hoc export later ONLY if a concrete
   recurring need appears AND it adds zero standing cost (no cron).

---

## 8. First actions for the fresh session

1. Read §1 memory entries + `STORAGE_MIGRATION_PROPOSAL.md`.
2. Confirm env values (`SHEET_ID_COMMENTS`, `TASKS_SA_KEY_JSON`, GCP
   project, Firebase App Hosting auto-deploy) before writing code.
3. Open the seam files in §2 and read them fully — especially the two
   `rowToTask` copies (tasksDirect + tasksWriteDirect) and the JSON
   column parsers, so the Firestore mapping is faithful.
4. Start Phase 0. tsc-gate + push after each phase. Tell the user
   what to verify in their browser (you can't).

---

## 9. Deployment gotchas (learned 2026-05-18, during execution)

- **`apphosting.yaml` rejects an empty-string `value:`.** `value: ""`
  fails the App Hosting *preparer* step with `fah/invalid-apphosting-yaml`
  / raw log `either 'value' or 'secret' field is required` — App
  Hosting treats an empty value as "no value field". Every storage
  rollout `627ee0a`→`c25eb6e` was rejected for this; prod kept serving
  the last good build (no outage). Fix: off-state env vars must be
  `value: "0"` (the flag code already treats anything != "1" as off),
  never `""`. A failed preparer step never reaches `next build`, so
  tsc-clean code can still be sitting undeployed — always confirm the
  rollout actually succeeded, not just that you pushed.
- **`next build` can't be validated locally in this repo** — the
  working copy is under OneDrive on Windows and `next build` dies with
  `EINVAL readlink .next/...`. The Linux App Hosting builder is the
  real build gate. De-risk statically instead: ensure no `"use client"`
  file imports the server-only Firestore modules (they're dynamic-
  `import()`-ed from `lib/*` server code only, mirroring how
  `googleapis` is used).
- **App Router has no grep-able build id in `/signin` HTML** — can't
  detect "new deploy live" that way. Detect via behavior, or have the
  owner confirm the rollout. Authenticated pages can't be driven via
  the preview server (OAuth) but CAN via the Claude-in-Chrome MCP
  against the owner's logged-in browser — that's how Phase 3 was
  verified live.
- **Read flip (Phase 3) surfaced 3 runtime bugs offline parity can't
  catch**, all fixed: (1) `mirrorTaskById` re-read via the flag-gated
  reader → stale; fixed with a Sheets-pinned mirror read. (2) async
  mirror lost read-your-writes once reads were Firestore; fixed by
  awaiting the mirror when `useFirestoreTasks()`. (3) task **detail**
  page did N uncached full-collection reads → 30s+ render; fixed by
  React `cache()` on `readCommentsShapeFromFirestore`. Lesson: verify
  the read flip live in-browser (detail page especially), not just via
  the offline parity script.

---

## 10. Current status & how to RESUME Phase 4 (2026-05-18)

**Live in prod (commit `e9ee8fe`, all verified):** Phases 0–3 DONE.
`USE_FIRESTORE_DUALWRITE=1`, `USE_FIRESTORE_TASKS=1` → reads served
from Firestore, ~5× faster data fetch than Sheets (measured), all
pages verified fast in-browser, `scripts/parity-check.mjs` ALL CLEAN.
Sheets still dual-written ⇒ instant lossless rollback (flip
`USE_FIRESTORE_TASKS` → `0`). `USE_FIRESTORE_WRITES=0` (Phase 4
dormant).

**Phase 4 built so far (DORMANT — flag off, tsc-clean, pushed):**
- `lib/sa.ts` `useFirestoreWrites()` + re-export; `apphosting.yaml`
  documents it (`"0"`).
- `lib/firestore.ts` `getDb()` (admin SDK, SA identity).
- `lib/firestoreRead.ts` `taskDocToShapedRow()` + `commentsShapeHeaders()`.
- `lib/firestoreWrite.ts` — `changesToTaskDocFields()` (exact inverse
  of `taskDocToRow`), `persistTaskUpdateFirestore()` (a Firestore
  **transaction**; history fields `status_history`/`time_pauses`/
  `description_history` re-applied as **deltas** onto the doc's CURRENT
  array — the faithful `withTaskLock`→transaction port),
  `createTaskFirestore()`.
- `lib/tasksDirect.ts` `rowToTaskForMirror()` export.
- `tasksWriteDirect.tasksUpdateDirectInner` — fully flag-branched
  (Firestore-doc source row → unchanged change-computation → txn
  persist; 3 append sites record the delta entry in `fsAppends`).
- `persistGoogleTasksCell` — flag-branched (writes the Firestore doc's
  `google_tasks`; all 5 callers pass the task id).

**STILL TODO before activation (each still Sheets-only; pattern =
copy the `useFirestoreWrites()` branch already shown):**
1. `tasksCreateDirect` — instead of `sheets.values.append(row)`, call
   `createTaskFirestore(taskToDoc(task))` (`taskToDoc` is in
   `lib/firestoreSync.ts`). Side effects (Drive/GT) unchanged.
2. `commentsWriteDirect` ×5 (postReply, createMention, resolve, edit,
   delete) — the existing `mirror*` fns in `lib/firestoreSync.ts`
   already do the exact Firestore comment writes; under the flag make
   them AUTHORITATIVE (await, surface errors) and SKIP the Sheets
   append/update/deleteDimension.
3. `pricingLog` ×2 — `logTaskPricing`→`mirrorPricingEntry`,
   `updatePricingLogBilled`→`mirrorPricingBilled`, authoritative; skip
   Sheets. (Note `logTaskPricing` is fire-and-forget telemetry — keep
   that nature.)
4. `dependencyCascade.ts` / `umbrellaRecompute.ts` — they `batchUpdate`
   Sheets task rows; under the flag write the Firestore doc instead
   (status/status_history/updated_at for cascade; status/updated_at
   for umbrella). Reuse `persistTaskUpdateFirestore` or a targeted
   `tasks/{id}.set(merge)`. Their post-write `mirrorTaskById` reads
   Sheets-pinned (stale under Phase 4) → drop/replace it under the flag.
5. `pollTasks.ts` — top read: under the flag read from Firestore (use
   `readCommentsShapeFromFirestore()`); due-date `values.update` →
   Firestore doc `google_tasks` write. `applyAutoTransition` already
   routes through `tasksUpdateDirect` (branched).

**Activation is ALL-OR-NOTHING + IRREVERSIBLE.** Do NOT set
`USE_FIRESTORE_WRITES=1` until every path above is branched + tsc-clean
+ reviewed; a partial flip splits data across Sheets+Firestore. After
activation: verify writes in-browser (create/status/comment/pricing),
confirm Firestore docs update + Sheets no longer changes, then Phase 5
(delete the dead Sheets-write code + `lib/timeLog`, etc.; needs
explicit owner go-ahead).

**Owner-paused here 2026-05-18** for a focused Phase-4 continuation
(session length / irreversibility risk). System is in an excellent,
safe, fully-reversible state in the meantime.
