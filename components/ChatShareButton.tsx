"use client";

import { useEffect, useRef, useState } from "react";
import type { CustomerEmailItem } from "@/lib/customerEmails";

/**
 * Two-step share button: click to open a project picker, click a
 * project to send. Used both on /customer-emails (full page) and
 * inside the NavCustomerEmails popover, which is why this lives as a
 * standalone component and not inline.
 *
 * `target` selects the destination mechanism:
 *   - "internal" → POST /api/customer-emails/share-to-chat — the
 *     project's Google Chat Space (team-only). Picker filters to
 *     projects that have a chat space configured.
 *   - "client" → POST /api/customer-emails/share-to-client — a
 *     comment row on the project's Comments sheet (visible to the
 *     client on the project's client tab). Picker shows every
 *     project under the company.
 *
 * Default selection: prefers "כללי" (the company catchall) when
 * present so unsorted customer emails land in a sensible default
 * without requiring user thought. Sort order matches the home page.
 *
 * Pre-fetches the company's project list on first open and caches
 * it for the lifetime of the component instance — picking a
 * different target on the same email row reuses the same list.
 */
type Target = "internal" | "client";

type ProjectInfo = {
  name: string;
  hasChatSpace: boolean;
  isGeneral: boolean;
};

type ShareResult = { ok: true; projectName: string } | { ok: false; error: string };

export default function ChatShareButton({
  email,
  target,
  label,
  onResult,
}: {
  email: CustomerEmailItem;
  target: Target;
  label: string;
  /** Fires after a send attempt. Caller renders the toast since the
   *  toast surface differs per host (sticky banner on the page,
   *  inline strip in the popover). */
  onResult: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyProject, setBusyProject] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Outside-click + Escape to close.
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

  async function loadProjectsIfNeeded() {
    if (projects !== null || !email.company) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/customer-emails/projects-for-company?company=${encodeURIComponent(email.company)}`,
        { cache: "no-store" },
      );
      const data = (await res.json()) as
        | { ok: true; projects: ProjectInfo[] }
        | { ok: false; error: string };
      if (!("ok" in data) || !data.ok) {
        throw new Error(("error" in data && data.error) || "load failed");
      }
      setProjects(data.projects);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void loadProjectsIfNeeded();
  }

  async function send(projectName: string) {
    setBusyProject(projectName);
    try {
      const url =
        target === "internal"
          ? "/api/customer-emails/share-to-chat"
          : "/api/customer-emails/share-to-client";
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: projectName,
          company: email.company,
          subject: email.subject,
          sender: email.senderEmail,
          senderName: email.senderName,
          snippet: email.snippet,
          gmailLink: email.gmailLink,
        }),
      });
      const data = (await res.json()) as ShareResult;
      if (!("ok" in data) || !data.ok) {
        throw new Error(("error" in data && data.error) || "send failed");
      }
      const channel = target === "internal" ? "צ׳אט פנימי" : "צ׳אט עם לקוח";
      onResult(`✓ נשלח ל${channel} בפרויקט ${data.projectName}`);
      setOpen(false);
    } catch (e) {
      onResult(`שגיאה: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyProject(null);
    }
  }

  // Filter for the target. Internal needs a chat space; client posts
  // through the Comments sheet which any project supports.
  const visible = (projects || []).filter((p) =>
    target === "internal" ? p.hasChatSpace : true,
  );

  return (
    <div ref={wrapRef} className="chat-share-button-wrap">
      <button
        type="button"
        className="customer-email-action"
        onClick={toggle}
        disabled={!email.company}
        title={
          email.company
            ? `שתף ל${target === "internal" ? "צ׳אט הפרויקט" : "צ׳אט עם הלקוח"} (פרויקט תחת ${email.company})`
            : "אין חברה רשומה — לא ניתן לשתף"
        }
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {label} ▾
      </button>
      {open && (
        <div className="chat-share-popover" role="menu">
          {loading && <div className="chat-share-popover-loading">טוען…</div>}
          {error && (
            <div className="chat-share-popover-error">שגיאה: {error}</div>
          )}
          {!loading && !error && visible.length === 0 && (
            <div className="chat-share-popover-empty">
              {target === "internal"
                ? "אין פרויקטים עם Chat Space מוגדר תחת חברה זו."
                : "אין פרויקטים תחת חברה זו."}
            </div>
          )}
          {!loading && !error && visible.length > 0 && (
            <ul className="chat-share-popover-list">
              {visible.map((p) => (
                <li key={p.name}>
                  <button
                    type="button"
                    role="menuitem"
                    className="chat-share-popover-option"
                    onClick={() => send(p.name)}
                    disabled={busyProject === p.name}
                  >
                    {p.isGeneral ? "📌 " : ""}
                    {p.name}
                    {busyProject === p.name && (
                      <span className="chat-share-popover-busy"> ...</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
