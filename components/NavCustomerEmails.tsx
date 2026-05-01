"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * Top-nav surface for unread customer emails. Mirrors NavGmailTasks's
 * UX: a count badge that hides when zero, click → popover lists each
 * email with action buttons. Polls /api/customer-emails/count every
 * 60s + on tab focus + on mount.
 *
 * Shown only when:
 *   - User is opted into gmail_customer_poll (server-checked; when off
 *     the count endpoint returns 0 and the badge naturally hides)
 *   - At least one unread customer email exists
 *
 * The popover lists BOTH unread + read (read items rendered greyed
 * out for context). That matches the /customer-emails page behavior.
 */

type CustomerEmail = {
  id: string;
  threadId: string;
  senderEmail: string;
  senderName: string;
  subject: string;
  snippet: string;
  gmailLink: string;
  receivedAt: string;
  company: string;
  isUnread: boolean;
};

export default function NavCustomerEmails() {
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CustomerEmail[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyShareId, setBusyShareId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Poll count every 60s + on focus + on mount. Same cadence as
  // NavGmailTasks so the two badges feel consistent.
  useEffect(() => {
    let cancelled = false;
    async function fetchCount() {
      try {
        const res = await fetch("/api/customer-emails/count", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { count?: number };
        if (cancelled) return;
        setCount(data.count ?? 0);
      } catch {
        /* silent — missing badge is better than a noisy error */
      }
    }
    fetchCount();
    const interval = setInterval(fetchCount, 60_000);
    function onFocus() {
      fetchCount();
    }
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function loadItems() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/customer-emails/list", {
        cache: "no-store",
      });
      const data = (await res.json()) as
        | { ok: true; items: CustomerEmail[]; optedIn: boolean }
        | { ok: false; error: string };
      if (!("ok" in data) || !data.ok) {
        throw new Error(("error" in data && data.error) || "load failed");
      }
      setItems(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    // Re-fetch on every open so the popover reflects fresh state. The
    // /list call is cheap and the user expects the popover to be
    // up-to-date when they intentionally click in.
    if (next) void loadItems();
  }

  function convert(it: CustomerEmail) {
    const params = new URLSearchParams();
    if (it.subject) params.set("title", it.subject);
    if (it.company) params.set("company", it.company);
    const headerLines: string[] = [];
    if (it.gmailLink) headerLines.push(`📧 ${it.gmailLink}`);
    if (it.senderEmail) {
      const sender = it.senderName
        ? `${it.senderName} <${it.senderEmail}>`
        : it.senderEmail;
      headerLines.push(`מאת: ${sender}`);
    }
    const sections: string[] = [];
    if (headerLines.length) sections.push(headerLines.join("\n"));
    if (it.snippet) sections.push(it.snippet);
    const body = sections.join("\n\n");
    if (body) params.set("body", body.slice(0, 1500));
    router.push(`/tasks/new?${params.toString()}`);
    setOpen(false);
  }

  async function shareToChat(it: CustomerEmail) {
    if (!it.company) {
      setToast("חסרה חברה — לא ניתן לשתף לצ׳אט פרויקט");
      return;
    }
    setBusyShareId(it.id);
    setToast(null);
    try {
      const res = await fetch("/api/customer-emails/share-to-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          company: it.company,
          subject: it.subject,
          sender: it.senderEmail,
          senderName: it.senderName,
          snippet: it.snippet,
          gmailLink: it.gmailLink,
        }),
      });
      const data = (await res.json()) as
        | { ok: true; projectName: string }
        | { ok: false; error: string };
      if (!("ok" in data) || !data.ok) {
        throw new Error(("error" in data && data.error) || "share failed");
      }
      setToast(`✓ נשלח לצ׳אט פרויקט ${data.projectName}`);
      // Auto-clear toast after 4s
      setTimeout(() => setToast(null), 4000);
    } catch (e) {
      setToast(`שגיאה: ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => setToast(null), 6000);
    } finally {
      setBusyShareId(null);
    }
  }

  if (count === null || count <= 0) return null;

  return (
    <div ref={wrapRef} className="nav-customer-emails-wrap">
      <button
        type="button"
        className="topnav-link topnav-link-with-badge nav-customer-emails-trigger"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="true"
        title={`${count} מיילים מלקוחות מחכים`}
      >
        📩 לקוחות
        <span className="nav-badge" aria-label={`${count} מיילים`}>
          {count > 99 ? "99+" : count}
        </span>
      </button>
      {open && (
        <div
          className="nav-customer-emails-popover"
          role="dialog"
          aria-label="מיילים מלקוחות"
        >
          <div className="nav-customer-emails-popover-head">
            <div className="nav-customer-emails-popover-head-row">
              <h3>📩 מיילים מלקוחות</h3>
              <Link
                href="/customer-emails"
                className="nav-customer-emails-popover-fullpage"
                onClick={() => setOpen(false)}
              >
                פתח דף מלא ↗
              </Link>
            </div>
            <p className="muted">
              מיילים מלקוחות רשומים (Keys col E) מ-3 הימים האחרונים.
              לסגירת פריט — קרא או העבר לארכיון ב-Gmail.
            </p>
          </div>
          {toast && (
            <div className="nav-customer-emails-toast">{toast}</div>
          )}
          {loading && <div className="nav-customer-emails-loading">טוען…</div>}
          {error && (
            <div className="nav-customer-emails-error">שגיאה: {error}</div>
          )}
          {!loading && !error && items && items.length === 0 && (
            <div className="nav-customer-emails-empty muted">
              אין מיילים חדשים מלקוחות.
            </div>
          )}
          {!loading && !error && items && items.length > 0 && (
            <ul className="nav-customer-emails-list">
              {items.map((it) => (
                <li
                  key={it.id}
                  className={`nav-customer-emails-item${it.isUnread ? "" : " is-read"}`}
                >
                  <div className="nav-customer-emails-item-main">
                    <div className="nav-customer-emails-item-meta">
                      <strong>{it.senderName || it.senderEmail}</strong>
                      {it.company && (
                        <span className="nav-customer-emails-item-company-chip">
                          🏢 {it.company}
                        </span>
                      )}
                      <time className="nav-customer-emails-item-time" dir="ltr">
                        {formatDate(it.receivedAt)}
                      </time>
                    </div>
                    <div className="nav-customer-emails-item-subject">
                      {it.subject || "(ללא נושא)"}
                    </div>
                    {it.snippet && (
                      <div className="nav-customer-emails-item-snippet">
                        {it.snippet}
                      </div>
                    )}
                  </div>
                  <div className="nav-customer-emails-item-actions">
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={() => convert(it)}
                    >
                      ➕ צור משימה
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      onClick={() => shareToChat(it)}
                      disabled={busyShareId === it.id || !it.company}
                      title={
                        it.company
                          ? `שתף לצ׳אט פרויקט תחת ${it.company}`
                          : "אין חברה רשומה — לא ניתן לשתף"
                      }
                    >
                      {busyShareId === it.id ? "..." : "💬 צ׳אט פנימי"}
                    </button>
                    <a
                      href={it.gmailLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-ghost btn-sm"
                    >
                      📧 הגב במייל
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
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
