# Phase 2 + convert-Chat-to-task — work log

Started: 2026-04-27 evening

## Goal
Two features in one PR:

1. **Hub-side composer for the internal Chat tab** — textarea + send button on the project page's "🔒 פנימי" tab, posting to the project's Google Chat space via the OAuth path we already use for the cross-stream signal.
2. **"Convert this Chat message → hub task"** — small action on each Chat message row that opens `/tasks/new` with the message text / sender / link prefilled.

## Pre-reqs (user-side, already done)
- ✅ Chat API enabled on GCP project `fandf-dashboard`
- ✅ Chat App configured in GCP (App name + visibility set to whole F&F)
- ✅ DWD scopes: `chat.messages` + `chat.messages.readonly` + `admin.directory.user.readonly`
- ✅ Admin SDK API enabled on the GCP project

## Files added / modified

(filled in as I go)

| File | Change |
|---|---|
| `scripts/PHASE_2_WORKLOG.md` | new — this file |
| `app/tasks/new/page.tsx` | added `?body` + `?title` prefill params |
| `app/api/chat/post/route.ts` | new — JSON POST endpoint, NextAuth, calls postMessage + revalidateTag |
| `components/InternalChatComposer.tsx` | new — textarea + send button, optimistic-clear |
| `components/ConvertChatMessageToTaskButton.tsx` | new — server component, deeplinks to /tasks/new with prefill |
| `components/InternalDiscussionTab.tsx` | added projectName prop, mounted composer + convert buttons |
| `app/globals.css` | composer + chat-message-actions + chat-message-action styling |

## Status: COMPLETE — pushed in commit (see HEAD)
Production `next build` passed clean. No compile errors.

## Polish round (same evening)

After phase 2 shipped, three follow-ups bundled into one PR:

1. **Strip "פתח בהאב →" lines from Chat messages displayed in the hub**
   — that's our cross-stream-signal back-pointer; useful for Chat-only
   viewers, redundant noise inside the hub.
2. **Inline image rendering for Chat-uploaded attachments** — users
   can now see screenshots / images posted in the Chat space without
   leaving the hub. Non-image attachments render as 📎 chips.
3. **Bounded message feed height** — `.chat-message-list` now caps at
   60vh with `overflow-y: auto` so a chatty project doesn't push the
   composer + the rest of the page off-screen.

Files touched:
- `lib/chat.ts` — added `ChatAttachment` type, captured `m.attachment[]`
  data in the mapping
- `components/InternalDiscussionTab.tsx` — render attachments below
  text (image thumbnails or 📎 link), strip "פתח בהאב" line in the
  text renderer
- `app/globals.css` — `.chat-message-image{,-link}`, `.chat-message-
  attachment-link`, scrollbar styling on `.chat-message-list`

## Recovery instructions if something blows up mid-PR

If the conversation drops before commit + push:
1. `git status` in `hub-next/` — see what's modified
2. Build locally: `rm -rf .next && npx next build`
3. If build is clean, commit with the message under "Commit message draft" below
4. If build fails, the error indicates the missing piece — the tasks list in `Phase 2 plan` (below) shows what each file should do

## Phase 2 plan

### Composer
- New API route: `app/api/chat/post/route.ts`
  - Body: `{ project: string, text: string }`
  - Auth: NextAuth session
  - Resolves space ID from Keys col L (same lookup InternalDiscussionTab uses)
  - Calls `lib/chat.ts:postMessage(session.email, spaceId, text)`
  - On success calls `revalidateTag('chat-messages')` so the next read of the internal tab picks up the new message immediately
- New client component: `components/InternalChatComposer.tsx`
  - Textarea + send button
  - Optimistic close like ReplyDrawer (clear textarea + `router.refresh()` immediately)
  - Errors restore the typed text + show inline error
- Wire into `components/InternalDiscussionTab.tsx` at the bottom of the message list

### Convert to task
- New client component: `components/ConvertChatMessageToTaskButton.tsx`
  - Renders a small button on each Chat message row
  - Click → `router.push('/tasks/new?project=...&brief=...&body=...&source=<chat deep link>')`
  - The /tasks/new page already supports prefill via search params (verified before building)
- Add to `InternalDiscussionTab` — one button per message row

### CSS
- Composer styling — match the existing `.reply-drawer` look
- Convert button — small, end-of-row, accent on hover

## Commit message draft

```
Phase 2: hub-side composer for internal Chat tab + convert-to-task

Composer (compose Chat messages from the hub):
- New /api/chat/post route — JSON body {project, text}, auth via NextAuth,
  posts via OAuth-impersonated user, revalidates chat-messages tag on
  success so the next page render shows the new message.
- New InternalChatComposer client component — textarea + send button,
  optimistic close pattern (clear + refresh on send, restore + show
  error on failure).
- Mounted at the bottom of the internal-tab message list; replaces
  the prior "compose in Chat only" model.

Convert Chat message → hub task:
- New ConvertChatMessageToTaskButton — small icon-only button on each
  Chat message row that links to /tasks/new with brief/body/source
  prefilled from the message.
- The hub task carries the original message text in its body and a
  source link back to the Chat thread for traceability.

The two features land together since both touch InternalDiscussionTab
and share the same row layout.
```
