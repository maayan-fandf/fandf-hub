/**
 * Gmail-origin Google Tasks → hub inbox.
 *
 * Detects Google Tasks that the user created via Gmail's "Add to tasks"
 * affordance (right-click on an email thread). Those tasks carry a
 * `links[]` entry of type `email` pointing back to the Gmail thread.
 * Hub-spawned tasks (created when a hub WorkTask is opened) do NOT
 * carry a Gmail link and instead start their `notes` with a deep link
 * to `https://hub.fandf.co.il/tasks/<id>` — that's how we exclude them.
 *
 * The hub list is per-user: we impersonate the visiting user via
 * domain-wide delegation, list their default tasklist, and filter to
 * Gmail-origin not-hub-originated. The list is small (≤100 in practice)
 * and the API call is fast (~300–500ms cold), so we cache via
 * `unstable_cache` for 60s rather than wiring up Pub/Sub watch (the
 * Tasks API has no watch endpoint anyway).
 *
 * Each task surfaces enough metadata for the hub to:
 *   - Show the title (= email subject) and link back to Gmail
 *   - Optionally pre-select a חברה when the email's sender is a known
 *     client email in the Keys sheet's `Email Client` column. Sender
 *     resolution requires the `gmail.readonly` DWD scope; without it,
 *     the resolution silently no-ops and the user picks company manually.
 */

import { unstable_cache } from "next/cache";
import { tasksApiClient, gmailReadClient } from "@/lib/sa";
import { findCompanyByClientEmail } from "@/lib/keys";

/** Marker prefix in a GT's notes that identifies it as hub-originated.
 *  Hub-spawned tasks always start their notes with this URL on the very
 *  first line so the user can deep-link from any GT UI. */
const HUB_ORIGIN_PREFIX = "https://hub.fandf.co.il/tasks/";

export type GmailOriginTask = {
  /** The Google Tasks API id (used to mark complete after conversion). */
  id: string;
  /** The default tasklist id this came from — needed to mark complete. */
  tasklistId: string;
  /** Task title — for Gmail-origin tasks this equals the email subject. */
  title: string;
  /** Notes (usually empty for Gmail-origin tasks). */
  notes: string;
  /** RFC 3339 timestamp the GT was created. */
  createdAt: string;
  /** RFC 3339 due date if the user set one (most don't). */
  dueAt: string;
  /** The Gmail thread URL the user can click to open the email. */
  gmailLink: string;
  /** Sender's email (best-effort — empty when gmail.readonly scope is
   *  not granted in DWD, or the link doesn't resolve to a real message). */
  senderEmail: string;
  /** Plain-text body of the source email, truncated to 2KB. Used as the
   *  description prefill on the convert-to-task flow so the user has
   *  the original context without flipping to Gmail. Empty when the
   *  Gmail scope isn't granted or the message has no text/plain part. */
  bodyText: string;
  /** Company auto-resolved from `senderEmail` against Keys col E. Empty
   *  when senderEmail is empty OR the sender isn't listed as a client. */
  suggestedCompany: string;
};

/** Cheap variant — just the count, no Gmail-API resolution. Powers the
 *  nav-badge polling. */
export async function countGmailOriginTasks(
  subjectEmail: string,
): Promise<number> {
  const list = await listGmailOriginTasksRaw(subjectEmail);
  return list.length;
}

const CACHE_TTL = 60;

/** Read the user's default tasklist + filter to Gmail-origin, no Gmail
 *  resolution. Cached per-user for 60s so the count badge doesn't burn
 *  Tasks API quota on every nav-badge poll. */
async function listGmailOriginTasksRaw(
  subjectEmail: string,
): Promise<RawGmailTask[]> {
  return cachedListGmailOriginTasks(subjectEmail);
}

const cachedListGmailOriginTasks = unstable_cache(
  async (subjectEmail: string): Promise<RawGmailTask[]> => {
    const tasks = tasksApiClient(subjectEmail);
    // @default is the magic id for the user's primary tasklist.
    const res = await tasks.tasks.list({
      tasklist: "@default",
      showCompleted: false,
      showHidden: false,
      maxResults: 100,
    });
    const items = (res.data.items ?? []).filter((t) => {
      // Drop hub-originated tasks (notes start with hub URL).
      if (t.notes && t.notes.trim().startsWith(HUB_ORIGIN_PREFIX)) return false;
      // Keep only those with at least one email link.
      const links = (t.links ?? []) as Array<{ type?: string; link?: string }>;
      return links.some((l) => l.type === "email" && l.link);
    });
    return items.map((t) => {
      const links = (t.links ?? []) as Array<{
        type?: string;
        link?: string;
        description?: string;
      }>;
      const emailLink = links.find((l) => l.type === "email" && l.link);
      return {
        id: t.id || "",
        tasklistId: "@default",
        title: t.title || "",
        notes: t.notes || "",
        createdAt: t.updated || "",
        dueAt: t.due || "",
        gmailLink: emailLink?.link || "",
      } as RawGmailTask;
    });
  },
  ["gmail-origin-tasks-raw"],
  { revalidate: CACHE_TTL, tags: ["gmail-origin-tasks"] },
);

type RawGmailTask = Omit<GmailOriginTask, "senderEmail" | "suggestedCompany">;

/** Full variant — lists Gmail-origin tasks AND resolves each one's
 *  sender + body + company via Gmail API + Keys lookup. Used by the
 *  popover list view; gracefully degrades when `gmail.readonly` isn't
 *  granted in DWD (senderEmail/bodyText/suggestedCompany stay empty). */
export async function listGmailOriginTasks(
  subjectEmail: string,
): Promise<GmailOriginTask[]> {
  const raw = await listGmailOriginTasksRaw(subjectEmail);
  if (raw.length === 0) return [];

  const gmail = gmailReadClient(subjectEmail);
  // Resolve all messages in parallel; cap concurrency implicitly by N.
  const enriched = await Promise.all(
    raw.map(async (r) => {
      const messageId = extractGmailMessageId(r.gmailLink);
      let senderEmail = "";
      let bodyText = "";
      if (messageId) {
        try {
          const msg = await gmail.users.messages.get({
            userId: "me",
            id: messageId,
            format: "full",
          });
          const headers = msg.data.payload?.headers ?? [];
          const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
          senderEmail = parseEmailAddress(from);
          bodyText = truncate(extractPlainText(msg.data.payload), 2000);
        } catch {
          // 403 (scope missing) / 404 (message gone) — silently skip.
        }
      }
      const suggestedCompany = senderEmail
        ? await findCompanyByClientEmail(senderEmail, subjectEmail).catch(() => "")
        : "";
      return { ...r, senderEmail, bodyText, suggestedCompany };
    }),
  );
  return enriched;
}

/** Mark one Gmail-origin task complete on the user's default tasklist.
 *  Called after the user converts the GT to a hub WorkTask, so the
 *  same item doesn't keep showing up in the inbox. */
export async function dismissGmailOriginTask(
  subjectEmail: string,
  taskId: string,
): Promise<void> {
  const tasks = tasksApiClient(subjectEmail);
  await tasks.tasks.patch({
    tasklist: "@default",
    task: taskId,
    requestBody: { status: "completed" },
  });
}

/** Gmail thread/message URL → message ID. Two link shapes show up in
 *  practice:
 *    - https://mail.google.com/mail/?authuser=...#inbox/<MSG_ID_HEX>
 *    - https://mail.google.com/mail/u/0/#all/<MSG_ID_HEX>
 *  The ID is a hex-only string after the last `/`. */
function extractGmailMessageId(url: string): string {
  const m = url.match(/[#/]([0-9a-fA-F]{16,})\/?$/);
  return m ? m[1] : "";
}

/** Walk a Gmail `payload` (the message tree returned by users.messages.get)
 *  and return the first text/plain body found, decoded from base64url to
 *  UTF-8. Falls back to text/html with HTML tags stripped when no plain
 *  part exists. Returns "" for messages with no text content. */
type GmailPart = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[];
};
function extractPlainText(payload: GmailPart | null | undefined): string {
  if (!payload) return "";
  const mt = payload.mimeType || "";
  const data = payload.body?.data || "";
  if (data && mt === "text/plain") {
    return decodeBase64Url(data);
  }
  if (payload.parts && payload.parts.length) {
    // Prefer text/plain anywhere in the tree.
    for (const part of payload.parts) {
      if ((part.mimeType || "").startsWith("multipart/")) {
        const nested = extractPlainText(part);
        if (nested) return nested;
      }
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Fallback: any text/html in the tree, with tags stripped.
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return stripHtml(decodeBase64Url(part.body.data));
      }
    }
  }
  if (data && mt === "text/html") {
    return stripHtml(decodeBase64Url(data));
  }
  return "";
}

function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data, "base64url").toString("utf-8");
  } catch {
    return "";
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

/** Parse an RFC 5322 `From:` header value (`"John Doe" <j@x.com>`) into
 *  just the email address. Returns "" when no `<...>` pair is present
 *  AND the value isn't a bare email. */
function parseEmailAddress(rawFrom: string): string {
  const m = rawFrom.match(/<([^>]+)>/);
  if (m) return m[1].toLowerCase().trim();
  // Bare-email form: `j@x.com` (no display name).
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawFrom.trim())) {
    return rawFrom.toLowerCase().trim();
  }
  return "";
}
