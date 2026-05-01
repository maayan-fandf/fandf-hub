/**
 * Direct Gmail reader for "emails from registered customers" — the
 * push-to-hub counterpart of the existing pull-based gmailTasks
 * (which surfaces only emails the user manually right-clicked → Add
 * to Tasks). This reader queries Gmail per-render with a `from:(...)
 * is:unread newer_than:Nd` filter built from Keys col E ('Email
 * Client'), so the source of truth stays in Gmail itself — no sheet
 * cache, no cron, no dedup state to drift.
 *
 * Why no persistent storage:
 *   - "Dismissed" semantics are implicit: user reads / archives /
 *     replies in Gmail, the next render's `is:unread` filter drops
 *     the row.
 *   - "Converted to task" semantics are implicit too: once the
 *     resulting hub task exists, the user can mark-read in Gmail or
 *     leave the message and it'll re-appear (intended, in case they
 *     also want to post to chat space). Explicit dismiss without
 *     touching Gmail would need `gmail.modify` to apply a label —
 *     deferred until users ask for it.
 *
 * Scope: requires `gmail.readonly` DWD scope on the SA — already
 * granted (same scope the gmailTasks system uses for sender
 * resolution). Any 403 from Gmail surfaces as an empty list with the
 * underlying error logged; the page renders gracefully.
 */

import { gmailReadClient } from "@/lib/sa";
import { findCompanyByClientEmail, readKeysCached } from "@/lib/keys";
import { parseEmailAddress } from "@/lib/gmailTasks";

export type CustomerEmailItem = {
  /** Gmail message id (stable per-message). */
  id: string;
  /** Gmail thread id (used for the inbox deep-link). */
  threadId: string;
  /** Sender's email address, lowercased. Empty when From header
   *  parsing fails (rare; bounce-style synthetic messages). */
  senderEmail: string;
  /** Display name from the From header — `"John Doe" <j@x.com>` →
   *  `John Doe`. Empty when header is just a bare email. */
  senderName: string;
  /** Subject line, raw. */
  subject: string;
  /** Gmail's `snippet` field — first ~150 chars of the body, already
   *  decoded and stripped by Gmail. Cheap to fetch (no body parsing
   *  needed for the list view). */
  snippet: string;
  /** Deep-link to the user's Gmail thread. Opens in their primary
   *  account; if they're signed into multiple, the `u/0` path picks
   *  the first one — same convention as gmailTasks. */
  gmailLink: string;
  /** RFC 3339 received timestamp (Gmail's internalDate, ms-since-
   *  epoch, converted to ISO). Used for sorting + display. */
  receivedAt: string;
  /** Company resolved from senderEmail via Keys col E. Empty when no
   *  match (shouldn't happen since the query already filters to
   *  registered senders, but possible if a row's email moved). */
  company: string;
};

/**
 * Aggregate the unique customer email addresses from Keys col E
 * ('Email Client'). The cell is comma- or semicolon-separated; each
 * value is trimmed of stray quotes and validated as a vague-shape
 * email. Lowercased + de-duplicated.
 *
 * Returns [] when the column is missing — caller can short-circuit
 * the Gmail call instead of building a no-op `from:()` query.
 */
export async function listRegisteredCustomerEmails(
  subjectEmail: string,
): Promise<string[]> {
  const { headers, rows } = await readKeysCached(subjectEmail);
  const i = headers.findIndex((h) => /email\s*client/i.test(h));
  if (i < 0) return [];
  const set = new Set<string>();
  for (const row of rows) {
    const cell = String(row[i] ?? "").trim();
    if (!cell) continue;
    for (const raw of cell.split(/[,;]/)) {
      const email = raw
        .trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) set.add(email);
    }
  }
  return [...set];
}

/**
 * List unread customer emails received in the last `days` days
 * (default 3), newest first, capped at `maxResults` (default 50).
 *
 * Cost: one `gmail.users.messages.list` + one
 * `gmail.users.messages.get` (metadata format) per result. With
 * Gmail's per-second rate quota (250 units/user/sec) and trivial
 * unit cost (5 per call), even 50 results is well under one second
 * of budget. No daily cap on Gmail API like there is on Tasks API.
 */
export async function listCustomerEmails(
  subjectEmail: string,
  opts: { days?: number; maxResults?: number } = {},
): Promise<CustomerEmailItem[]> {
  const days = opts.days ?? 3;
  const maxResults = opts.maxResults ?? 50;

  const customers = await listRegisteredCustomerEmails(subjectEmail);
  if (customers.length === 0) return [];

  // Gmail's `q` parser handles the `OR` infix natively. Length cap
  // is generous (~1KB observed in practice). For ~30 customers at
  // ~25 chars each we're at ~750 chars — well within budget. If we
  // ever exceed it, batch the customers and merge results.
  const fromClause = `from:(${customers.join(" OR ")})`;
  const q = `${fromClause} is:unread newer_than:${days}d`;

  const gmail = gmailReadClient(subjectEmail);
  let messageIds: string[];
  try {
    const list = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults,
    });
    messageIds = (list.data.messages ?? [])
      .map((m) => m.id || "")
      .filter(Boolean);
  } catch (e) {
    console.log(
      "[customerEmails] messages.list failed:",
      e instanceof Error ? e.message : String(e),
    );
    return [];
  }
  if (messageIds.length === 0) return [];

  const enriched = await Promise.all(
    messageIds.map(async (id) => {
      try {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id,
          // metadata is much cheaper than `full` — we only need
          // headers + snippet for the list view. The convert-to-task
          // page can re-fetch with `full` if it needs the body.
          format: "metadata",
          metadataHeaders: ["From", "Subject"],
        });
        const data = msg.data;
        const headers = data.payload?.headers ?? [];
        const fromRaw =
          headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
        const subject =
          headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
        const senderEmail = parseEmailAddress(fromRaw);
        const senderName = parseDisplayName(fromRaw);
        const internalDate = data.internalDate
          ? new Date(parseInt(data.internalDate, 10)).toISOString()
          : "";
        const threadId = data.threadId || "";
        const item: CustomerEmailItem = {
          id,
          threadId,
          senderEmail,
          senderName,
          subject,
          snippet: (data.snippet || "").trim(),
          gmailLink: `https://mail.google.com/mail/u/0/#inbox/${threadId || id}`,
          receivedAt: internalDate,
          company: "",
        };
        return item;
      } catch (e) {
        console.log(
          `[customerEmails] messages.get failed for ${id}:`,
          e instanceof Error ? e.message : String(e),
        );
        return null;
      }
    }),
  );

  const items = enriched.filter((x): x is CustomerEmailItem => x !== null);

  // Resolve companies in parallel via the existing Keys lookup. Any
  // miss leaves company empty — the row still renders, it just lacks
  // the company chip. Cached Keys read keeps this cheap.
  await Promise.all(
    items.map(async (it) => {
      if (it.senderEmail) {
        it.company = await findCompanyByClientEmail(
          it.senderEmail,
          subjectEmail,
        ).catch(() => "");
      }
    }),
  );

  // Newest first.
  items.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return items;
}

/** Extract the display-name portion of an RFC 5322 `From:` header.
 *  `"John Doe" <j@x.com>` → `John Doe`. Returns "" for bare-email
 *  headers (no name to show). Strips wrapping double-quotes. */
function parseDisplayName(rawFrom: string): string {
  const m = rawFrom.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  if (!m) return "";
  return m[1].trim();
}
