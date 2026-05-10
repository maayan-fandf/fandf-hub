/**
 * Google Chat helpers — discovery (space-id from webhook URL), reads
 * (recent messages for the internal-discussion tab), and writes
 * (cross-stream signal posted into the internal space when a client
 * posts in the hub).
 *
 * Auth flows through `chatClient(subjectEmail)` in lib/sa.ts. See that
 * file for the one-time GCP / Workspace-admin steps to enable the
 * scopes — without them all calls return `unauthorized_client`.
 *
 * Webhook-discovery rationale: each project's Chat Webhook URL is
 * already on the Keys sheet (col L). We don't need that webhook for
 * writing anymore once OAuth is wired, but parsing the URL is the
 * cheapest way to learn the space ID — there's no other lookup table.
 * The actual space-id format is opaque to humans (random 11-char IDs);
 * deriving from the webhook URL avoids forcing admins to hand-edit a
 * second column.
 */

import { chatClient, directoryClient } from "@/lib/sa";

export type ChatMessage = {
  /** API resource name: `spaces/<spaceId>/messages/<messageId>`.
   *  Used for stable React keys + future patch / delete. */
  name: string;
  /** Thread resource name (`spaces/<sid>/threads/<tid>`). All messages
   *  on the same thread share this — used by the hub to group a
   *  thread parent with its inline replies. Each top-level message
   *  starts its own thread; subsequent messages on that thread are
   *  rendered indented underneath. */
  threadName: string;
  text: string;
  /** ISO-8601 timestamp the message was sent. */
  createTime: string;
  /** Sender display name — populated by Chat API when present, then
   *  enriched via Admin SDK Directory lookup (lookupUserName) when
   *  the API leaves it empty (which it routinely does for SA-
   *  impersonated cross-stream-signal posts and sometimes for
   *  human-posted messages too). Empty string when both fail. */
  senderName: string;
  /** Sender resource name from the Chat API — `users/<gaiaId>` for
   *  human users, `users/app` or similar for app-authored messages.
   *  Retained on the type so the avatar in InternalDiscussionTab
   *  can hash off a stable identifier even when senderName is
   *  empty, and so we can re-run the directory lookup later. */
  senderResource: string;
  /** Annotation summary — list of mentioned user emails (lowercased)
   *  found in `annotations[].userMention`. Empty when no mentions.
   *  Used by the תיוגים filter on the internal tab. */
  mentionEmails: string[];
  /** Files attached to the Chat message (uploaded via the Chat
   *  composer's paperclip). Currently used to surface images inline
   *  in the hub's internal tab so users don't have to flip to Chat
   *  just to see a screenshot. Non-image attachments render as a
   *  generic 📎 link. */
  attachments: ChatAttachment[];
  /** Aggregated emoji reactions on this message. Phase-1: display
   *  only (chip with emoji + count). Adding/removing reactions
   *  in-hub is a phase-3 follow-up — for now click-through to Chat
   *  to react. */
  reactions: ChatReaction[];
};

export type ChatReaction = {
  /** Unicode codepoint for standard emoji. Custom Workspace emojis
   *  fall back to a generic ❓ since their image URLs need a separate
   *  lookup we don't currently do. */
  emoji: string;
  count: number;
};

export type ChatAttachment = {
  /** Filename as Chat reports it ("Screenshot 2026-04-27.png"). */
  contentName: string;
  /** MIME type — used to decide image vs link rendering. */
  contentType: string;
  /** Preview-quality URL Chat exposes for display purposes. Loads
   *  in a browser signed into the same Workspace account; falls back
   *  to the lh3 thumbnail when blank. */
  thumbnailUri: string;
  /** Drive file ID when the attachment is Drive-backed. We use it
   *  to construct an lh3 thumbnail URL when thumbnailUri is empty. */
  driveFileId: string;
  /** Convenience flag — true when contentType starts with "image/". */
  isImage: boolean;
};

/**
 * Pulls a Chat space ID out of any of the URL forms a user might
 * paste into Keys col L:
 *   - Webhook URL: `https://chat.googleapis.com/v1/spaces/<ID>/messages?...`
 *     (from Apps & integrations → Manage webhooks)
 *   - Standalone Chat URL: `https://chat.google.com/room/<ID>?cls=N`
 *     (what "Copy link" gives you on the standalone chat.google.com
 *     web app — historical "room" terminology, same ID space as
 *     "spaces")
 *   - Mail-embedded deeplink: `https://mail.google.com/chat/u/N/#chat/space/<ID>`
 *     (what "Copy link" gives you when Chat is embedded in Gmail —
 *     same as `chatSpaceUrlFromWebhook` returns)
 *   - Bare resource name: `spaces/<ID>` or `<ID>` (admin who wants
 *     to skip URL parsing entirely)
 * Returns "" for anything else.
 */
export function parseSpaceId(url: string): string {
  if (!url) return "";
  // Webhook URL.
  const w = url.match(
    /^https:\/\/chat\.googleapis\.com\/v1\/spaces\/([^/]+)\/messages/,
  );
  if (w) return w[1];
  // Standalone chat.google.com URL — historical "/room/" prefix is
  // still what Google emits today, even though the API uses "spaces".
  const r = url.match(
    /^https:\/\/chat\.google\.com\/(?:room|space)\/([A-Za-z0-9_-]+)/,
  );
  if (r) return r[1];
  // Mail-embedded deeplink — both `/chat/space/<id>` (path) and
  // `#chat/space/<id>` (fragment) shapes. The `[/#]?` prefix lets
  // us match either separator without requiring a slash before
  // `chat` (which the fragment form lacks).
  const d = url.match(/[/#]chat\/(?:space|room)\/([A-Za-z0-9_-]+)/);
  if (d) return d[1];
  // Bare resource name pasted directly.
  const bare = url.trim().match(/^(?:spaces\/)?([A-Za-z0-9_-]{8,})$/);
  return bare?.[1] ?? "";
}

/** Back-compat alias — older callers parse webhook URLs specifically. */
export function parseSpaceIdFromWebhook(webhookUrl: string): string {
  return parseSpaceId(webhookUrl);
}

/**
 * Build a deeplink the user can click to open the space in Chat. Same
 * pattern the existing dashboard uses (chatSpaceUrlFromWebhook). Kept
 * here so callers don't need to import from two modules.
 */
export function chatSpaceUrlFromSpaceId(spaceId: string): string {
  if (!spaceId) return "";
  return `https://mail.google.com/chat/u/0/#chat/space/${spaceId}`;
}

/**
 * List recent messages in a space, newest-first. Cached for 60s
 * cross-request — the project page's internal tab renders this on
 * every load, and a 60s ceiling keeps the polling footprint sane
 * while still feeling near-realtime to humans (a typed message will
 * land within a minute of sending it from Chat).
 *
 * Falls back to `[]` on any failure (missing scope, space gone, user
 * isn't a member, API down). The caller renders a friendly empty
 * state instead of an error — this is a "nice to have" surface, not
 * a critical path.
 */
/**
 * In-process cache: Chat user resource (`users/<id>`) → directory
 * displayName. Successful lookups cached for 1h; failures negative-
 * cached for 1m so a transient outage doesn't block subsequent reads
 * for an hour.
 *
 * Lifetime: per Node process (Firebase App Hosting runtimes restart
 * periodically; the cache rebuilds on first hit each new instance).
 * No cross-process invalidation needed — names rarely change and a
 * staleness window of 1h is fine for chat-author display.
 */
const CHAT_USER_NAME_CACHE = new Map<
  string,
  { name: string; expiresAt: number }
>();
const CHAT_USER_NAME_TTL_MS = 60 * 60 * 1000;
const CHAT_USER_NAME_NEGATIVE_TTL_MS = 60 * 1000;

/**
 * Inverse of lookupUserName: given an email, return the user's Chat
 * resource name (`users/<gaiaId>`). Used to check whether the
 * current viewing user authored a given message — drives whether
 * we render an edit/delete affordance on a message row.
 *
 * Cached identically to lookupUserName: 1h on hits, 1m negative on
 * failures. Email is lowercased for cache-key stability.
 */
const CHAT_USER_GAIA_CACHE = new Map<
  string,
  { resource: string; expiresAt: number }
>();

export async function lookupUserGaiaResource(
  subjectEmail: string,
  email: string,
): Promise<string> {
  const key = email.toLowerCase().trim();
  if (!key) return "";
  const cached = CHAT_USER_GAIA_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.resource;
  try {
    const directory = directoryClient(subjectEmail);
    const res = await directory.users.get({ userKey: email });
    const id = res.data.id ?? "";
    const resource = id ? `users/${id}` : "";
    CHAT_USER_GAIA_CACHE.set(key, {
      resource,
      expiresAt: Date.now() + CHAT_USER_NAME_TTL_MS,
    });
    return resource;
  } catch (e) {
    console.log("[chat] lookupUserGaiaResource failed for", email, ":", e instanceof Error ? e.message : e);
    CHAT_USER_GAIA_CACHE.set(key, {
      resource: "",
      expiresAt: Date.now() + CHAT_USER_NAME_NEGATIVE_TTL_MS,
    });
    return "";
  }
}

/** Reverse of lookupUserGaiaResource: given a Chat user resource name
 *  (`users/<gaiaId>`), return the user's primary email. Used by the
 *  thread-reply notification fan-out — Chat USER_MENTION annotations
 *  carry the user as a gaia ID, but our notifyOnce() needs an email.
 *  Cached identically to lookupUserGaiaResource. */
const CHAT_GAIA_TO_EMAIL_CACHE = new Map<
  string,
  { email: string; expiresAt: number }
>();
export async function lookupEmailByGaiaResource(
  subjectEmail: string,
  resourceName: string,
): Promise<string> {
  const key = (resourceName || "").trim();
  if (!key.startsWith("users/")) return "";
  const cached = CHAT_GAIA_TO_EMAIL_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.email;
  try {
    const directory = directoryClient(subjectEmail);
    const id = key.slice("users/".length);
    const res = await directory.users.get({ userKey: id });
    const email = (
      res.data.primaryEmail ||
      res.data.emails?.[0]?.address ||
      ""
    ).toLowerCase().trim();
    CHAT_GAIA_TO_EMAIL_CACHE.set(key, {
      email,
      expiresAt: Date.now() + CHAT_USER_NAME_TTL_MS,
    });
    return email;
  } catch (e) {
    console.log(
      "[chat] lookupEmailByGaiaResource failed for",
      resourceName,
      ":",
      e instanceof Error ? e.message : e,
    );
    CHAT_GAIA_TO_EMAIL_CACHE.set(key, {
      email: "",
      expiresAt: Date.now() + CHAT_USER_NAME_NEGATIVE_TTL_MS,
    });
    return "";
  }
}

/** List the unique set of emails @-mentioned across all messages in a
 *  Chat thread. Used by the reply-notification fan-out: when someone
 *  replies in a thread, anyone who was tagged anywhere in the thread
 *  earlier gets a chat_mention notification — the replier may not
 *  re-tag them but they're conversationally invested.
 *
 *  Returns a Set<lower-cased-email>. Best-effort: any failure returns
 *  an empty set so the post itself isn't gated on the fan-out logic. */
export async function listThreadMentionedEmails(
  subjectEmail: string,
  spaceId: string,
  threadName: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!spaceId || !threadName) return out;
  let gaiaResources: Set<string>;
  try {
    const chat = chatClient(subjectEmail);
    const res = await chat.spaces.messages.list({
      parent: `spaces/${spaceId}`,
      // Chat list filter — `thread.name = "<resource>"` is the
      // documented thread filter. pageSize cap so a runaway long
      // thread doesn't blow Directory quota in one shot.
      filter: `thread.name = "${threadName}"`,
      pageSize: 100,
    });
    gaiaResources = new Set();
    for (const m of res.data.messages ?? []) {
      const annots = (m.annotations ?? []) as Array<{
        type?: string;
        userMention?: { user?: { name?: string } };
      }>;
      for (const a of annots) {
        const ref = a.userMention?.user?.name;
        if (ref && ref.startsWith("users/")) gaiaResources.add(ref);
      }
    }
  } catch (e) {
    console.log("[chat] listThreadMentionedEmails (list) failed:", e);
    return out;
  }
  // Resolve each gaia resource → email in parallel. Misses (lookup
  // failed for some user) silently skip; we'd rather not notify than
  // notify the wrong account.
  await Promise.all(
    Array.from(gaiaResources).map(async (ref) => {
      const email = await lookupEmailByGaiaResource(subjectEmail, ref);
      if (email) out.add(email);
    }),
  );
  return out;
}

/**
 * PATCH a message's text via the Chat REST API. Only the user who
 * authored the message can edit it — we enforce this by impersonating
 * the session user; if they're not the author the API returns 403
 * and we surface that to the caller.
 *
 * Used by the edit drawer in InternalDiscussionTab. Returns true on
 * success, throws on failure (caller surfaces the error in the UI).
 */
export async function updateMessageText(
  subjectEmail: string,
  messageName: string,
  newText: string,
): Promise<void> {
  const chat = chatClient(subjectEmail);
  await chat.spaces.messages.patch({
    name: messageName,
    updateMask: "text",
    requestBody: { text: newText },
  });
}

/**
 * DELETE a Chat message. Same author-only constraint as edit — the
 * impersonated user must be the message's author or the API will
 * 403. Caller surfaces any error in the UI.
 */
export async function deleteMessage(
  subjectEmail: string,
  messageName: string,
): Promise<void> {
  const chat = chatClient(subjectEmail);
  await chat.spaces.messages.delete({ name: messageName });
}

/**
 * Add an emoji reaction to a Chat message. Idempotent on the Chat
 * side — if the user has already reacted with this emoji, Chat just
 * returns the existing reaction without creating a duplicate.
 */
export async function addReaction(
  subjectEmail: string,
  messageName: string,
  unicode: string,
): Promise<void> {
  const chat = chatClient(subjectEmail);
  await chat.spaces.messages.reactions.create({
    parent: messageName,
    requestBody: { emoji: { unicode } },
  });
}

/**
 * Remove the impersonated user's reaction with `unicode` from the
 * given message. The Chat API requires the reaction's full resource
 * name (`spaces/.../messages/.../reactions/<id>`) — we look it up
 * via a filtered list call first. Returns silently if the user
 * doesn't have a reaction with that emoji on the message
 * (idempotent — no-op when there's nothing to remove).
 */
export async function removeReaction(
  subjectEmail: string,
  messageName: string,
  unicode: string,
): Promise<void> {
  const chat = chatClient(subjectEmail);
  // Resolve the impersonated user's resource so we can filter the
  // reactions list to "mine with this emoji". DWD impersonates the
  // session user, so this is the same identity that owns any
  // reaction this user added.
  const userResource = await lookupUserGaiaResource(subjectEmail, subjectEmail);
  if (!userResource) return;
  const list = await chat.spaces.messages.reactions.list({
    parent: messageName,
    filter: `emoji.unicode = "${unicode}" AND user.name = "${userResource}"`,
    pageSize: 1,
  });
  const reactionName = list.data.reactions?.[0]?.name;
  if (!reactionName) return;
  await chat.spaces.messages.reactions.delete({ name: reactionName });
}

async function lookupUserName(
  subjectEmail: string,
  userResource: string,
): Promise<string> {
  if (!userResource.startsWith("users/")) return "";
  const id = userResource.slice("users/".length);
  // Skip non-numeric IDs ("users/app", "users/AI agents", etc.) —
  // the Directory API only knows real human users.
  if (!/^\d+$/.test(id)) return "";
  const cached = CHAT_USER_NAME_CACHE.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  try {
    const directory = directoryClient(subjectEmail);
    const res = await directory.users.get({ userKey: id });
    const name =
      res.data.name?.fullName ??
      res.data.primaryEmail?.split("@")[0] ??
      "";
    CHAT_USER_NAME_CACHE.set(id, {
      name,
      expiresAt: Date.now() + CHAT_USER_NAME_TTL_MS,
    });
    return name;
  } catch (e) {
    console.log("[chat] lookupUserName failed for", userResource, ":", e instanceof Error ? e.message : e);
    CHAT_USER_NAME_CACHE.set(id, {
      name: "",
      expiresAt: Date.now() + CHAT_USER_NAME_NEGATIVE_TTL_MS,
    });
    return "";
  }
}

async function listRecentMessagesUncached(
  subjectEmail: string,
  spaceId: string,
  limit: number,
): Promise<ChatMessage[]> {
  if (!spaceId) return [];
  let messages: ChatMessage[] = [];
  try {
    const chat = chatClient(subjectEmail);
    const res = await chat.spaces.messages.list({
      parent: `spaces/${spaceId}`,
      pageSize: limit,
      // Newest first. The Chat API doesn't sort by default; orderBy is
      // the canonical knob.
      orderBy: "createTime desc",
    });
    const raw = res.data.messages ?? [];
    messages = raw.map((m) => {
      const annotations = (m.annotations ?? []) as Array<{
        type?: string;
        userMention?: { user?: { name?: string; displayName?: string; type?: string } };
      }>;
      const mentionEmails: string[] = [];
      for (const a of annotations) {
        // userMention.user.name is `users/<id>` — not an email. The Chat
        // API doesn't surface emails in mention annotations directly, so
        // for the filter we depend on the space directory lookup the
        // user has when they opened the space in Chat. We capture
        // displayName as a best-effort signal; full email-based filter
        // is a phase-2 enhancement.
        const dn = a.userMention?.user?.displayName;
        if (dn) mentionEmails.push(dn.toLowerCase());
      }
      const attachments: ChatAttachment[] = (m.attachment ?? []).map((a) => {
        const contentType = a.contentType ?? "";
        return {
          contentName: a.contentName ?? "",
          contentType,
          thumbnailUri: a.thumbnailUri ?? "",
          driveFileId: a.driveDataRef?.driveFileId ?? "",
          isImage: contentType.startsWith("image/"),
        };
      });
      const reactions: ChatReaction[] = (
        m.emojiReactionSummaries ?? []
      ).map((s) => ({
        emoji: s.emoji?.unicode ?? "❓",
        // googleapis types reactionCount as number | null in some
        // versions and string in others — Number() handles both.
        count: Number(s.reactionCount) || 0,
      }));
      return {
        name: m.name ?? "",
        threadName: m.thread?.name ?? "",
        text: m.text ?? "",
        createTime: m.createTime ?? "",
        senderName: m.sender?.displayName ?? "",
        senderResource: m.sender?.name ?? "",
        mentionEmails,
        attachments,
        reactions,
      };
    });
  } catch (e) {
    // Don't surface — log and return empty. Reasons this might fail
    // include: scope not granted yet, user not a space member, space
    // deleted, Chat API not enabled.
    console.log("[chat] listRecentMessages failed:", e);
    return [];
  }

  // Enrich missing displayNames via Admin SDK Directory. We dedupe
  // unique resource names first so 5 messages from the same author
  // become 1 lookup, and run the lookups in parallel — each cached
  // hit is O(1), each miss is one Directory call. If the scope isn't
  // granted yet the lookups all fail silently and we keep "" — same
  // UX as before, no regression.
  const needLookup = Array.from(
    new Set(
      messages
        .filter((m) => !m.senderName && m.senderResource)
        .map((m) => m.senderResource),
    ),
  );
  if (needLookup.length > 0) {
    const resolved: Record<string, string> = {};
    await Promise.all(
      needLookup.map(async (resource) => {
        resolved[resource] = await lookupUserName(subjectEmail, resource);
      }),
    );
    messages = messages.map((m) =>
      m.senderName || !resolved[m.senderResource]
        ? m
        : { ...m, senderName: resolved[m.senderResource] },
    );
  }

  return messages;
}

/**
 * No outer unstable_cache here — same multi-instance staleness trap
 * that bit getMyProjectsDirect (see appsScript.ts comment near
 * `direct-SA path is uncached at this layer`). Firebase App Hosting
 * runs multiple instances and each has its own data cache; if one
 * instance caches `[]` (a transient Chat API blip catches at the
 * try/catch above), it serves empty for 60s even after the underlying
 * call would succeed. The Chat API itself is ~300-800ms per call but
 * project page renders aren't a hot loop, and quota (60 reads/100s
 * per user) is comfortably above any observed traffic shape.
 *
 * Per-request dedup happens naturally — the project page calls
 * listRecentMessages exactly once per render.
 */
export async function listRecentMessages(
  subjectEmail: string,
  spaceId: string,
  limit = 20,
): Promise<ChatMessage[]> {
  return listRecentMessagesUncached(subjectEmail, spaceId, Math.min(limit, 50));
}

/**
 * Post a plain-text message into a Chat space. Used by the cross-
 * stream signal — when a client posts a comment in the hub, we drop
 * a notice card into the internal space so the team sees it in their
 * primary surface.
 *
 * Returns the created message's name (`spaces/.../messages/...`) on
 * success, or "" if posting failed. The caller logs and moves on; a
 * dropped notice isn't fatal.
 *
 * `text` supports Chat's basic markup — bold (*x*), italic (_x_),
 * monospace (`x`), and bare https URLs render as auto-links. We keep
 * the body short (~150 chars excerpt + a hub deeplink) so the card
 * stays scannable in the Chat feed.
 */
/**
 * Programmatic USER_MENTION annotations make Chat treat `@<name>`
 * tokens as real mentions (notification, blue-link rendering, etc.)
 * even when the message comes from the API rather than a native
 * Chat composer. Each annotation pins a user resource to a
 * `[startIndex, startIndex+length]` slice of the text body.
 *
 * Built server-side in /api/chat/post — caller passes the literal
 * `{email, name}` pairs picked from the composer's @-mention picker.
 */
export type ChatMentionInput = {
  email: string;
  name: string;
};

/** Reference to an already-uploaded Chat attachment. Google's API
 *  evolved through two response shapes:
 *
 *    - Older: media.upload returned `attachmentDataRef.resourceName`
 *      and messages.create accepted the same shape on
 *      `attachment[].attachmentDataRef.resourceName`.
 *    - Current: media.upload returns
 *      `attachmentDataRef.attachmentUploadToken` instead, and
 *      messages.create takes the same field name on the create call.
 *
 *  Both fields are documented in Schema$AttachmentDataRef. We support
 *  either — whichever Google fills in on the upload response is the
 *  one we send back on the post. Reported by maayan 2026-05-10:
 *  uploads were failing with "no attachmentDataRef" because the
 *  response only contained attachmentUploadToken, but the parser
 *  only looked for resourceName. */
export type ChatAttachmentRef = {
  resourceName?: string;
  attachmentUploadToken?: string;
};

/**
 * Upload an attachment (image / file bytes) to a Chat space's
 * media area, returning the `resourceName` to plug into a subsequent
 * messages.create call. The two-step flow (upload then attach in
 * post) mirrors the native Chat composer's behavior and lets the
 * hub composer show local previews of attached files before the
 * user clicks send.
 *
 * The bytes get stored under Chat's space-managed area, separate
 * from our hub-managed `<project>/שיתוף עם הלקוח/` folder. Chat's
 * security model: only space members can see the attachment.
 */
export async function uploadChatAttachment(
  subjectEmail: string,
  spaceId: string,
  fileName: string,
  mimeType: string,
  bytes: Buffer,
): Promise<ChatAttachmentRef> {
  // Bypass googleapis' media.upload helper entirely — caught between
  // two of its bugs:
  //   1. `body: Buffer` → "b.body.pipe is not a function" (current
  //      versions call body.pipe() unconditionally; Buffer doesn't
  //      have .pipe())
  //   2. `body: Readable.from(bytes)` → upload succeeds but
  //      `res.data.attachmentDataRef` is missing
  //
  // Both reported by maayan 2026-05-10 (consecutive screenshots).
  // Doing the multipart/related POST manually with fetch sidesteps
  // both — same wire format the SDK builds, just without the
  // multipart construction code path that's broken for our shape.
  //
  // We still go through chatClient() to get a DWD-impersonated
  // access token, so identity + scopes match what the SDK would
  // have used.
  const chat = chatClient(subjectEmail);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const auth2 = (chat.context as any)._options?.auth as
    | { getAccessToken: () => Promise<{ token?: string | null }> }
    | undefined;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const tokenResp = await auth2?.getAccessToken?.();
  const token = tokenResp?.token || "";
  if (!token) {
    throw new Error("Chat upload: missing impersonation token");
  }

  // Build the multipart/related body. Boundary just has to be a
  // string that doesn't appear in either part — random hex is safe.
  const boundary =
    "----hub-fandf-chat-upload-" +
    Math.random().toString(16).slice(2);
  const metadata = JSON.stringify({ filename: fileName });
  const enc = new TextEncoder();
  // Explicit Content-Transfer-Encoding: binary on the binary part —
  // some Google upload endpoints have rejected multipart payloads
  // without it (treating the bytes as text and choking on null bytes).
  // Cheap to include; matches what the official SDK emits internally.
  const partA = enc.encode(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${mimeType}\r\n` +
      `Content-Transfer-Encoding: binary\r\n\r\n`,
  );
  const partB = enc.encode(`\r\n--${boundary}--\r\n`);
  // Concatenate as a single Buffer — fetch handles Buffer bodies
  // natively (no .pipe() shenanigans).
  const body = Buffer.concat([partA, bytes, partB]);

  // The action verb `:upload` at the end is REQUIRED — without it
  // the URL routes to a different gateway path that returns 503
  // Service Unavailable instead of cleanly 404'ing. Confirmed by
  // reading node_modules/googleapis/build/src/apis/chat/v1.js where
  // the SDK builds the same URL: rootUrl + '/upload/v1/{+parent}/
  // attachments:upload'. Reported by maayan 2026-05-10 — every 503
  // log entry today was from this missing suffix.
  const url =
    `https://chat.googleapis.com/upload/v1/spaces/${encodeURIComponent(
      spaceId,
    )}/attachments:upload?uploadType=multipart`;

  // Retry transient failures (5xx + 429 + 408) with exponential
  // backoff. Google's APIs intermittently 503 under load and
  // recommend retry-with-backoff for those. Three attempts total
  // (initial + 2 retries) with 250ms, 750ms waits — total wall
  // time tops out at ~3s on full-failure, fast on first-attempt
  // success. Reported by maayan 2026-05-10: chat upload returned
  // 503 Service Unavailable on first try.
  const MAX_ATTEMPTS = 3;
  const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
  let r: Response | null = null;
  let lastErrBody = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    r = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/related; boundary=${boundary}`,
        // Don't set content-length manually — Node's fetch
        // (undici) computes it from the body bytes itself, and a
        // mismatch between our value and the actual transfer
        // encoding can make the upstream gateway return 503 instead
        // of a cleaner 400. Suspected contributor to maayan's
        // 'all logs are 503 from today' report; eliminating the
        // header rules it out.
      },
      body,
      cache: "no-store",
    });
    if (r.ok) break;
    lastErrBody = await r.text().catch(() => "");
    if (!RETRY_STATUS.has(r.status) || attempt === MAX_ATTEMPTS) break;
    const wait = 250 * Math.pow(3, attempt - 1); // 250, 750
    console.warn(
      `[uploadChatAttachment] ${r.status} on attempt ${attempt}/${MAX_ATTEMPTS} — retrying in ${wait}ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  if (!r || !r.ok) {
    const status = r?.status ?? 0;
    console.error("[uploadChatAttachment] upload failed", {
      spaceId,
      fileName,
      mimeType,
      bytes: bytes.length,
      status,
      response: lastErrBody.slice(0, 400),
    });
    throw new Error(
      `Chat upload failed (${status}): ${
        lastErrBody.slice(0, 200) || r?.statusText || "unknown"
      }`,
    );
  }

  // Read response as text first so we can dump it on errors AND
  // safely fall back when the body isn't JSON.
  const responseText = await r.text().catch(() => "");
  let data: {
    attachmentDataRef?: {
      resourceName?: string;
      attachmentUploadToken?: string;
    };
  } = {};
  try {
    data = JSON.parse(responseText);
  } catch {
    // Not JSON — leave data as {}; the empty-attachmentDataRef
    // branch below surfaces the raw text in the thrown error so
    // we can see what Google actually returned.
  }
  // Accept EITHER ref form. Modern Chat uploads return
  // attachmentUploadToken (opaque temp ref consumed when posting
  // the message); older paths returned a stable resourceName.
  // Whichever field Google populated is what we send back.
  const adr = data.attachmentDataRef || {};
  const resourceName = adr.resourceName || "";
  const attachmentUploadToken = adr.attachmentUploadToken || "";
  if (!resourceName && !attachmentUploadToken) {
    console.error("[uploadChatAttachment] no attachmentDataRef in response", {
      spaceId,
      fileName,
      mimeType,
      bytes: bytes.length,
      responseStatus: r.status,
      responseDataKeys: Object.keys(data),
      responseTextSample: responseText.slice(0, 400),
    });
    const sample = responseText.slice(0, 200) || "<empty body>";
    throw new Error(
      `Chat upload returned no attachmentDataRef (status=${r.status}, body: ${sample})`,
    );
  }
  return { resourceName, attachmentUploadToken };
}

export async function postMessage(
  subjectEmail: string,
  spaceId: string,
  text: string,
  options: {
    threadName?: string;
    mentions?: ChatMentionInput[];
    attachments?: ChatAttachmentRef[];
  } = {},
): Promise<string> {
  // Allow empty text when there are attachments — sometimes a user
  // just wants to drop an image with no caption. Chat supports that.
  const hasAttachments =
    !!options.attachments && options.attachments.length > 0;
  if (!spaceId || (!text && !hasAttachments)) return "";
  try {
    const chat = chatClient(subjectEmail);
    // When threadName is set, post as a reply to that thread. The
    // FALLBACK option means if the thread is gone or otherwise
    // un-replyable, Chat creates a new thread instead — graceful
    // degradation, no exception thrown for the caller to handle.
    const requestBody: {
      text: string;
      thread?: { name: string };
      annotations?: object[];
      attachment?: object[];
    } = { text };
    if (options.threadName) {
      requestBody.thread = { name: options.threadName };
    }
    if (hasAttachments) {
      requestBody.attachment = options.attachments!.map((a) => ({
        // Send whichever ref form the upload returned. Modern
        // uploads populate attachmentUploadToken; older ones used
        // resourceName. Posting with the wrong field for the wrong
        // type would either silently drop the attachment or 400 —
        // attaching only the populated key is the only correct
        // behavior for a polymorphic ref.
        attachmentDataRef: a.attachmentUploadToken
          ? { attachmentUploadToken: a.attachmentUploadToken }
          : { resourceName: a.resourceName },
      }));
    }
    if (options.mentions && options.mentions.length > 0) {
      const annotations: object[] = [];
      for (const { email, name } of options.mentions) {
        const userResource = await lookupUserGaiaResource(subjectEmail, email);
        if (!userResource) continue;
        const token = "@" + name;
        // Find every occurrence of the token in text; one annotation
        // per occurrence so multi-mentions in one message all notify.
        // UTF-16 code-unit indices match what Chat's API expects.
        let idx = text.indexOf(token);
        while (idx !== -1) {
          annotations.push({
            type: "USER_MENTION",
            startIndex: idx,
            length: token.length,
            userMention: {
              user: { name: userResource, type: "HUMAN" },
              type: "MENTION",
            },
          });
          idx = text.indexOf(token, idx + token.length);
        }
      }
      if (annotations.length > 0) {
        requestBody.annotations = annotations;
      }
    }
    // Diagnostic: log the attachment portion of the request body so we
    // can confirm Chat is receiving the attachmentUploadToken correctly.
    // Reported by maayan 2026-05-11: 'message sends but photos aren't
    // attached'. If logs show `attachment: [...]` going out but the
    // returned message has no `attachment[]` field, the token form is
    // wrong; if attachment[] is absent from BOTH directions, something
    // upstream of postMessage is dropping it.
    if (hasAttachments) {
      console.log(
        "[chat] postMessage sending attachment[]:",
        JSON.stringify(requestBody.attachment).slice(0, 400),
      );
    }
    const res = await chat.spaces.messages.create({
      parent: `spaces/${spaceId}`,
      requestBody,
      messageReplyOption: options.threadName
        ? "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
        : undefined,
    });
    if (hasAttachments) {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const returned = (res.data as any).attachment;
      /* eslint-enable @typescript-eslint/no-explicit-any */
      console.log(
        "[chat] postMessage response attachment[]:",
        returned ? JSON.stringify(returned).slice(0, 400) : "(absent)",
      );
    }
    return res.data.name ?? "";
  } catch (e) {
    console.log("[chat] postMessage failed:", e);
    return "";
  }
}
