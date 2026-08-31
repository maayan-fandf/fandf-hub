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
  /** Comment id of the thread this request opened in the project's
   *  shared discussion. Lets the answer land as a REPLY on the same
   *  conversation the client is already watching instead of starting a
   *  second one. Empty on requests recorded before 2026-08-31, and when
   *  the discussion post itself failed. */
  commentId?: string;
  /** What the team wrote back when re-sending the corrected plan — the
   *  `message` from the send-approval dialog. Rendered under the
   *  client's note on the card, so the request and its answer read as
   *  one exchange rather than a request that vanished. Cleared when a
   *  NEW request comes in: an answer only ever belongs to the request
   *  it followed. */
  response?: string;
  respondedBy?: string;
  respondedAt?: string;
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
  commentId?: string;
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
    commentId: String(input.commentId || "").trim(),
    // Explicitly blanked, not merely omitted: the write below merges, so
    // a second request on the same plan would otherwise inherit the
    // answer to the FIRST one and show it as a reply to words nobody
    // wrote yet.
    response: "",
    respondedBy: "",
    respondedAt: "",
  };
  await getDb()
    .collection(FS_COLLECTIONS.prisotChangeRequests)
    .doc(id)
    .set(doc, { merge: true });
}

/** Attach the discussion thread this request opened, after the fact.
 *  Separate from the upsert because the chip is written BEFORE the
 *  discussion post (it has to survive the post failing), so the comment
 *  id isn't known yet at that point. Best-effort — a missing id only
 *  costs the answer its thread. */
export async function attachPrisotChangeThread(
  fileId: string,
  commentId: string,
): Promise<void> {
  const id = String(fileId || "").trim();
  const cid = String(commentId || "").trim();
  if (!id || !cid) return;
  try {
    await getDb()
      .collection(FS_COLLECTIONS.prisotChangeRequests)
      .doc(id)
      .set({ commentId: cid }, { merge: true });
  } catch (e) {
    console.log(
      "[prisotChangeRequests] attach thread failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Record what the team wrote back when re-sending the corrected plan.
 *  Best-effort: the plan going out matters more than the card showing
 *  the covering note. */
export async function attachPrisotChangeResponse(input: {
  fileId: string;
  response: string;
  respondedBy: string;
}): Promise<void> {
  const id = String(input.fileId || "").trim();
  const text = String(input.response || "").trim().slice(0, 2000);
  if (!id || !text) return;
  try {
    await getDb()
      .collection(FS_COLLECTIONS.prisotChangeRequests)
      .doc(id)
      .set(
        {
          response: text,
          respondedBy: String(input.respondedBy || "").toLowerCase().trim(),
          respondedAt: new Date().toISOString(),
        },
        { merge: true },
      );
  } catch (e) {
    console.log(
      "[prisotChangeRequests] attach response failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
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
