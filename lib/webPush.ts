/**
 * Server-side Web Push sender (background browser notifications).
 *
 * VAPID config comes from env (set together so the feature is all-or-
 * nothing): VAPID_PUBLIC_KEY (or NEXT_PUBLIC_VAPID_PUBLIC_KEY),
 * VAPID_PRIVATE_KEY (secret), VAPID_SUBJECT (mailto:). When the keys
 * aren't present the feature is DORMANT — webPushConfigured() returns
 * false and every caller no-ops, so shipping this before the secret is
 * wired is safe (foreground notifications keep working meanwhile).
 *
 * Never throws — push is best-effort telemetry-grade, like the email +
 * pricing-ledger paths. A dead subscription (404/410) is reported via
 * `gone` so the caller can prune it.
 */

import webpush from "web-push";

type PushSubscriptionLike = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

function vapid() {
  const publicKey =
    process.env.VAPID_PUBLIC_KEY ||
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ||
    "";
  const privateKey = process.env.VAPID_PRIVATE_KEY || "";
  const subject = process.env.VAPID_SUBJECT || "mailto:hub@fandf.co.il";
  return { publicKey, privateKey, subject };
}

/** True only when both VAPID keys are present — the dormant-vs-active
 *  gate for the whole background-push feature. */
export function webPushConfigured(): boolean {
  const { publicKey, privateKey } = vapid();
  return !!publicKey && !!privateKey;
}

let _ready: boolean | null = null;
function ensureVapid(): boolean {
  if (_ready !== null) return _ready;
  const { publicKey, privateKey, subject } = vapid();
  if (!publicKey || !privateKey) {
    _ready = false;
    return false;
  }
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    _ready = true;
  } catch (e) {
    console.log(
      "[webPush] setVapidDetails failed:",
      e instanceof Error ? e.message : String(e),
    );
    _ready = false;
  }
  return _ready;
}

export type PushPayload = {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
};

/**
 * Send one push. Returns { ok, gone }: `gone` = the subscription is dead
 * (404/410) and the caller should prune it. Never throws.
 */
export async function sendWebPush(
  subscription: PushSubscriptionLike,
  payload: PushPayload,
): Promise<{ ok: boolean; gone: boolean }> {
  if (!ensureVapid()) return { ok: false, gone: false };
  try {
    await webpush.sendNotification(
      subscription as unknown as webpush.PushSubscription,
      JSON.stringify(payload),
      { TTL: 60 * 60 * 24 },
    );
    return { ok: true, gone: false };
  } catch (e: unknown) {
    const code =
      typeof e === "object" && e && "statusCode" in e
        ? Number((e as { statusCode?: number }).statusCode)
        : 0;
    const gone = code === 404 || code === 410;
    if (!gone) {
      console.log(
        "[webPush] send failed:",
        code,
        e instanceof Error ? e.message : String(e),
      );
    }
    return { ok: false, gone };
  }
}
