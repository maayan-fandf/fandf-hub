"use client";

import Link from "next/link";
import type { CustomerEmailItem } from "@/lib/customerEmails";

/**
 * Render the unread customer-email list with per-row actions:
 *   - Open in Gmail (deep-link to the user's primary inbox)
 *   - Convert to hub task (deep-link to /tasks/new with prefill)
 *
 * Dismiss is implicit: the user reads / archives the message in Gmail
 * and the next render's `is:unread` filter drops it. No hub-side state
 * to manage, so no dismiss button.
 *
 * Post-to-chat-space is deferred to v0.5 — needs project / chat-space
 * resolution from the (sender → company → project) chain, which is one
 * step removed from what's on the row right now. Once a user converts
 * to a hub task, the existing chat-space integration on /tasks/[id]
 * already covers the "discuss with the client" flow.
 */
export default function CustomerEmailsList({
  items,
  error,
}: {
  items: CustomerEmailItem[];
  error?: string;
}) {
  if (error) {
    return (
      <div className="customer-emails-error" role="alert">
        שגיאה בטעינת מיילים: {error}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="customer-emails-empty">
        <p>אין מיילים חדשים מלקוחות רשומים ב-3 הימים האחרונים.</p>
      </div>
    );
  }

  return (
    <ul className="customer-emails-list">
      {items.map((it) => (
        <li
          key={it.id}
          className="customer-email-row"
          data-company={it.company || undefined}
        >
          <div className="customer-email-meta">
            <strong className="customer-email-sender">
              {it.senderName || it.senderEmail}
            </strong>
            {it.company && (
              <span className="customer-email-company">{it.company}</span>
            )}
            <time className="customer-email-time" dir="ltr">
              {formatDate(it.receivedAt)}
            </time>
          </div>
          <div className="customer-email-subject">{it.subject}</div>
          {it.snippet && (
            <div className="customer-email-snippet">{it.snippet}</div>
          )}
          <div className="customer-email-actions">
            <a
              className="customer-email-action"
              href={it.gmailLink}
              target="_blank"
              rel="noreferrer"
            >
              📧 פתח ב-Gmail
            </a>
            <Link
              className="customer-email-action"
              href={buildNewTaskHref(it)}
              prefetch={false}
            >
              ➕ צור משימה
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Build the /tasks/new query string with the email's metadata
 *  pre-filled. Param names (`company`, `title`, `body`) match what
 *  /tasks/new already understands from the GT-conversion + comment-
 *  conversion flows — no new prefill plumbing needed on the form. */
function buildNewTaskHref(it: CustomerEmailItem): string {
  const params = new URLSearchParams();
  if (it.company) params.set("company", it.company);
  if (it.subject) params.set("title", it.subject);
  // Body gets the sender + snippet so the user has context without
  // flipping back to Gmail. Truncated because URL params are
  // URL-encoded and Hebrew expands ~3x.
  const body = [
    it.senderName
      ? `מאת: ${it.senderName} <${it.senderEmail}>`
      : `מאת: ${it.senderEmail}`,
    it.snippet,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (body) params.set("body", body.slice(0, 1500));
  return `/tasks/new?${params.toString()}`;
}

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("he-IL", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
