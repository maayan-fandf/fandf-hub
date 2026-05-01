"use client";

import { useState } from "react";
import Link from "next/link";
import type { CustomerEmailItem } from "@/lib/customerEmails";
import ChatShareButton from "./ChatShareButton";

/**
 * Render the customer-email list with per-row actions:
 *   - ➕ צור משימה — deep-link to /tasks/new with prefill
 *   - 💬 צ׳אט פנימי ▾ — picks a project under the email's company,
 *     posts email summary to that project's Google Chat Space
 *   - 💬 צ׳אט עם לקוח ▾ — picks a project, posts to that project's
 *     Comments sheet (visible to client on the project's client tab)
 *   - 📧 הגב במייל — opens the Gmail thread (the actual email
 *     conversation surface)
 *
 * Read items render greyed out (opacity dimmed). Sort is unread-first
 * already on the server side.
 *
 * Dismiss is implicit: read or archive in Gmail and the next render
 * either shows the row greyed (still in 3-day window) or drops it
 * once the message ages out.
 */
export default function CustomerEmailsList({
  items,
  error,
}: {
  items: CustomerEmailItem[];
  error?: string;
}) {
  const [toast, setToast] = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    const ttl = msg.startsWith("שגיאה") ? 6000 : 4000;
    setTimeout(() => setToast(null), ttl);
  }

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
        <p>אין מיילים מלקוחות רשומים ב-3 הימים האחרונים.</p>
      </div>
    );
  }

  return (
    <>
      {toast && <div className="customer-emails-toast">{toast}</div>}
      <ul className="customer-emails-list">
        {items.map((it) => (
          <li
            key={it.id}
            className={`customer-email-row${it.isUnread ? "" : " is-read"}`}
            data-company={it.company || undefined}
          >
            <div className="customer-email-meta">
              <strong className="customer-email-sender">
                {it.senderName || it.senderEmail}
              </strong>
              {it.company && (
                <span className="customer-email-company">{it.company}</span>
              )}
              {!it.isUnread && (
                <span className="customer-email-readbadge">נקרא</span>
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
              <Link
                className="customer-email-action customer-email-action-primary"
                href={buildNewTaskHref(it)}
                prefetch={false}
              >
                ➕ צור משימה
              </Link>
              <ChatShareButton
                email={it}
                target="internal"
                label="💬 צ׳אט פנימי"
                onResult={showToast}
              />
              <ChatShareButton
                email={it}
                target="client"
                label="💬 צ׳אט עם לקוח"
                onResult={showToast}
              />
              <a
                className="customer-email-action"
                href={it.gmailLink}
                target="_blank"
                rel="noreferrer"
              >
                📧 הגב במייל
              </a>
            </div>
          </li>
        ))}
      </ul>
    </>
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
