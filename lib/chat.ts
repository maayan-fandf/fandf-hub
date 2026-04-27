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

import { unstable_cache } from "next/cache";
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
 * Cached wrapper — keyed on (subjectEmail, spaceId, limit). 60s TTL
 * matches our other Apps-Script-replacing fetches (morning feed,
 * keys). Tag is `chat-messages` so any future write paths can call
 * `revalidateTag("chat-messages")` to force a fresh read on the next
 * page hit (e.g. after we ship hub-side composing in phase 2).
 */
const listRecentMessagesCached = unstable_cache(
  async (subjectEmail: string, spaceId: string, limit: number) =>
    listRecentMessagesUncached(subjectEmail, spaceId, limit),
  ["chat-recent-messages"],
  { revalidate: 60, tags: ["chat-messages"] },
);

export async function listRecentMessages(
  subjectEmail: string,
  spaceId: string,
  limit = 20,
): Promise<ChatMessage[]> {
  return listRecentMessagesCached(subjectEmail, spaceId, Math.min(limit, 50));
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

/** Reference to an already-uploaded Chat attachment. `resourceName`
 *  is what Chat returns from media.upload and accepts on
 *  messages.create as `attachment[].attachmentDataRef.resourceName`. */
export type ChatAttachmentRef = {
  resourceName: string;
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
  const { Readable } = await import("node:stream");
  const chat = chatClient(subjectEmail);
  const res = await chat.media.upload({
    parent: `spaces/${spaceId}`,
    requestBody: { filename: fileName },
    media: {
      mimeType,
      body: Readable.from(bytes),
    },
  });
  const ref = res.data.attachmentDataRef?.resourceName ?? "";
  if (!ref) throw new Error("Chat upload returned no attachmentDataRef");
  return { resourceName: ref };
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
        attachmentDataRef: { resourceName: a.resourceName },
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
    const res = await chat.spaces.messages.create({
      parent: `spaces/${spaceId}`,
      requestBody,
      messageReplyOption: options.threadName
        ? "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
        : undefined,
    });
    return res.data.name ?? "";
  } catch (e) {
    console.log("[chat] postMessage failed:", e);
    return "";
  }
}
