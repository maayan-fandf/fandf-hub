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
  created_time?: string;
  preview_shareable_link?: string;
  campaign?: { name?: string };
  adset?: { name?: string };
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
 * Meta's own city gazetteer, id → name, in Hebrew.
 *
 * WHY THIS EXISTS. A `custom_locations` pin arrives as bare coordinates —
 * "31.777523, 35.191956, 10 miles" — which is not information anyone can act
 * on. But every one of them (75 of 75, measured) also carries
 * `primary_city_id`, and this endpoint turns that into a name. With
 * `locale=he_IL` it answers in Hebrew: 1013481 → ירושלים,
 * 2673756 → מעלה אדומים.
 *
 * Batched deliberately: one call resolves every id in the portfolio, and the
 * result is small enough to hold for the length of an export run.
 */
export async function lookupCityNames(
  cityIds: string[],
): Promise<Record<string, string>> {
  const ids = [...new Set(cityIds.map((s) => String(s).trim()).filter(Boolean))];
  if (!ids.length) return {};
  const t = token();
  if (!t) throw new MetaGraphError("META_ACCESS_TOKEN is not set", 0);
  const out: Record<string, string> = {};
  // Chunked: the id list rides in the query string, and a portfolio-wide
  // call would otherwise build a URL long enough for Meta to reject.
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const url = new URL(`${BASE}/search`);
    url.searchParams.set("type", "adgeolocationmeta");
    url.searchParams.set("cities", JSON.stringify(chunk));
    url.searchParams.set("locale", "he_IL");
    url.searchParams.set("access_token", t);
    try {
      const res = await get<{
        data?: { cities?: Record<string, { name?: string }> };
      }>(url.toString());
      for (const [id, v] of Object.entries(res.data?.cities ?? {})) {
        const n = String(v?.name ?? "").trim();
        if (n) out[id] = n;
      }
    } catch {
      // A name is a nicety; the coordinate still renders. Never let the
      // gazetteer fail an export that has already done its real work.
    }
  }
  return out;
}

/** One geographic zone, in the shape the report needs to both LABEL it and
 *  DRAW it: a name for the line, and a point + radius for the minimap. */
export type MetaZone = {
  label: string;
  lat?: number;
  lon?: number;
  /** Radius in kilometres, normalised from Meta's miles-or-km. */
  radiusKm?: number;
  /** Meta's city id, when the zone came from a pin that carried one. */
  cityId?: string;
};

/** One ad set's targeting, flattened to what a report row can show. */
export type MetaAdSetTargeting = {
  id: string;
  name: string;
  campaign: string;
  effectiveStatus: string;
  ageMin: number;
  ageMax: number;
  /** "all" | "male" | "female" — Meta sends [1]=male, [2]=female, absent=all. */
  genders: string;
  /** Geographic zones — a label for the line, and geometry for the map. */
  zones: MetaZone[];
  /** "home" / "recent" — residents vs people recently there. */
  locationTypes: string[];
};

/** Meta's `genders` is an array of ints; absent means everyone. */
function gendersOf(v: unknown): string {
  const a = Array.isArray(v) ? v.map(Number) : [];
  if (!a.length || (a.includes(1) && a.includes(2))) return "all";
  if (a.includes(1)) return "male";
  if (a.includes(2)) return "female";
  return "all";
}

/**
 * Geographic zones, read from the fields F&F actually uses.
 *
 * THE TRAP THIS AVOIDS. Every example of Meta geo targeting reaches for
 * `geo_locations.cities` / `.regions` / `.countries`. Measured across all
 * 5,055 ad sets in the portfolio on 2026-09-08: those three are used by
 * ZERO of them. The targeting lives in `places` (a named pin with a radius —
 * "קטמונים ירושלים", 1 mile) and in `custom_locations` (the same thing with
 * no name, just a coordinate). Asking for cities/regions returns an empty
 * object and reads as "no geographic targeting" on a portfolio where 99.9%
 * of ad sets have some.
 *
 * The other four are still read, because nothing stops someone from
 * targeting a whole country tomorrow.
 */
function zonesOf(g: Record<string, unknown> | undefined): MetaZone[] {
  if (!g) return [];
  const out: MetaZone[] = [];
  /** Meta reports "mile" or "kilometer"; the map works in km. */
  const toKm = (r: unknown, u: unknown) => {
    const n = Number(r);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return String(u ?? "") === "mile" ? n * 1.60934 : n;
  };
  const label = (r: unknown, u: unknown) =>
    r ? ` (${r}${String(u ?? "") === "mile" ? "mi" : "km"})` : "";
  type Pin = {
    name?: string;
    radius?: number;
    distance_unit?: string;
    latitude?: number;
    longitude?: number;
    key?: string;
    primary_city_id?: number | string;
  };
  const pin = (p: Pin, name: string): MetaZone => ({
    label: `${name}${label(p.radius, p.distance_unit)}`,
    lat: Number.isFinite(Number(p.latitude)) ? Number(p.latitude) : undefined,
    lon: Number.isFinite(Number(p.longitude)) ? Number(p.longitude) : undefined,
    radiusKm: toKm(p.radius, p.distance_unit),
    cityId: p.primary_city_id != null ? String(p.primary_city_id) : undefined,
  });
  for (const p of (g.places as Pin[]) ?? []) out.push(pin(p, p.name || p.key || "?"));
  // No name of its own — the city id is resolved to one later, in the export,
  // where a single batched call can cover the whole portfolio. Until then the
  // coordinate stands in so the zone is never simply missing.
  for (const c of (g.custom_locations as Pin[]) ?? []) {
    const at =
      c.latitude != null && c.longitude != null
        ? `${Number(c.latitude).toFixed(3)},${Number(c.longitude).toFixed(3)}`
        : "?";
    out.push(pin(c, c.name || at));
  }
  for (const c of (g.cities as Pin[]) ?? []) out.push(pin(c, c.name || "?"));
  for (const r of (g.regions as Pin[]) ?? []) out.push({ label: String(r.name || r.key || "?") });
  // Meta returns an ISO code here. "IL" on a card is a riddle; "כל הארץ" is
  // the answer, and it is also the operationally important fact — a
  // country-wide ad set is a different animal from a 4-mile pin.
  for (const c of (g.countries as string[]) ?? []) {
    const code = String(c).toUpperCase();
    out.push({ label: COUNTRY_HE[code] ?? code });
  }
  return out;
}

/** Only the ones F&F actually targets; anything else keeps its ISO code,
 *  which is at least honest about being a code. */
const COUNTRY_HE: Record<string, string> = {
  IL: "כל הארץ",
  US: "ארצות הברית",
  GB: "בריטניה",
  FR: "צרפת",
  RU: "רוסיה",
  CA: "קנדה",
  AU: "אוסטרליה",
};

/**
 * Every ad set in one account, with its age range and geographic zones.
 *
 * `targeting` is requested WHOLE rather than with a subfield selection. Meta
 * returns only the keys an ad set actually sets, and the interesting ones
 * differ per account (`places` here, `custom_locations` there) — a fixed
 * subfield list quietly drops whatever it did not name. The object is small
 * and the walk is cheap either way.
 *
 * Measured 2026-09-08 across the whole portfolio: 5,055 ad sets over 23
 * accounts in 79 seconds at limit=200, 39 pages, zero failures — age present
 * on 100%, a geographic zone on 99.9%.
 */
export async function listAdSetTargeting(
  accountId: string,
  updatedSince?: number,
): Promise<MetaAdSetTargeting[]> {
  const params: Record<string, string | number> = {
    fields: "id,name,effective_status,campaign{name},targeting",
    limit: 200,
  };
  if (updatedSince) {
    params.filtering = JSON.stringify([
      { field: "adset.updated_time", operator: "GREATER_THAN", value: updatedSince },
    ]);
  }
  type Row = {
    id?: string;
    name?: string;
    effective_status?: string;
    campaign?: { name?: string };
    targeting?: {
      age_min?: number;
      age_max?: number;
      genders?: number[];
      geo_locations?: Record<string, unknown>;
    };
  };
  const rows = await graphEdge<Row>(`act_${accountId}/adsets`, params);
  const out: MetaAdSetTargeting[] = [];
  for (const r of rows) {
    if (!r.id) continue;
    const t = r.targeting ?? {};
    out.push({
      id: String(r.id),
      name: String(r.name ?? "").trim(),
      campaign: String(r.campaign?.name ?? "").trim(),
      effectiveStatus: String(r.effective_status ?? "").trim(),
      ageMin: Number(t.age_min ?? 0) || 0,
      ageMax: Number(t.age_max ?? 0) || 0,
      genders: gendersOf(t.genders),
      zones: zonesOf(t.geo_locations),
      locationTypes: ((t.geo_locations?.location_types as string[]) ?? []).map(String),
    });
  }
  return out;
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
/**
 * Ads CREATED in one account since a moment — everything a card needs, in a
 * single call.
 *
 * This is the one Graph shape the nightly cron cannot serve, and it exists
 * for a question the sheets structurally cannot answer: "did the ad I
 * launched ten minutes ago go up correctly?" Nothing upstream knows about
 * that ad yet — Supermetrics writes `facebook-ads-metrics` on a daily
 * trigger, the warehouse syncs nightly, and even our own fb-ad-previews
 * cron is once a day — so an on-demand pull is the only source.
 *
 * ONE CALL, unlike the cron's two. The cron has to split the creative into
 * its own walk because Meta refuses a 500-ad page with `creative{…}`
 * expanded (see listActiveAdImages). That limit is about page WEIGHT, not
 * about the field: at limit=50 over a couple of days' worth of ads the same
 * expansion is served without complaint. Measured 2026-09-08 across all 23
 * accounts at a 48-hour window: 20 ads, 675ms average per account, worst
 * case 1.8s, zero failures — and every ad came back with both its preview
 * link and its 1080px render.
 *
 * `ad.created_time` rather than `updated_time` on purpose. The cron wants
 * "what changed" so it can merge; a person pressing רענון wants "what is
 * new", and an edit to a month-old ad is not what they are checking.
 */
export async function listAdsCreatedSince(
  accountId: string,
  sinceUnix: number,
): Promise<MetaAd[]> {
  return graphEdge<MetaAd>(`act_${accountId}/ads`, {
    fields:
      "id,name,effective_status,created_time,preview_shareable_link," +
      "campaign{name},adset{name}," +
      `creative.thumbnail_width(${THUMB_PX}).thumbnail_height(${THUMB_PX}){thumbnail_url}`,
    filtering: JSON.stringify([
      { field: "ad.created_time", operator: "GREATER_THAN", value: sinceUnix },
    ]),
    limit: 50,
  });
}

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
