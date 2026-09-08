/**
 * Thin Meta Marketing (Graph) API client.
 *
 * WHY THE HUB TALKS TO META AT ALL. Almost everything about Facebook ads
 * reaches this app second-hand — Supermetrics into the creatives workbook,
 * and Nadav's sync into the Supabase warehouse — and that is the right
 * arrangement for metrics, creatives and ad status, all of which those two
 * deliver well. This client exists for the one field neither of them has:
 * the ad's shareable PREVIEW link.
 *
 * The warehouse has no column for it (`permalink_url` is populated on 13 of
 * 4,715 rows; `effective_object_story_id` points at the organic post, which
 * is a different thing). Supermetrics did have it, in the
 * `כל מודעות פפיסבוק` tab — and that tab has been empty since its query grew
 * past what a refresh can finish, so every card in the hub lost its
 * "צפייה במודעה" link, not just the accounts the warehouse misses.
 *
 * `preview_shareable_link` on the Ad node returns a short `https://fb.me/…`
 * that opens the ad as it ran. Measured 2026-09-08: present on 4,938 of
 * 4,938 ads in the largest account, and every one sampled resolved 200.
 *
 * CREDENTIALS. `META_ACCESS_TOKEN` is a Business Manager SYSTEM USER token
 * (the `creativeintelbot` identity, which already holds asset access on all
 * 20 ad accounts) scoped to `ads_read`. Read lazily and never logged: a
 * module-level read would drag it into any bundle that type-imports from
 * here, which is the same trap lib/supabase.ts documents.
 */

const API_VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;

/** Page size. Meta caps `ads` at 500 and silently returns fewer under load;
 *  the cursor loop below does not care either way. */
export const PAGE_LIMIT = 500;

function token(): string {
  return (process.env.META_ACCESS_TOKEN || "").trim();
}

export function metaConfigured(): boolean {
  return !!token();
}

export class MetaGraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Meta's own error code, when it sent one — 190 is an invalid/expired
     *  token, 17 / 613 are rate limits. Kept so a caller can tell "stop, the
     *  token is dead" from "back off and retry". */
    readonly code?: number,
  ) {
    super(message);
    this.name = "MetaGraphError";
  }
}

/** True for the codes worth waiting out rather than failing on. */
function retryable(code?: number, status?: number): boolean {
  if (status === 429 || status === 500 || status === 503) return true;
  return code === 1 || code === 2 || code === 4 || code === 17 || code === 32 || code === 613;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One GET, with a bounded retry for Meta's throttles.
 *
 * The token is appended here rather than by callers so it appears in exactly
 * one place and cannot end up in a log line someone adds later — the URL is
 * never returned or thrown.
 */
async function get<T>(url: string, attempt = 0): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (res.ok) return body as T;
  const err = (body as { error?: { message?: string; code?: number } })?.error;
  const code = err?.code;
  if (retryable(code, res.status) && attempt < 3) {
    // Meta's rate limits are per app + account and clear on a scale of
    // minutes; three tries at 5s/15s/45s covers a transient throttle without
    // turning a dead token into a two-minute hang.
    await sleep([5000, 15000, 45000][attempt]);
    return get<T>(url, attempt + 1);
  }
  throw new MetaGraphError(
    err?.message || `Graph ${res.status}`,
    res.status,
    code,
  );
}

type Paged<T> = { data?: T[]; paging?: { next?: string } };

/**
 * Walk a Graph edge to the end, following Meta's own `paging.next` cursor.
 *
 * Cursor-following rather than offset paging on purpose: `limit`/`offset` on
 * the ads edge drifts when ads change mid-walk, and Meta's docs say so.
 * `next` already carries the token, so it is fetched as-is.
 */
export async function graphEdge<T>(
  path: string,
  params: Record<string, string | number>,
  opts: { maxPages?: number } = {},
): Promise<T[]> {
  const t = token();
  if (!t) throw new MetaGraphError("META_ACCESS_TOKEN is not set", 0);
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("access_token", t);

  const out: T[] = [];
  let next: string | null = url.toString();
  let pages = 0;
  const cap = opts.maxPages ?? 200;
  while (next && pages < cap) {
    const page: Paged<T> = await get<Paged<T>>(next);
    if (page.data?.length) out.push(...page.data);
    next = page.paging?.next ?? null;
    pages++;
  }
  return out;
}

export type MetaAdAccount = { account_id: string; name?: string };

/** Every ad account the token can see. The registry is Meta's own — the
 *  workbook's `Accounts lookup` tab lists 20 and the token sees 23, so
 *  asking Meta means a newly-added account is covered the night it appears
 *  rather than whenever someone remembers to update a sheet. */
export async function listAdAccounts(): Promise<MetaAdAccount[]> {
  return graphEdge<MetaAdAccount>("me/adaccounts", {
    fields: "account_id,name",
    limit: 200,
  });
}

/**
 * The pixel size asked of Meta for the creative thumbnail.
 *
 * `thumbnail_url` defaults to 64×64 — a 2KB image the report card blows up
 * to 284px, which is what "מפוקסל" looked like. The same field returns a
 * 1080×1080 / ~120KB render when the size is requested, and it costs
 * nothing extra: `creative.thumbnail_width(N).thumbnail_height(N){…}` is a
 * FIELD-level parameter, so it rides the one ads-edge call per account.
 * (Node-level `&thumbnail_width=` on the edge is silently ignored and
 * hands back the 64px default — measured both ways.)
 *
 * 1080 because that is Meta's own square creative spec; asking for more
 * would upscale rather than reveal detail.
 */
export const THUMB_PX = 1080;

export type MetaAd = {
  id: string;
  name?: string;
  effective_status?: string;
  preview_shareable_link?: string;
  campaign?: { name?: string };
  creative?: { thumbnail_url?: string };
};

/** Ads in one account, with the preview link. `updatedSince` (unix seconds)
 *  turns the nightly run into an incremental one — a full portfolio walk is
 *  ~30,600 ads and about four minutes, which does not fit a cron. */
export async function listAdsWithPreview(
  accountId: string,
  updatedSince?: number,
): Promise<MetaAd[]> {
  const params: Record<string, string | number> = {
    fields: "id,name,effective_status,preview_shareable_link,campaign{name}",
    limit: PAGE_LIMIT,
  };
  if (updatedSince) {
    params.filtering = JSON.stringify([
      {
        field: "ad.updated_time",
        operator: "GREATER_THAN",
        value: updatedSince,
      },
    ]);
  }
  return graphEdge<MetaAd>(`act_${accountId}/ads`, params);
}

/**
 * The 1080px creative render, for the RUNNING ads only.
 *
 * A SECOND PASS, and both halves of that are deliberate.
 *
 * Second, because expanding `creative{…}` inside the ads edge makes Meta
 * refuse the 500-ad page it happily serves without it — measured: the same
 * account returns 4,938 ads in 39s at limit=500 with the preview fields, and
 * answers `500 Please reduce the amount of data you're asking for` the moment
 * the creative is added. So the image cannot ride the preview walk; it needs
 * its own, at limit=100.
 *
 * Only the running ads, because at limit=100 the whole 30,585-ad archive
 * would take the better part of an hour — and would be wasted work. This URL
 * is a signed CDN address that expires within days; caching one for an ad
 * paused last year means storing a link that is dead before anyone opens the
 * card. Measured across the portfolio: 674 ACTIVE ads, every one of them
 * carrying a 1080 image, in 26 seconds. A paused ad keeps whatever the
 * warehouse has for it, which is the same picture it has today.
 */
export async function listActiveAdImages(
  accountId: string,
): Promise<{ id: string; image: string }[]> {
  const rows = await graphEdge<MetaAd>(`act_${accountId}/ads`, {
    fields:
      "id," +
      `creative.thumbnail_width(${THUMB_PX}).thumbnail_height(${THUMB_PX}){thumbnail_url}`,
    filtering: JSON.stringify([
      { field: "ad.effective_status", operator: "IN", value: ["ACTIVE"] },
    ]),
    limit: 100,
  });
  const out: { id: string; image: string }[] = [];
  for (const r of rows) {
    const image = String(r.creative?.thumbnail_url ?? "").trim();
    if (r.id && image) out.push({ id: String(r.id), image });
  }
  return out;
}
