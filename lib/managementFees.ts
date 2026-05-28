import { createHash } from "node:crypto";
import { unstable_cache, revalidateTag } from "next/cache";
import { getDb, FS_COLLECTIONS } from "@/lib/firestore";

/**
 * Per-(project-slug, channel) management-fee overrides for the
 * /morning/forecast page.
 *
 * Storage: one Firestore doc per (slug, channel) keyed by
 * sha1(`${slug.lc}__${channel.lc}`) so Hebrew channel names don't
 * blow up Firestore's id charset. Default fee is 15% — the page
 * applies the default when no doc exists, so the storage stays
 * sparse (only rows the admin has explicitly edited get a doc).
 *
 * Read path: list-all-once at page render, build an in-memory map,
 * look up by (slug, channel) per row. Cached for 60s via
 * unstable_cache so a busy admin browsing the page doesn't slam
 * Firestore — invalidate on every write so the new value is
 * visible on the very next render.
 */

const FEES_CACHE_TAG = "managementFees";
const DEFAULT_FEE_PERCENT = 15;

export type ManagementFee = {
  /** Lower-cased project slug. */
  slug: string;
  /** Lower-cased channel name. */
  channel: string;
  /** Percent value (e.g. 15 for 15%). */
  percent: number;
  /** ISO timestamp of the last write. */
  updatedAt: string;
  /** Email of the admin who set this override. */
  updatedBy: string;
};

export function docIdForFee(slug: string, channel: string): string {
  const key = `${slug.toLowerCase().trim()}__${channel.toLowerCase().trim()}`;
  return createHash("sha1").update(key).digest("hex");
}

async function fetchAllFeesUncached(): Promise<ManagementFee[]> {
  try {
    const db = getDb();
    const snap = await db.collection(FS_COLLECTIONS.managementFees).get();
    const out: ManagementFee[] = [];
    snap.forEach((d) => {
      const data = d.data() as Partial<ManagementFee>;
      if (!data) return;
      const slug = String(data.slug || "").toLowerCase().trim();
      const channel = String(data.channel || "").toLowerCase().trim();
      const percent = Number(data.percent);
      if (!Number.isFinite(percent)) return;
      out.push({
        slug,
        channel,
        percent,
        updatedAt: String(data.updatedAt || ""),
        updatedBy: String(data.updatedBy || ""),
      });
    });
    return out;
  } catch (e) {
    // Soft-fail: page renders with default 15% for every row when
    // Firestore is unreachable instead of crashing the whole page.
    console.log(
      "[managementFees] readAll failed (using defaults):",
      e instanceof Error ? e.message : String(e),
    );
    return [];
  }
}

const fetchAllFeesCached = unstable_cache(
  fetchAllFeesUncached,
  ["managementFees:all"],
  { revalidate: 60, tags: [FEES_CACHE_TAG] },
);

/** Return a Map keyed by `${slug}__${channel}` (both lowercased) →
 *  percent. Use {@link getFeePercentForRow} for a single-row lookup
 *  with the default applied. */
export async function readAllManagementFees(): Promise<Map<string, number>> {
  const all = await fetchAllFeesCached();
  const m = new Map<string, number>();
  for (const f of all) {
    m.set(`${f.slug}__${f.channel}`, f.percent);
  }
  return m;
}

/** Look up a single (slug, channel) fee from a map produced by
 *  {@link readAllManagementFees}. Returns the default 15% when no
 *  override exists. Pure / sync — pass the prebuilt map. */
export function getFeePercentForRow(
  feeMap: Map<string, number>,
  slug: string,
  channel: string,
): number {
  const k = `${slug.toLowerCase().trim()}__${channel.toLowerCase().trim()}`;
  const v = feeMap.get(k);
  return Number.isFinite(v) ? (v as number) : DEFAULT_FEE_PERCENT;
}

export { DEFAULT_FEE_PERCENT };

/**
 * Upsert one (slug, channel) → percent override. Sanitizes the input
 * and writes the full ManagementFee shape (so the same fields exist
 * on every doc whether it was inserted or updated). Invalidates the
 * cache tag immediately so the next page render sees the new value.
 */
export async function upsertManagementFee(args: {
  slug: string;
  channel: string;
  percent: number;
  updatedBy: string;
}): Promise<ManagementFee> {
  const slug = args.slug.toLowerCase().trim();
  const channel = args.channel.toLowerCase().trim();
  if (!slug || !channel) {
    throw new Error("slug and channel are required");
  }
  let percent = Number(args.percent);
  if (!Number.isFinite(percent)) percent = DEFAULT_FEE_PERCENT;
  // Sanity clamp — a 0-100% fee is the realistic range; anything
  // outside is almost certainly a typo. Allow 0 because some clients
  // pay no fee (e.g. F&F's own internal projects).
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  // Round to one decimal place so the UI doesn't end up storing
  // 14.999999999 etc. from floating-point math.
  percent = Math.round(percent * 10) / 10;

  const updatedAt = new Date().toISOString();
  const doc: ManagementFee = {
    slug,
    channel,
    percent,
    updatedAt,
    updatedBy: args.updatedBy || "",
  };
  const db = getDb();
  await db
    .collection(FS_COLLECTIONS.managementFees)
    .doc(docIdForFee(slug, channel))
    .set(doc, { merge: true });
  revalidateTag(FEES_CACHE_TAG);
  return doc;
}
