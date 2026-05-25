"use client";

import { useEffect } from "react";
import { BN_EVENT, BN_OPTIN_KEY, BN_SINCE_KEY } from "@/lib/browserNotify";

/**
 * Always-mounted (renders nothing). Polls the unread-notifications feed
 * and pops a native desktop Notification for items that arrived since
 * the last poll — but only when the user is looking AWAY from the Hub
 * (`!document.hasFocus()` → another tab or another app), since when the
 * Hub is focused the bell badge already tells them.
 *
 * Gated on (a) the per-device opt-in flag and (b) OS permission granted
 * — both managed by BrowserNotifToggle in the gear menu. Diffs by ISO
 * `created_at`; the Notification `tag` (=notification id) collapses
 * duplicates across multiple open tabs into one toast.
 *
 * Foreground-only by design (works while a Hub tab is open). Background
 * web push — alerts when the Hub is fully closed — is a planned
 * follow-up (service worker + VAPID).
 */

const POLL_MS = 60_000;
const FEED = "/api/notifications/list?unread=1&limit=20";

type Item = { id?: string; created_at?: string; title?: string; body?: string; link?: string };

export default function BrowserNotifier() {
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;

    let stopped = false;

    function fire(it: Item) {
      try {
        const n = new Notification(it.title || "התראה חדשה", {
          body: it.body || "",
          tag: it.id || it.created_at || String(Date.now()),
        });
        n.onclick = () => {
          try {
            window.focus();
          } catch {
            /* no-op */
          }
          const link = it.link || "/notifications";
          window.location.href = link;
          n.close();
        };
      } catch {
        /* some engines throw on bad construction — ignore */
      }
    }

    async function poll() {
      if (stopped) return;
      if (localStorage.getItem(BN_OPTIN_KEY) !== "on") return;
      if (Notification.permission !== "granted") return;
      let items: Item[] = [];
      try {
        const res = await fetch(FEED, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { items?: Item[] };
        items = Array.isArray(data.items) ? data.items : [];
      } catch {
        return; // transient — try again next tick
      }
      if (!items.length) return;
      const newest = String(items[0].created_at || "");
      const since = localStorage.getItem(BN_SINCE_KEY) || "";
      // First run on this device: set the baseline, never blast history.
      if (!since) {
        if (newest) localStorage.setItem(BN_SINCE_KEY, newest);
        return;
      }
      const fresh = items.filter((it) => String(it.created_at || "") > since);
      // Always advance the cursor (even when focused) so tabbing away
      // later doesn't replay everything in one burst.
      if (newest) localStorage.setItem(BN_SINCE_KEY, newest);
      if (!fresh.length) return;
      // Only toast when the user is NOT looking at the Hub.
      if (document.hasFocus()) return;
      if (fresh.length > 3) {
        fire({
          id: "fandf-bulk",
          title: "F&F Hub",
          body: `${fresh.length} התראות חדשות`,
          link: "/notifications",
        });
        return;
      }
      // Oldest-first so the newest ends up on top of the OS stack.
      for (const it of [...fresh].reverse()) fire(it);
    }

    void poll(); // baseline immediately
    const timer = setInterval(() => void poll(), POLL_MS);
    const onChange = () => void poll();
    window.addEventListener(BN_EVENT, onChange);

    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener(BN_EVENT, onChange);
    };
  }, []);

  return null;
}
