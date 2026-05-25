/**
 * Shared constants/helpers for the FOREGROUND browser-notification
 * feature (native desktop alerts while a Hub tab is open). Client-only
 * in practice, but written so importing it is always safe — every
 * browser API is touched inside a function, never at module load.
 *
 * Opt-in is per-device (localStorage), which is the right granularity:
 * the OS permission + "do I want desktop pings on THIS machine" are
 * device-scoped, not a server-side account pref. Background web push
 * (which IS account-scoped) is a planned follow-up.
 */

/** localStorage: "on" once the user enabled desktop alerts on this device. */
export const BN_OPTIN_KEY = "fandf-browser-notif";
/** localStorage: ISO created_at of the newest notification already seen,
 *  so a reload/poll doesn't re-fire history. */
export const BN_SINCE_KEY = "fandf-browser-notif-since";
/** window event dispatched when the opt-in toggles, so the always-mounted
 *  poller starts/stops without a page reload. */
export const BN_EVENT = "fandf-browser-notif-changed";

export function bnSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function bnOptedIn(): boolean {
  try {
    return localStorage.getItem(BN_OPTIN_KEY) === "on";
  } catch {
    return false;
  }
}

export function bnSetOptedIn(on: boolean): void {
  try {
    localStorage.setItem(BN_OPTIN_KEY, on ? "on" : "off");
  } catch {
    /* private mode / blocked storage — toggle just won't persist */
  }
  try {
    window.dispatchEvent(new Event(BN_EVENT));
  } catch {
    /* no-op */
  }
}
