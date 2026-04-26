"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Avatar from "@/components/Avatar";
import type { NotificationRow } from "@/lib/notifications";

type Props = {
  items: NotificationRow[];
  unreadCount: number;
  kindLabels: Record<string, { emoji: string; label: string }>;
};

/**
 * Interactive notifications list. Renders one card per notification
 * with a "mark all read" header button + per-row click-to-mark.
 *
 * Click on a notification:
 *   - Marks it read (POST /api/notifications/mark-read with the id)
 *   - Navigates to the notification's `link` (/tasks/<id> or
 *     /projects/<X>/timeline#c=<id>) so the user lands on the
 *     conversation that triggered the ping.
 *
 * Mark-all-read fires a single batch request with `{ all: true }` —
 * server scans this user's rows and patches every empty read_at.
 */
export default function NotificationsList({
  items: initialItems,
  unreadCount: initialUnread,
  kindLabels,
}: Props) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [unreadCount, setUnreadCount] = useState(initialUnread);
  const [isPending, startTransition] = useTransition();

  const sorted = useMemo(
    () =>
      items
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [items],
  );

  function markOneRead(id: string) {
    // Optimistic — local state flips before the round trip.
    const stamp = new Date().toISOString();
    setItems((cur) =>
      cur.map((it) => (it.id === id && !it.read_at ? { ...it, read_at: stamp } : it)),
    );
    setUnreadCount((n) => Math.max(0, n - 1));
    void fetch("/api/notifications/mark-read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
      keepalive: true,
    }).catch(() => {
      /* best-effort */
    });
  }

  function markAllRead() {
    if (unreadCount === 0) return;
    startTransition(async () => {
      const stamp = new Date().toISOString();
      setItems((cur) =>
        cur.map((it) => (it.read_at ? it : { ...it, read_at: stamp })),
      );
      setUnreadCount(0);
      await fetch("/api/notifications/mark-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      }).catch(() => {});
      router.refresh();
    });
  }

  return (
    <div className="notifications-wrap">
      <div className="notifications-toolbar">
        <span className="notifications-toolbar-info">
          {unreadCount > 0 ? (
            <>
              <b>{unreadCount}</b> חדשות מתוך {items.length}
            </>
          ) : (
            <>הכל נקרא ({items.length})</>
          )}
        </span>
        {unreadCount > 0 && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={markAllRead}
            disabled={isPending}
          >
            {isPending ? "…" : "סמן הכל כנקרא"}
          </button>
        )}
      </div>
      <ul className="notifications-list">
        {sorted.map((n) => {
          const k = kindLabels[n.kind] || { emoji: "🔔", label: n.kind };
          const unread = !n.read_at;
          const actorHandle = n.actor_email.split("@")[0] || "מישהו";
          return (
            <li
              key={n.id}
              className={`notification-row${unread ? " is-unread" : ""}`}
            >
              <Link
                href={n.link || "/tasks"}
                className="notification-row-link"
                onClick={() => unread && markOneRead(n.id)}
                prefetch={false}
              >
                <Avatar name={n.actor_email} size={32} />
                <div className="notification-row-body">
                  <div className="notification-row-head">
                    <span className="notification-row-kind">
                      <span aria-hidden>{k.emoji}</span> {k.label}
                    </span>
                    {n.project && (
                      <span className="notification-row-project">
                        {n.project}
                      </span>
                    )}
                    <time
                      className="notification-row-time"
                      dateTime={n.created_at}
                      title={n.created_at}
                    >
                      {formatRelative(n.created_at)}
                    </time>
                  </div>
                  <div className="notification-row-actor">
                    <span dir="ltr">{actorHandle}</span>
                  </div>
                  {n.title && (
                    <div className="notification-row-title">{n.title}</div>
                  )}
                  {n.body && (
                    <div className="notification-row-text">{n.body}</div>
                  )}
                </div>
                {unread && (
                  <span
                    className="notification-row-dot"
                    aria-label="לא נקראה"
                    title="לא נקראה"
                  />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return "עכשיו";
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `לפני ${mins} ד׳`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `לפני ${hrs} ש׳`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `לפני ${days} י׳`;
  return new Date(iso).toLocaleDateString("he-IL");
}
