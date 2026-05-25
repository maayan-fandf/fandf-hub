"use client";

import { useEffect, useState } from "react";
import { BN_OPTIN_KEY, BN_SINCE_KEY, bnSetOptedIn } from "@/lib/browserNotify";
import {
  subscribeBackgroundPush,
  unsubscribeBackgroundPush,
} from "@/lib/pushClient";

/**
 * Gear-menu toggle to enable/disable native desktop notifications on
 * this device. Requesting OS permission needs a user gesture, so this
 * is an explicit opt-in (browsers won't let us auto-prompt). Once on,
 * BrowserNotifier (mounted in the layout) does the polling + popping.
 *
 * State is derived from OS permission + the per-device opt-in flag:
 *   unsupported → engine has no Notification API
 *   denied      → user blocked it in the browser (must re-enable there)
 *   on / off    → granted + opted-in (or not)
 */

type S = "loading" | "unsupported" | "denied" | "on" | "off";

export default function BrowserNotifToggle() {
  const [state, setState] = useState<S>("loading");

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    const optedIn = localStorage.getItem(BN_OPTIN_KEY) === "on";
    setState(Notification.permission === "granted" && optedIn ? "on" : "off");
  }, []);

  async function toggle() {
    if (state === "on") {
      bnSetOptedIn(false);
      void unsubscribeBackgroundPush(); // drop background push too
      setState("off");
      return;
    }
    // Turning on — request OS permission if not decided yet.
    let perm: NotificationPermission = Notification.permission;
    if (perm === "default") {
      try {
        perm = await Notification.requestPermission();
      } catch {
        perm = Notification.permission;
      }
    }
    if (perm !== "granted") {
      setState(perm === "denied" ? "denied" : "off");
      return;
    }
    // Baseline the cursor so enabling doesn't immediately replay history.
    try {
      const res = await fetch("/api/notifications/list?unread=1&limit=1", {
        cache: "no-store",
      });
      const data = (await res.json()) as { items?: { created_at?: string }[] };
      const newest = data?.items?.[0]?.created_at || new Date().toISOString();
      localStorage.setItem(BN_SINCE_KEY, newest);
    } catch {
      localStorage.setItem(BN_SINCE_KEY, new Date().toISOString());
    }
    bnSetOptedIn(true);
    // Also subscribe to BACKGROUND push (alerts when the Hub is closed).
    // Best-effort: no-ops when VAPID keys aren't wired yet or the browser
    // can't do push — foreground polling still covers the tab-open case,
    // and the shared notification `tag` dedups if both ever fire.
    void subscribeBackgroundPush();
    setState("on");
    try {
      new Notification("F&F Hub", { body: "התראות דפדפן הופעלו ✅" });
    } catch {
      /* no-op */
    }
  }

  const disabled =
    state === "loading" || state === "unsupported" || state === "denied";
  const sub =
    state === "unsupported"
      ? "הדפדפן לא תומך בהתראות"
      : state === "denied"
        ? "חסום — יש לאפשר התראות לאתר בהגדרות הדפדפן"
        : "התראה במחשב כשמגיעה התראה חדשה (כשהלשונית ברקע)";

  return (
    <label className="settings-menu-toggle">
      <input
        type="checkbox"
        checked={state === "on"}
        disabled={disabled}
        onChange={() => void toggle()}
      />
      <span className="settings-menu-toggle-label">
        התראות דפדפן
        <small>{sub}</small>
      </span>
    </label>
  );
}
