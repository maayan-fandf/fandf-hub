"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * Action-row extensions for a morning alert that aren't already covered
 * by the snooze button (MorningDismissButton). Two buttons:
 *
 *   💬 שלח לצ׳אט — formats the alert + posts to the project's Google
 *     Chat space (Keys col L). Auto-snoozes on success so the alert
 *     dims with a "✓ טופל" chip while the team sees it in chat.
 *
 *   📋 צור משימה — pre-fills /tasks/new with the alert's title + a
 *     compact summary in the body + the project. From_alert is stamped
 *     on the URL for future link-tracking.
 *
 * Both actions require `projectName` so the chat-send endpoint can
 * resolve the space and so the task gets the right project context.
 * If the alert is already dismissed (snoozed) these buttons hide —
 * the user has to un-snooze first to repost or re-task.
 */

type Props = {
  /** signal_key (stable across reloads — that's how the dismissal
   *  store keys this signal). */
  signalKey: string;
  /** Human-readable project name; used by the chat endpoint to look
   *  up the Chat Space column on Keys. */
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

  // When the alert is already snoozed, both new buttons hide. The
  // existing MorningDismissButton already flips to "↺ בטל טיפול" in
  // that state — letting the user un-snooze before reposting / re-
  // tasking is the deliberate path.
  if (dismissed) return null;

  async function sendToChat() {
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
      // Server-rendered alerts list — refresh so the auto-snoozed row
      // re-renders dimmed with the "טופל" chip.
      router.refresh();
    } catch (err) {
      alert("שגיאה בשליחה: " + (err instanceof Error ? err.message : err));
    } finally {
      setBusy(null);
    }
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

  return (
    <>
      <button
        type="button"
        className="morning-action-chat"
        onClick={sendToChat}
        disabled={busy === "chat"}
        title="שלח את ההתראה לטאב פנימי של הפרויקט (פינג מהיר לצוות F&F)"
      >
        {busy === "chat" ? "…" : "💬 שלח לפנימי"}
      </button>
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
