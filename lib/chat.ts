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
      return {
        name: m.name ?? "",
        text: m.text ?? "",
        createTime: m.createTime ?? "",
        senderName: m.sender?.displayName ?? "",
        senderResource: m.sender?.name ?? "",
        mentionEmails,
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
export async function postMessage(
  subjectEmail: string,
  spaceId: string,
  text: string,
): Promise<string> {
  if (!spaceId || !text) return "";
  try {
    const chat = chatClient(subjectEmail);
    const res = await chat.spaces.messages.create({
      parent: `spaces/${spaceId}`,
      requestBody: { text },
    });
    return res.data.name ?? "";
  } catch (e) {
    console.log("[chat] postMessage failed:", e);
    return "";
  }
}
