"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Top-nav surface for Gmail-origin Google Tasks. The nav item only
 * renders when the user has at least one such task — keeps the nav
 * tidy when there's nothing to act on.
 *
 * Click-flow:
 *  1. Badge shows the count (poll every 60s + on focus).
 *  2. Click → popover lists each task with title + sender (when
 *     resolvable) + a "המר למשימה" button.
 *  3. "המר למשימה" navigates to /tasks/new with title/body/company
 *     prefilled, then POSTs /api/gmail-tasks/dismiss to mark the GT
 *     complete so it doesn't reappear.
 *  4. "סגור" dismisses the GT without converting (for tasks that turn
 *     out not to be hub-worthy).
 */
type GmailTask = {
  id: string;
  tasklistId: string;
  title: string;
  notes: string;
  createdAt: string;
  dueAt: string;
  gmailLink: string;
  senderEmail: string;
  bodyText: string;
  suggestedCompany: string;
};

export default function NavGmailTasks() {
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<GmailTask[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Poll the count every 60s + on tab focus + on mount.
  useEffect(() => {
    let cancelled = false;
    async function fetchCount() {
      try {
        const res = await fetch("/api/gmail-tasks/count", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { count?: number };
        if (cancelled) return;
        setCount(data.count ?? 0);
      } catch {
        /* missing badge is strictly better than a noisy error */
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

  async function loadTasks() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/gmail-tasks/list", { cache: "no-store" });
      const data = (await res.json()) as
        | { ok: true; tasks: GmailTask[] }
        | { ok: false; error: string };
      if (!("ok" in data) || !data.ok) {
        throw new Error(("error" in data && data.error) || "load failed");
      }
      setTasks(data.tasks);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && tasks === null) void loadTasks();
  }

  async function dismiss(taskId: string) {
    try {
      await fetch("/api/gmail-tasks/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
      });
    } catch {
      /* best-effort — caller already moved on */
    }
    // Optimistic remove from the local list, decrement count.
    setTasks((prev) => (prev ? prev.filter((t) => t.id !== taskId) : prev));
    setCount((prev) => (prev !== null ? Math.max(0, prev - 1) : prev));
  }

  function convert(t: GmailTask) {
    const params = new URLSearchParams();
    if (t.title) params.set("title", t.title);
    // Build the description prefill with the email's metadata header
    // (link + sender) followed by a blank line and the email body so
    // the user lands on a task with the original context already in
    // the תיאור field.
    const headerLines: string[] = [];
    if (t.gmailLink) headerLines.push(`📧 ${t.gmailLink}`);
    if (t.senderEmail) headerLines.push(`מאת: ${t.senderEmail}`);
    const sections: string[] = [];
    if (headerLines.length) sections.push(headerLines.join("\n"));
    if (t.bodyText) sections.push(t.bodyText);
    if (t.notes) sections.push(t.notes);
    const body = sections.join("\n\n");
    if (body) params.set("body", body);
    if (t.suggestedCompany) params.set("company", t.suggestedCompany);
    // Convert opens the new-task form with prefill, but leaves the GT
    // ALONE in the user's Google Tasks list. The list here is a live
    // mirror — items only drop when the user explicitly marks them
    // done (via the ✓ button below or natively in the Tasks app).
    router.push(`/tasks/new?${params.toString()}`);
    setOpen(false);
  }

  if (count === null || count <= 0) return null;

  return (
    <div ref={wrapRef} className="nav-gmail-tasks-wrap">
      <button
        type="button"
        className="topnav-link topnav-link-with-badge nav-gmail-tasks-trigger"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="true"
        title={`${count} משימות מ-Gmail מחכות להמרה`}
      >
        📥 מ-Gmail
        <span className="nav-badge" aria-label={`${count} משימות`}>
          {count > 99 ? "99+" : count}
        </span>
      </button>
      {open && (
        <div className="nav-gmail-tasks-popover" role="dialog" aria-label="משימות מ-Gmail">
          <div className="nav-gmail-tasks-popover-head">
            <h3>📥 משימות מ-Gmail</h3>
            <p className="muted">
              שיקוף חי של משימות Google Tasks שיצרת ממיילים (״Add to tasks״).
              ״המר למשימה״ פותח טופס Hub עם פרטי המייל ממולאים — לא מסמן את
              ה-GT כהושלם. ״✓ הושלם״ מסמן את ה-GT כהושלם ב-Google Tasks
              ומסיר אותו מהרשימה כאן.
            </p>
          </div>
          {loading && <div className="nav-gmail-tasks-loading">טוען…</div>}
          {error && (
            <div className="nav-gmail-tasks-error">שגיאה: {error}</div>
          )}
          {!loading && !error && tasks && tasks.length === 0 && (
            <div className="nav-gmail-tasks-empty muted">
              אין משימות חדשות מ-Gmail.
            </div>
          )}
          {!loading && !error && tasks && tasks.length > 0 && (
            <ul className="nav-gmail-tasks-list">
              {tasks.map((t) => (
                <li key={t.id} className="nav-gmail-tasks-item">
                  <div className="nav-gmail-tasks-item-main">
                    <div className="nav-gmail-tasks-item-title">{t.title || "(ללא כותרת)"}</div>
                    {(t.senderEmail || t.suggestedCompany) && (
                      <div className="nav-gmail-tasks-item-meta">
                        {t.senderEmail && (
                          <span title="שולח המייל המקורי">✉️ {t.senderEmail}</span>
                        )}
                        {t.suggestedCompany && (
                          <span
                            className="nav-gmail-tasks-item-company-chip"
                            title="יזוהה אוטומטית ויסומן כחברה ביצירת המשימה"
                          >
                            🏢 {t.suggestedCompany}
                          </span>
                        )}
                      </div>
                    )}
                    {t.gmailLink && (
                      <a
                        href={t.gmailLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="nav-gmail-tasks-item-link"
                      >
                        פתח ב-Gmail ↗
                      </a>
                    )}
                  </div>
                  <div className="nav-gmail-tasks-item-actions">
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={() => convert(t)}
                    >
                      המר למשימה
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      onClick={() => dismiss(t.id)}
                      title="סמן כהושלם ב-Google Tasks (יסיר מהרשימה הזו)"
                    >
                      ✓ הושלם
                    </button>
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
