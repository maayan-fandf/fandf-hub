# Existing Chat-space membership remediation — DONE (2026-05-18)

> **🛑 SUPERSEDED BY PATH B (final, 2026-05-18): Chat integration
> de-scoped.** After all the membership/threading work below, the
> owner concluded the team works in WhatsApp/email, not Google Chat,
> and the whole Chat integration "isn't worth it." The hub's automated
> cross-stream mirror is now **OFF by default**
> (`CHAT_CROSSPOST_ENABLED=0`, commit `0da5c42`) — `postChatWebhook`
> early-returns. This is intentional; do not re-enable Chat mirroring
> or rebuild Chat-surface features without an explicit owner ask. Hub
> discussion lives in Firestore; Chat was only ever a mirror. Roster
> cron + the quiet/threaded/restricted spaces + the 2 explicit
> user-initiated posts remain (harmless). Authoritative rationale:
> memory `reference_chat_space_membership_model.md` (Path B section).
> Everything below is now history.

> **✅ EXECUTED & COMPLETE 2026-05-18.** This plan was superseded by a
> full **delete + recreate-as-threaded** migration (chosen because the
> hub had no real usage yet, so lost history/URLs didn't matter, and
> existing spaces are physically un-quietable: threading is immutable
> post-create and per-member notification is not admin/API-settable).
>
> What ran: pre-check `scripts/probe-threaded-space.mjs` (confirmed the
> API honors `spaceThreadingState:THREADED_MESSAGES`) → `backup-keys-
> chat-space.mjs` → `clear-keys-chat-space.mjs --apply` (blanked 24
> Keys cells, emitted recreate manifest) → `POST /api/admin/recreate-
> chat-spaces?apply=1` with the manifest (24 fresh threaded+restricted
> spaces, roster invited at create, Keys repointed) → reconcile cron
> (`/api/cron/sync-chat-spaces`, 0 drift, 24/24) → owner bulk-deleted
> the 24 old spaces + the probe space in Admin console. Flags steady:
> `USE_RESTRICTED_CHAT_SPACES=1`, `CHAT_SPACE_SYNC_DRYRUN=0`,
> `USE_THREADED_CHAT_SPACES=1`. **Irreversible now; problem closed.**
>
> **Gotcha for any future bulk run:** `/api/admin/recreate-chat-spaces`
> does N sequential createChatSpaceForProject calls in one request;
> ~24 exceeds the App Hosting request timeout (first apply 500'd with
> a Firebase HTML page after ~20/24). createChatSpaceForProject is
> idempotent (Keys cell set → returns existing), so re-running
> `?apply=1` until `failed:0` is a safe, sufficient recovery. If
> reused at scale, add batching / a `?max=N` cursor instead.
>
> The original plan text below is kept for historical context only.

---

## Original plan (historical — superseded by the migration above)

Status: ~~proposed, awaiting explicit owner go-ahead per step.~~ Nothing
here runs automatically. This mutates shared Google Chat spaces
(user-visible, high blast radius, only semi-reversible) — every write
step needs sign-off.

> **Update 2026-05-18 (later) — reconcile is now LIVE.**
> `USE_RESTRICTED_CHAT_SPACES=1` + `CHAT_SPACE_SYNC_DRYRUN=0` +
> `USE_THREADED_CHAT_SPACES=1`. Owner granted the `chat.memberships`
> scope + created the Cloud Scheduler job (`chatspacessync`, me-west1,
> ~30 min). Dry-run was reviewed (24 spaces, +13 adds / −42 removes —
> the removes were shir/nadav/sapir off non-rostered spaces). An
> admin/owner never-remove allowlist was recommended; **owner
> explicitly chose STRICT roster-only and confirmed in chat** — so
> there is no allowlist and the cron now actively removes non-roster
> members (admins included) every cycle. Halt = `CHAT_SPACE_SYNC_DRYRUN
> =1`. Only Phase A→ (access tightening) below remains relevant.
>
> **Update 2026-05-18 — membership reconcile is now AUTOMATED (dormant).**
> Owner chose: membership = **roster-ONLY** (Keys C/D/J/K, @fandf;
> system admins are NOT blanket-members — only if rostered) and a
> **fully-automatic cron**. Shipped (commit `69fb258`):
> `lib/chatSpaceSync.ts` + `/api/cron/sync-chat-spaces`, gated on
> `USE_RESTRICTED_CHAT_SPACES` (dormant). Once the flag is on (after
> the `chat.memberships` scope is granted) the cron continuously
> adds/removes members on EVERY space — existing spaces included — to
> match Keys, with hard mass-removal rails.
> ⇒ The membership-prune work in Phases B/C below is now done by the
> cron. **The remaining manual remediation is ONLY the access
> tightening**: existing spaces are still org-DISCOVERABLE, so even
> after the cron prunes non-roster members anyone can re-join — the
> `spaces.patch(accessSettings)` step (needs the still-unverified
> patch scope) is what actually closes them. Patch-before-relying-on-
> the-prune still holds. Phase A (read-only audit) is still the safe
> first step.

## Why

"When anyone writes in the internal chatspace the whole office gets
pinged." Root cause (see the chat investigation): `createChatSpaceFor
Project` historically created spaces `spaceType:"SPACE"` with
`accessSettings.accessState:"DISCOVERABLE"` + `audience:"audiences/
default"` → discoverable/joinable by **all of F&F**, and the hub
forwards nearly every interaction in as a new top-level message →
Google Chat push-notifies every member.

`USE_RESTRICTED_CHAT_SPACES` (commit `2335096`, default off) fixes this
**going forward only** — new spaces become restricted + Keys-roster-
invited. It does NOT touch spaces that already exist; those keep
pinging the office until remediated here.

## Scope of the problem set

Existing internal spaces = every Keys row's `Chat Space` cell
(deep-link → resolve via `parseSpaceId`). Plus likely orphan/duplicate
empty spaces (the create flow's idempotency comment notes "many empty
duplicates needing manual cleanup" from repeated button clicks).

## Hard prerequisites (cannot proceed without these)

1. **`chat.memberships` DWD scope** — to list/add/remove members.
   Workspace Admin → Security → API controls → Domain-wide delegation →
   client `102907403320696302169`. (Same scope the new-space flag
   needs.) `chatMembershipsClient` already exists in `lib/sa.ts`.
2. **Scope for `spaces.patch` of `accessSettings`** — to flip an
   existing space from DISCOVERABLE → restricted. EXACT scope must be
   verified (Google Chat API: updating a space's access settings via
   `spaces.patch` requires space-manager rights + an appropriate scope;
   `chat.spaces.create` — the only space-scope wired today — is NOT
   sufficient). Likely `chat.spaces` (or a Chat-admin scope). **Verify
   before planning the patch step**, and wire a matching SA client in
   `lib/sa.ts` (none exists yet).
3. (Only if deleting orphan duplicates) a space-delete scope —
   destructive, treat separately.

Ordering matters: a space that stays DISCOVERABLE lets anyone re-join
even after a member prune. **Access must be tightened (patch) BEFORE
pruning members**, else the prune is undone by re-joins.

## Phased approach

**Phase A — read-only audit (safe, do first).** Script (no writes):
for every Keys-referenced space, fetch current `accessSettings` +
member list; compute the intended set = Keys cols C/D/J/K + admins,
@fandf-only (reuse the `inviteProjectRoster` resolver logic); emit a
per-space diff: access change, members-to-remove, members-to-add,
plus a catalog of orphan/empty/duplicate spaces. Review the full diff
with the owner. No Chat mutation. This is the only step safe to build
+ run before scope decisions (it needs just read scopes, which exist).

**Phase B — pilot (1 low-risk project, explicit go-ahead).** Announce
to the affected roster first. For the pilot space: `spaces.patch`
accessSettings → remove org audience (restricted); reconcile members
to the intended set (add missing roster, remove non-roster — keep
admins + the space creator); export the pre-change member list first
so a re-invite rollback is trivial. Verify in Chat that non-roster
people no longer see it and that pings drop. Soak a few days.

**Phase C — batched rollout.** Repeat B per project in small batches,
re-reviewing each batch's Phase-A diff, with an office-wide heads-up
before starting (people will lose visibility of projects they're not
on — that's the intent, but it should not be a surprise).

**Phase D — orphan/duplicate empty spaces (optional, separate
go-ahead).** Catalog from Phase A. Deletion is destructive and needs
the delete scope; default recommendation is to LEAVE them (harmless if
empty + restricted) unless they're noisy, and only delete with
per-space confirmation.

## Risks & mitigations

- **Lost context / annoyance** when removing active members → announce
  first; per-project; pilot; keep membership export for fast re-add.
- **Re-join leak** if access not tightened first → enforce patch-
  before-prune ordering.
- **Scope missing mid-run** → Phase A surfaces it before any write;
  abort if the patch/membership scopes aren't confirmed.
- **Semi-reversible**: re-inviting a removed member is easy; restoring
  org-discoverability is a patch back. Deletions are NOT reversible →
  Phase D gated hardest.

## Decision points for the owner

1. Grant `chat.memberships` + confirm/grant the `spaces.patch`
   access-settings scope? (gates everything past Phase A)
2. Pilot project choice.
3. Delete orphan duplicates, or leave them? (Phase D)
4. Comms plan / timing for the office heads-up.

## Explicit non-execution

Per the 2026-05-18 request the owner chose "code change + plan the
cleanup". The forward-fix code is shipped dormant (`2335096`). THIS
remediation is documented only. Do not build Phase A or run any phase
without the owner's explicit per-step go-ahead.
