import { getDb, FS_COLLECTIONS } from "@/lib/firestore";

/**
 * Firestore-backed per-פריסה client change-requests. When a client hits
 * "בקש שינויים" on the media-plan card, we record a single doc keyed by
 * the Drive fileId so the card can render a "🔄 התבקשו שינויים · <date>"
 * chip until the plan is (re-)approved. Doc id = the raw Drive fileId
 * (globally unique and Firestore-id-safe — no hashing needed, unlike the
 * Hebrew-channel management-fee keys).
 *
 * Reads soft-fail to null so the (force-dynamic) project page still
 * renders if Firestore is unavailable — same posture as the rest of the
 * card's data chain.
 */
export type PrisotChangeRequest = {
  fileId: string;
  projectName: string;
  /** Email of the client who asked for changes. */
  requestedBy: string;
  /** ISO timestamp of the request. */
  requestedAt: string;
  /** Free-text of what to change. */
  note: string;
};

export async function getPrisotChangeRequest(
  fileId: string,
): Promise<PrisotChangeRequest | null> {
  const id = String(fileId || "").trim();
  if (!id) return null;
  try {
    const snap = await getDb()
      .collection(FS_COLLECTIONS.prisotChangeRequests)
      .doc(id)
      .get();
    if (!snap.exists) return null;
    return (snap.data() as PrisotChangeRequest) || null;
  } catch (e) {
    console.log(
      "[prisotChangeRequests] read failed:",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

export async function upsertPrisotChangeRequest(input: {
  fileId: string;
  projectName: string;
  requestedBy: string;
  note?: string;
}): Promise<void> {
  const id = String(input.fileId || "").trim();
  if (!id) throw new Error("fileId required");
  // requestedBy / requestedAt are stamped server-side — never trust the
  // client for identity or time.
  const doc: PrisotChangeRequest = {
    fileId: id,
    projectName: String(input.projectName || "").trim(),
    requestedBy: String(input.requestedBy || "").toLowerCase().trim(),
    requestedAt: new Date().toISOString(),
    note: String(input.note || "").trim().slice(0, 2000),
  };
  await getDb()
    .collection(FS_COLLECTIONS.prisotChangeRequests)
    .doc(id)
    .set(doc, { merge: true });
}

export async function clearPrisotChangeRequest(fileId: string): Promise<void> {
  const id = String(fileId || "").trim();
  if (!id) return;
  try {
    await getDb()
      .collection(FS_COLLECTIONS.prisotChangeRequests)
      .doc(id)
      .delete();
  } catch (e) {
    // A stuck chip is a cosmetic nit, not a failure — don't block the
    // approve response on it.
    console.log(
      "[prisotChangeRequests] clear failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}
