"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Assignee } from "@/lib/appsScript";
import Avatar from "@/components/Avatar";
import RoleChip from "@/components/RoleChip";

/**
 * Action-row extensions for a morning alert that aren't already covered
 * by the snooze button (MorningDismissButton). Two buttons:
 *
 *   💬 שלח לפנימי — formats the alert + opens a "tag teammates"
 *     popover; on confirm, POSTs to the project's internal-team thread
 *     (the "פנימי" Comments tab — NOT the dead Google Chat) with the
 *     picked emails added both as `@<email>` tokens at the head of the
 *     body (CommentBody renders avatar chips) AND as the `assignees`
 *     list (createMentionDirect fans out a real mention notification
 *     per pick). Auto-snoozes the alert on success so it dims with the
 *     "✓ טופל" chip while the team sees the ping in chat.
 *
 *   📋 צור משימה — pre-fills /tasks/new with the alert's title + a
 *     compact summary in the body + the project. From_alert is stamped
 *     on the URL for future link-tracking.
 *
 * The chat picker mirrors ClientChatComposer / EditDrawer: lazy-loads
 * /api/projects/assignees on first open, same avatar + Hebrew name +
 * role chip rows. Multi-select via click-toggle; the "שלח" button at
 * the bottom posts (even with zero picks — empty selection is allowed
 * for a plain channel-wide ping).
 *
 * Both top actions require `projectName` so the chat picker can resolve
 * the roster and so the task gets the right project context. If the
 * alert is already dismissed (snoozed) these buttons hide — the user
 * has to un-snooze first to repost or re-task.
 */

type Props = {
  /** signal_key (stable across reloads — that's how the dismissal
   *  store keys this signal). */
  signalKey: string;
  /** Human-readable project name; used to fetch the assignees roster
   *  and to scope createMentionDirect on the server. */
  projectName: string;
  /** Alert severity — drives the emoji prefix in the chat message. */
  severity: "severe" | "warn" | "info";
  /** Alert headline. */
  title: string;
  /** Alert body text. Multi-line OK; we just pass it through. */
  detail: string;
  /** Optional deep-link the team can click from chat / the task. */
  url?: string;
  /** When true, the alert is in its snooze window — actions hide so
   *  the user un-snoozes first if they want to repost. */
  dismissed?: boolean;
};

export default function MorningAlertActions({
  signalKey,
  projectName,
  severity,
  title,
  detail,
  url,
  dismissed,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<"chat" | null>(null);

  // Picker state — opens on 💬 click, fetches roster lazily, multi-
  // select toggle, "שלח" confirms and posts. Esc / outside click closes.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [assignees, setAssignees] = useState<Assignee[] | null>(null);
  const [loadingAssignees, setLoadingAssignees] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Lazy-fetch the project roster the first time the picker opens.
  useEffect(() => {
    if (!pickerOpen) return;
    if (assignees !== null || loadingAssignees) return;
    setLoadingAssignees(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/projects/assignees?project=${encodeURIComponent(projectName)}`,
        );
        if (res.ok) {
          const data = (await res.json()) as { assignees: Assignee[] };
          setAssignees(data.assignees);
        } else {
          setAssignees([]);
        }
      } catch {
        setAssignees([]);
      } finally {
        setLoadingAssignees(false);
      }
    })();
  }, [pickerOpen, projectName, assignees, loadingAssignees]);

  // Outside-click + Esc close the picker. Click on the trigger or
  // inside the popover stays open.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  const labelOf = (a: Assignee): string => {
    const he = (a.he_name || "").trim();
    if (he) return he;
    return (a.name || a.email.split("@")[0] || "").trim();
  };

  const filteredRoster = useMemo(() => {
    if (!assignees) return [] as Assignee[];
    const q = filter.toLowerCase().trim();
    if (!q) return assignees;
    return assignees.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.he_name || "").toLowerCase().includes(q) ||
        a.email.toLowerCase().includes(q),
    );
  }, [assignees, filter]);

  // When the alert is already snoozed, both new buttons hide. The
  // existing MorningDismissButton already flips to "↺ בטל טיפול" in
  // that state — letting the user un-snooze before reposting / re-
  // tasking is the deliberate path. Hooks above (state + effects) must
  // still be declared unconditionally to satisfy the rules of hooks.
  if (dismissed) return null;

  function togglePick(email: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  async function sendToChat(emails: string[]) {
    setBusy("chat");
    try {
      const res = await fetch("/api/morning/send-to-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signalKey,
          projectName,
          severity,
          title,
          detail,
          url: url || "",
          assignees: emails,
        }),
      });
      const data: { ok?: boolean; error?: string; spaceId?: string } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok || !data.ok) {
        const msg = data.error || `HTTP ${res.status}`;
        alert("שגיאה בשליחה לצ'אט: " + msg);
        return;
      }
      // Reset picker state on successful post.
      setPicked(new Set());
      setFilter("");
      // Server-rendered alerts list — refresh so the auto-snoozed row
      // re-renders dimmed with the "טופל" chip.
      router.refresh();
    } catch (err) {
      alert("שגיאה בשליחה: " + (err instanceof Error ? err.message : err));
    } finally {
      setBusy(null);
    }
  }

  function onTriggerClick() {
    if (busy === "chat") return;
    setPickerOpen((v) => !v);
  }

  async function onConfirmSend() {
    setPickerOpen(false);
    await sendToChat(Array.from(picked));
  }

  // Pre-fill body for the task: alert detail + a "מקור" line listing
  // the alert + the project + the optional link.
  const taskTitle = `${title} — ${projectName}`;
  const taskBodyLines = [
    detail || "",
    "",
    `מקור: התראת בוקר על ${projectName}`,
    url ? `קישור: ${url}` : "",
  ].filter((s) => s.length > 0);
  const taskBody = taskBodyLines.join("\n");
  const taskHref =
    "/tasks/new?" +
    new URLSearchParams({
      title: taskTitle,
      body: taskBody,
      from_alert: signalKey,
    }).toString();

  const pickedCount = picked.size;

  return (
    <>
      <div className="morning-action-chat-wrap">
        <button
          ref={triggerRef}
          type="button"
          className="morning-action-chat"
          onClick={onTriggerClick}
          disabled={busy === "chat"}
          aria-expanded={pickerOpen}
          aria-haspopup="dialog"
          title="שלח את ההתראה לטאב פנימי של הפרויקט (פינג מהיר לצוות F&F) — בחר חברי צוות לתיוג"
        >
          {busy === "chat" ? "…" : "💬 שלח לפנימי"}
        </button>
        {pickerOpen && (
          <div
            ref={popoverRef}
            className="morning-action-chat-popover"
            role="dialog"
            aria-label="תייג חברי צוות להודעה הפנימית"
          >
            <div className="morning-action-chat-popover-head">
              תייג חברי צוות
            </div>
            <input
              type="text"
              className="morning-action-chat-popover-search"
              placeholder="חיפוש… (אופציונלי)"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoFocus
              dir="auto"
            />
            <div className="morning-action-chat-popover-list">
              {loadingAssignees && (
                <div className="morning-action-chat-popover-empty">טוען…</div>
              )}
              {!loadingAssignees && filteredRoster.length === 0 && (
                <div className="morning-action-chat-popover-empty">
                  {assignees && assignees.length === 0
                    ? "אין חברי צוות זמינים לפרויקט"
                    : "אין תוצאות"}
                </div>
              )}
              {filteredRoster.map((a) => {
                const isPicked = picked.has(a.email);
                return (
                  <button
                    key={a.email}
                    type="button"
                    className={`morning-action-chat-popover-row${
                      isPicked ? " is-picked" : ""
                    }`}
                    onClick={() => togglePick(a.email)}
                    role="option"
                    aria-selected={isPicked}
                  >
                    <Avatar
                      name={a.email}
                      title={a.he_name || a.name}
                      size={22}
                    />
                    <span className="morning-action-chat-popover-name">
                      {labelOf(a)}
                    </span>
                    <RoleChip role={a.role} />
                    <span className="morning-action-chat-popover-check">
                      {isPicked ? "✓" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="morning-action-chat-popover-foot">
              <span className="morning-action-chat-popover-count">
                {pickedCount > 0 ? `${pickedCount} נבחרו` : "ללא תיוג"}
              </span>
              <button
                type="button"
                className="reply-btn reply-btn-ghost"
                onClick={() => setPickerOpen(false)}
                disabled={busy === "chat"}
              >
                ביטול
              </button>
              <button
                type="button"
                className="reply-btn reply-btn-primary"
                onClick={onConfirmSend}
                disabled={busy === "chat"}
                title={
                  pickedCount > 0
                    ? `שלח לפנימי + תייג ${pickedCount} חברי צוות`
                    : "שלח לפנימי ללא תיוג"
                }
              >
                {busy === "chat" ? "שולח…" : "שלח"}
              </button>
            </div>
          </div>
        )}
      </div>
      <Link
        href={taskHref}
        className="morning-action-task"
        title="צור משימה מהתראה זו — שדות יושלמו מראש"
      >
        📋 צור משימה
      </Link>
    </>
  );
}
