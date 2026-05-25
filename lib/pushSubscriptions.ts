/**
 * Firestore store for Web Push subscriptions (background notifications).
 * One doc per browser/device, id = sha1(endpoint) so re-subscribing the
 * same browser upserts rather than duplicates. Server-only.
 */

import { createHash } from "node:crypto";
import { getDb, FS_COLLECTIONS } from "@/lib/firestore";

export type StoredPushSub = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type PushSubRecord = {
  id: string;
  user_email: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

function docIdFor(endpoint: string): string {
  return createHash("sha1").update(endpoint).digest("hex");
}

export async function savePushSubscription(
  userEmail: string,
  sub: StoredPushSub,
): Promise<void> {
  const endpoint = String(sub?.endpoint || "").trim();
  const p256dh = String(sub?.keys?.p256dh || "").trim();
  const auth = String(sub?.keys?.auth || "").trim();
  if (!endpoint || !p256dh || !auth) throw new Error("invalid subscription");
  await getDb()
    .collection(FS_COLLECTIONS.pushSubscriptions)
    .doc(docIdFor(endpoint))
    .set({
      user_email: userEmail.toLowerCase().trim(),
      endpoint,
      keys: { p256dh, auth },
      updated_at: new Date().toISOString(),
    });
}

export async function deletePushSubscriptionByEndpoint(
  endpoint: string,
): Promise<void> {
  const e = String(endpoint || "").trim();
  if (!e) return;
  await getDb()
    .collection(FS_COLLECTIONS.pushSubscriptions)
    .doc(docIdFor(e))
    .delete()
    .catch(() => {});
}

export async function listPushSubscriptions(
  userEmail: string,
): Promise<PushSubRecord[]> {
  const snap = await getDb()
    .collection(FS_COLLECTIONS.pushSubscriptions)
    .where("user_email", "==", userEmail.toLowerCase().trim())
    .get();
  const out: PushSubRecord[] = [];
  snap.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    const endpoint = String(data?.endpoint || "");
    const keys = data?.keys as { p256dh?: string; auth?: string } | undefined;
    if (endpoint && keys?.p256dh && keys?.auth) {
      out.push({
        id: d.id,
        user_email: String(data.user_email || ""),
        endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
      });
    }
  });
  return out;
}

/** Prune a dead subscription doc by its Firestore id (after a 404/410). */
export async function prunePushSubscriptionById(id: string): Promise<void> {
  await getDb()
    .collection(FS_COLLECTIONS.pushSubscriptions)
    .doc(id)
    .delete()
    .catch(() => {});
}
