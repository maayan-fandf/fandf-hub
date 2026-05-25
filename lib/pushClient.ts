/**
 * Client helpers for background Web Push: register the service worker,
 * subscribe via the PushManager, and tell the server. All no-op safely
 * when the browser lacks support or the VAPID public key isn't set
 * (NEXT_PUBLIC_VAPID_PUBLIC_KEY) — the feature stays DORMANT until the
 * keys are wired, so foreground notifications keep working alone.
 */

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const SW_URL = "/sw.js";

/** True when this browser can do background push AND the app is wired. */
export function backgroundPushAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    !!VAPID_PUBLIC_KEY
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Register the SW + subscribe + persist to the server. Returns true on
 * success. Assumes OS permission is already granted (the toggle requests
 * it first). Best-effort: any failure returns false (caller falls back
 * to foreground-only).
 */
export async function subscribeBackgroundPush(): Promise<boolean> {
  if (!backgroundPushAvailable()) return false;
  try {
    const reg = await navigator.serviceWorker.register(SW_URL);
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Cast: a Uint8Array is a valid BufferSource at runtime; the TS
        // 5.7 dom lib narrows BufferSource to ArrayBuffer-backed views.
        applicationServerKey: urlBase64ToUint8Array(
          VAPID_PUBLIC_KEY,
        ) as unknown as BufferSource,
      });
    }
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Unsubscribe this browser + tell the server to drop the record. */
export async function unsubscribeBackgroundPush(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_URL);
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return;
    const endpoint = sub.endpoint;
    try {
      await sub.unsubscribe();
    } catch {
      /* keep going — still tell the server to drop it */
    }
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
  } catch {
    /* no-op */
  }
}
