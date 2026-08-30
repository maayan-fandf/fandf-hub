import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb, FS_COLLECTIONS } from "@/lib/firestore";
import { getProjectClientEmails } from "@/lib/keys";

/**
 * Signed, expiring, login-free approval links for the פריסה (media-plan)
 * sign-off flow — the replacement for the Drive Approvals API workflow
 * that `lib/driveApprovals.ts:createDriveApproval` used to start.
 *
 * WHY THIS EXISTS
 * ---------------
 * Drive Approvals required every reviewer to hold a Google identity
 * (see the `invalidEmails` probe that createDriveApproval had to grow),
 * then routed them through Drive's own UI to find an approval bar above
 * a spreadsheet. Clients didn't complete it. The hub already had the
 * terminal action — ApprovePrisaButton → /api/drive/approvals/approve →
 * `approvePrisaViaLock` — so all that was missing was a way to get the
 * client to that button without an identity wall in front of it.
 *
 * ONE TOKEN PER REQUEST, NOT PER RECIPIENT
 * ----------------------------------------
 * The approval goes out as a single email addressed to everyone, the way
 * a person would send it — one thread the client side can reply-all on,
 * not N identical copies that read as automated. So the link in it is
 * shared, and the token names the *plan*, never a person.
 *
 * Attribution therefore can't come from the token. The approve page asks
 * who is signing off (choosing from this request's recipient list) when
 * there's more than one, and skips the question entirely when there's
 * one — the common case, where the answer is already known. The chosen
 * address is re-validated server-side against the stored recipients, so
 * the claim can't be anything the team didn't send to.
 *
 * A token is a bearer capability: whoever holds the link can approve the
 * plan. That is a deliberate trade, bounded three ways:
 *   - it expires (TTL below), so a forwarded thread goes cold;
 *   - the approver must name themselves from a closed list, which lands
 *     in the Drive lock reason as the audit trail;
 *   - it only ever grants approve / request-changes on ONE fileId.
 * The underlying plan file is already `anyone-with-link` readable
 * (Drive pre-shared it that way to dodge the visitor-PIN flow), so the
 * link doesn't widen read exposure — it only adds the sign-off action.
 *
 * Residual risk, accepted: anyone on the email can approve as anyone
 * else on the same email. They are all reviewers the team deliberately
 * chose, reading the same thread — so this is a question of which
 * colleague clicked, not of whether an outsider can.
 *
 * SECRET: reuses `AUTH_SECRET` (NextAuth's, already in apphosting.yaml
 * and .env.local) rather than provisioning a new one. Nothing else
 * derives keys from it, so there's no cross-protocol collision, and the
 * payload is domain-tagged (`v1.prisa`) regardless.
 */

/** How long an emailed approval link stays live. Matches the 14 days the
 *  Drive Approvals flow used for `dueTime`, so the client-facing promise
 *  ("שבועיים") doesn't change under them. */
export const APPROVAL_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Domain tag baked into the signed message so a token minted here can
 *  never be replayed against some other AUTH_SECRET-derived signature
 *  scheme added later. Bump the version if the payload shape changes. */
const TOKEN_DOMAIN = "v1.prisa";

export type PrisaApprovalRequest = {
  fileId: string;
  /** Drive file name at send time — shown in the email + on the public
   *  page so the recipient can tell which spread they're approving. */
  fileName: string;
  /** Drive mime type at send time. Recorded so the public page can pick
   *  a renderer without a Drive round-trip — a native Sheet becomes an
   *  HTML table, a PDF an <iframe>, an image an <img>, and anything else
   *  an honest "no preview" note. Without it the page assumed image and
   *  showed a broken placeholder over a live אשר button. May be "" on
   *  docs written before this field existed. */
  mimeType: string;
  /** Project name as the hub knows it (used for the change-request post
   *  and the deep link when we fall back to session auth). */
  projectName: string;
  company: string;
  /** Internal user who hit שלח לאישור. */
  sentBy: string;
  sentAt: string;
  /** Every address the request went to, lowercased. Each got its own
   *  token; any one of them can resolve the request. */
  recipients: string[];
  /** ISO — after this, tokens for this request stop verifying. */
  expiresAt: string;
  /** Optional free-text the sender typed into the dialog. */
  message: string;
  /** Set once someone acts. `approved` is terminal (the Drive file is
   *  locked); `changes` leaves the request open-but-answered so the team
   *  sees the 🔄 chip and can re-send after revising. */
  resolution?: "approved" | "changes";
  resolvedBy?: string;
  resolvedAt?: string;
  /** The Gmail conversation this plan's approval mail lives in, so a
   *  re-send after a revision continues it instead of opening a second
   *  thread the client has to reconcile with the first. Carried forward
   *  across re-sends by the send route; `emailSentBy` is the mailbox the
   *  thread belongs to, and threading is only attempted when the same
   *  person sends again — Gmail rejects a threadId from another mailbox. */
  emailThreadId?: string;
  emailMessageId?: string;
  emailSentBy?: string;
};

/* ─────────────────────────── token codec ─────────────────────────── */

function secret(): string {
  const s = process.env.AUTH_SECRET || "";
  if (!s) {
    throw new Error(
      "AUTH_SECRET is required to sign פריסה approval links (set it in .env.local / apphosting.yaml)",
    );
  }
  return s;
}

const b64u = (b: Buffer): string =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const unb64u = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function sign(payload: string): string {
  return b64u(
    createHmac("sha256", secret()).update(`${TOKEN_DOMAIN}.${payload}`).digest(),
  );
}

/**
 * Mint the link token for ONE plan — shared by every recipient of the
 * single approval email. `expiresAt` is carried inside the signed
 * payload (not just in Firestore) so an expired link is rejected even if
 * the request doc is unreachable.
 */
export function signPrisaApprovalToken(opts: {
  fileId: string;
  expiresAt: string;
}): string {
  const payload = b64u(
    Buffer.from(
      JSON.stringify({
        f: String(opts.fileId).trim(),
        x: Math.floor(Date.parse(opts.expiresAt) / 1000),
      }),
      "utf8",
    ),
  );
  return `${payload}.${sign(payload)}`;
}

export type VerifiedPrisaToken =
  | { ok: true; fileId: string; expiresAt: string }
  /** `expired` still carries the decoded fileId — the signature WAS
   *  valid, only the clock ran out. The approve page uses it to look the
   *  request up anyway and offer a "sign in to the project instead"
   *  link, so a stale link is a detour rather than a dead end. Never
   *  populated for `malformed` / `badsig`, where nothing is trustworthy. */
  | { ok: false; reason: "expired"; fileId: string }
  | { ok: false; reason: "malformed" | "badsig" };

/**
 * Verify + decode a token. Pure (no Firestore) so the public page can
 * cheaply reject junk before touching the network. Callers MUST still
 * check the request doc via `getPrisaApprovalRequest` — the signature
 * only proves the link was minted by us, not that it's still actionable.
 */
export function verifyPrisaApprovalToken(token: string): VerifiedPrisaToken {
  const raw = String(token || "").trim();
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return { ok: false, reason: "malformed" };
  const payload = raw.slice(0, dot);
  const providedSig = raw.slice(dot + 1);

  let expectedSig: string;
  try {
    expectedSig = sign(payload);
  } catch {
    // AUTH_SECRET missing — treat as unverifiable rather than throwing
    // into a page render.
    return { ok: false, reason: "badsig" };
  }
  // Constant-time compare. Length differs → definitely not equal, and
  // timingSafeEqual throws on mismatched lengths, so short-circuit.
  const a = Buffer.from(providedSig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "badsig" };
  }

  let decoded: { f?: string; x?: number };
  try {
    decoded = JSON.parse(unb64u(payload).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const fileId = String(decoded.f || "").trim();
  const expSec = Number(decoded.x);
  if (!fileId || !Number.isFinite(expSec)) {
    return { ok: false, reason: "malformed" };
  }
  if (Date.now() > expSec * 1000) {
    return { ok: false, reason: "expired", fileId };
  }
  return {
    ok: true,
    fileId,
    expiresAt: new Date(expSec * 1000).toISOString(),
  };
}

/**
 * Resolve who a token-authed action should be attributed to.
 *
 * The token names no person (one shared link per request), so the claim
 * arrives from the browser — and therefore has to be checked. The only
 * acceptable answers are the addresses the team actually sent to. With a
 * single recipient the claim is redundant and we just use that address,
 * which is why a one-client project never sees the "who is approving?"
 * question at all.
 */
export function resolveApprover(
  allowed: string[],
  claimed: string,
): { ok: true; email: string } | { ok: false; error: string } {
  const options = (allowed || [])
    .map((r) => String(r || "").toLowerCase().trim())
    .filter(Boolean);
  if (options.length === 1) return { ok: true, email: options[0] };
  const want = String(claimed || "").toLowerCase().trim();
  if (!want) return { ok: false, error: "נא לבחור מי מאשר את הפריסה" };
  if (!options.includes(want)) {
    return {
      ok: false,
      error: "הכתובת שנבחרה אינה מופיעה ברשימת הלקוחות של הפרויקט",
    };
  }
  return { ok: true, email: want };
}

/**
 * Who may be named as the approver — the addressees of the mail PLUS the
 * project's client roster from Keys.
 *
 * Recipients alone were too narrow: approval mail gets forwarded (one
 * live request's own note reads "יכולה להעביר את המייל לצרפתי"), so the
 * person who actually signs off is routinely not on the To: line, and
 * the picker made them sign under a colleague's name. Widening to the
 * roster gives up nothing — anyone holding the link could already
 * approve as any addressee, so this changes whose name gets recorded,
 * not who can act.
 *
 * Derived server-side on BOTH sides (the page renders it, the action
 * route re-derives it to validate) so a hand-crafted POST can't attribute
 * a decision to someone outside the project. A Keys read failure degrades
 * to recipients-only rather than emptying the list.
 */
export async function approverOptionsFor(
  req: PrisaApprovalRequest,
  subjectEmail: string,
): Promise<string[]> {
  const norm = (s: unknown) => String(s || "").toLowerCase().trim();
  const recipients = (req.recipients || []).map(norm).filter(Boolean);
  const roster = (
    await getProjectClientEmails(req.projectName, subjectEmail)
  ).map(norm);
  return [...recipients, ...roster]
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

/* ──────────────────────── request record (Firestore) ─────────────── */

/**
 * Does this token belong to the CURRENT send, or to an earlier one for
 * the same plan?
 *
 * The doc is keyed by fileId alone, so a re-send after a revision
 * overwrites it in place — but the tokens from the previous send stay
 * inside their own 14-day TTL and keep verifying. That matters because
 * the recipient list is the sole source of attribution: re-send to a
 * different set of people and an old link now resolves against the NEW
 * list. With a single new recipient the "who is approving?" question is
 * skipped entirely, so a dropped reviewer clicking their stale link gets
 * recorded as an approval by someone who never touched it.
 *
 * Each send stamps a fresh `expiresAt`, and the token carries that same
 * value in its signed payload — so comparing them is enough to tell the
 * generations apart. A re-send therefore revokes every prior link.
 * Compared at second granularity because the token stores Unix seconds
 * while the doc stores an ISO string with milliseconds.
 */
export function tokenMatchesRequest(
  tokenExpiresAt: string,
  req: PrisaApprovalRequest,
): boolean {
  const a = Math.floor(Date.parse(tokenExpiresAt) / 1000);
  const b = Math.floor(Date.parse(req.expiresAt) / 1000);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/**
 * Read the approval request for a plan. Soft-fails to null so a
 * Firestore outage degrades the badge rather than the page — same
 * posture as `getPrisotChangeRequest`.
 */
export async function getPrisaApprovalRequest(
  fileId: string,
): Promise<PrisaApprovalRequest | null> {
  const id = String(fileId || "").trim();
  if (!id) return null;
  try {
    const snap = await getDb()
      .collection(FS_COLLECTIONS.prisotApprovalRequests)
      .doc(id)
      .get();
    if (!snap.exists) return null;
    return (snap.data() as PrisaApprovalRequest) || null;
  } catch (e) {
    console.log(
      "[prisaApprovalTokens] read failed:",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

/**
 * True when the plan has an emailed approval request that is still
 * awaiting a decision — i.e. what the card should render as
 * "⏳ נשלח לאישור". Expired and already-resolved requests read false.
 */
export function isAwaitingApproval(
  req: PrisaApprovalRequest | null | undefined,
): boolean {
  // Deliberately NOT a `req is PrisaApprovalRequest` type predicate:
  // callers that already know `req` is non-null would get their else
  // branch narrowed to `never`, which is wrong (a non-null request can
  // absolutely be resolved or expired). Callers needing null-narrowing
  // check `req && isAwaitingApproval(req)`.
  if (!req) return false;
  if (req.resolution) return false;
  const exp = Date.parse(req.expiresAt);
  return !Number.isFinite(exp) || Date.now() <= exp;
}

/**
 * Record (or replace) the approval request for a plan. Re-sending after
 * a revision overwrites the previous doc — including clearing any prior
 * `resolution` — so the card shows the fresh pending state and the old
 * decision doesn't linger. Old tokens keep verifying until their own
 * expiry, which is fine: they point at the same fileId and the same
 * terminal lock.
 */
export async function putPrisaApprovalRequest(
  req: PrisaApprovalRequest,
): Promise<void> {
  const id = String(req.fileId || "").trim();
  if (!id) throw new Error("fileId required");
  await getDb()
    .collection(FS_COLLECTIONS.prisotApprovalRequests)
    .doc(id)
    // set WITHOUT merge — a re-send must not inherit the previous
    // resolution/resolvedBy fields.
    .set({ ...req, fileId: id });
}

/**
 * Record the Gmail thread a request's mail landed in, after the send.
 *
 * Separate from putPrisaApprovalRequest because the doc is written BEFORE
 * the mail goes out (so a fast click can't beat it) and the thread only
 * exists afterwards. Merges rather than replaces, and never throws: a
 * plan whose thread wasn't recorded simply starts a new conversation on
 * the next send, which is what happened before this existed.
 */
export async function attachPrisaApprovalThread(
  fileId: string,
  mail: { threadId: string; messageId: string; sentBy: string },
): Promise<void> {
  const id = String(fileId || "").trim();
  if (!id || !mail.threadId) return;
  try {
    await getDb()
      .collection(FS_COLLECTIONS.prisotApprovalRequests)
      .doc(id)
      .set(
        {
          emailThreadId: mail.threadId,
          emailMessageId: mail.messageId,
          emailSentBy: mail.sentBy.toLowerCase().trim(),
        },
        { merge: true },
      );
  } catch (e) {
    console.log(
      "[prisaApprovalTokens] thread write failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Remove the request entirely.
 *
 * Used when the approval email fails to send: the doc is written first
 * (so a fast click can't beat it), but if nothing actually goes out then
 * leaving it behind is worse than useless — it flips the card to
 * "⏳ נשלח לאישור" for a message nobody received, and pending is the one
 * state that used to hide the send button. Rolling the write back keeps
 * the card honest and the retry one click away.
 */
export async function deletePrisaApprovalRequest(
  fileId: string,
): Promise<void> {
  const id = String(fileId || "").trim();
  if (!id) return;
  try {
    await getDb()
      .collection(FS_COLLECTIONS.prisotApprovalRequests)
      .doc(id)
      .delete();
  } catch (e) {
    console.log(
      "[prisaApprovalTokens] rollback delete failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Stamp the outcome. Best-effort: the Drive lock (for "approved") and
 * the discussion post (for "changes") are the real side effects, and
 * neither should fail because Firestore hiccuped on the bookkeeping.
 */
export async function resolvePrisaApprovalRequest(opts: {
  fileId: string;
  resolution: "approved" | "changes";
  resolvedBy: string;
}): Promise<void> {
  const id = String(opts.fileId || "").trim();
  if (!id) return;
  try {
    // "approved" is terminal — the Drive file is locked, and that lock is
    // what the badge reads. A change-request arriving afterwards is real
    // news (it gets its own chip and a discussion post) but it must not
    // rewrite the record of who approved, nor make a second approve click
    // start erroring. Only a re-send clears an approval, by replacing the
    // whole doc.
    if (opts.resolution === "changes") {
      const cur = await getPrisaApprovalRequest(id);
      if (cur?.resolution === "approved") return;
    }
    await getDb()
      .collection(FS_COLLECTIONS.prisotApprovalRequests)
      .doc(id)
      .set(
        {
          resolution: opts.resolution,
          resolvedBy: String(opts.resolvedBy || "").toLowerCase().trim(),
          resolvedAt: new Date().toISOString(),
        },
        { merge: true },
      );
  } catch (e) {
    console.log(
      "[prisaApprovalTokens] resolve failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}
