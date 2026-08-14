/**
 * Google Analytics 4 Data API client (REST).
 *
 * Talks raw REST for the same reason `lib/clarity.ts` does: the
 * `googleapis` build vendored here ships no `analyticsdata` surface.
 * Auth is the hub's existing service account impersonating a real F&F
 * identity — see `analyticsAccessToken` in lib/sa.ts.
 *
 * ── The one constraint that shapes this whole file ──
 *
 * The REALTIME endpoint has no page-path dimension. Probed 2026-08-13
 * against property 472039720: `pagePath`, `landingPage` and
 * `unifiedPagePathScreen` are all rejected with 400; the only page-ish
 * dimension it accepts is `unifiedScreenName`, which for web returns the
 * page TITLE. `streamName` is accepted but useless here — a whole LP
 * domain is one stream (`/lp.s-sarfati.co.il/`), not one stream per LP.
 *
 * That matters because F&F landing pages share a domain: lp.g-dlevy.co.il
 * alone hosts /mia-beer-yaakov, /kenko, /orencbach-11-rishon-letzion and
 * six more. A property-level live count would be "everything this
 * developer runs", not "this project".
 *
 * So live numbers are scoped by page TITLE, and the title→path map is
 * derived from the CORE api (`pageTitle` x `pagePath`, last 7 days)
 * rather than hand-maintained. It re-derives on every refresh, so a
 * title edit heals itself within the cache window instead of silently
 * zeroing a project.
 *
 * ── Why pagePath and not landingPage ──
 *
 * `landingPage` is unusable on at least one live property. Measured over
 * 7 days on 472039720: landingPage attributed 845 users to `(not set)`
 * and 103 to empty, leaving 2 on /luria and 3 on /pisgat-zeev-nofarim.
 * The same window under `pagePath`: 228 on /luria/, 315 on
 * /luria-total-package/, 385 on /pisgat-zeev-nofarim/. So we use
 * `pagePath` throughout, which also matches what realtime counts
 * (events on a page, not session entry points).
 */

import { analyticsAccessToken } from "@/lib/sa";

const DATA_API = "https://analyticsdata.googleapis.com/v1beta";

/**
 * Deliberately no page-views field. `screenPageViews` is not dependable
 * on these landing pages — property 472039720 reported 546 users and 681
 * sessions over 7 days against 5 recorded views, i.e. `page_view` mostly
 * isn't firing. Showing a near-zero views figure next to a healthy user
 * count would read as a broken report; users + sessions are what these
 * properties actually record.
 */
export type Ga4Window = {
  users: number;
  sessions: number;
  /**
   * GA4 "key events" — the events the property owner marked as
   * conversions. On these landing pages that is typically
   * `generate_lead` / `Thankyoupage` / `c2c_2`.
   *
   * Tagging is per-property and NOT guaranteed: a property can have
   * obvious conversion events (`mida_conversion` fired 1,854 times on
   * 472039720 over 28 days) that nobody marked as key events, so this
   * reads 0 there.
   */
  keyEvents: number;
  /**
   * Key events across the WHOLE property, unattributed.
   *
   * Needed because `keyEvents` above being 0 has two very different
   * meanings, and showing a bare 0 for the second is a lie:
   *   - the property tags nothing        → keyEventsSite is 0 too
   *   - the property funnels every project through ONE shared thank-you
   *     page, so no conversion can be attributed to a single project →
   *     keyEventsSite is large.
   * Measured: 380361496 puts all 9 of its projects' 541 key events on a
   * single `/thank-you/`, and 402649067 does the same with 84. The UI
   * falls back to this figure labelled site-wide. See Ga4LiveClient.
   */
  keyEventsSite: number;
};

export type Ga4Live = {
  activeUsers: number;
  /** Key events in the same trailing-30-minute realtime window. */
  keyEvents: number;
  byDevice: { desktop: number; mobile: number; tablet: number };
  topCities: { city: string; users: number }[];
  /**
   * false when we could not scope to this project's pages and the number
   * is the whole property (i.e. every project on that domain). The UI
   * MUST label this — on a shared domain it is not the project's number.
   */
  scoped: boolean;
  fetchedAt: number;
};

/**
 * Normalize a page path for comparison: lowercase, no query/hash, no
 * trailing slash. GA4 returns real-world variants of the same page —
 * `/luria/` from pagePath vs `/luria` from landingPage, and a genuine
 * `/Luria-your-new-love-awaits/` alongside its lowercase twin — so every
 * comparison in this file goes through here.
 */
export function normPath(p: string): string {
  let s = (p || "").trim().toLowerCase();
  if (!s) return "";
  const q = s.search(/[?#]/);
  if (q >= 0) s = s.slice(0, q);
  s = s.replace(/\/+$/, "");
  return s || "/";
}

type ReportRow = {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
};

async function callGa4(
  subjectEmail: string,
  propertyId: string,
  method: "runReport" | "runRealtimeReport",
  body: Record<string, unknown>,
): Promise<ReportRow[]> {
  const token = await analyticsAccessToken(subjectEmail);
  const res = await fetch(`${DATA_API}/properties/${propertyId}:${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `ga4 ${method} ${res.status} on ${propertyId}: ${txt.slice(0, 200)}`,
    );
  }
  const json = (await res.json().catch(() => null)) as {
    rows?: ReportRow[];
  } | null;
  return json?.rows ?? [];
}

const num = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const dim = (r: ReportRow, i: number): string => r.dimensionValues?.[i]?.value ?? "";
const met = (r: ReportRow, i: number): number => num(r.metricValues?.[i]?.value);

/**
 * Page titles seen on any of `paths` in the last 7 days, used to scope
 * the realtime query. Returns lowercased titles for case-insensitive
 * matching.
 *
 * Cached for 6h: titles change when someone edits the page, which is
 * rare, and a stale entry costs at most one refresh window of a project
 * reading as unscoped.
 */
const titleCache = new Map<string, { expiresAt: number; titles: string[] }>();
const TITLE_TTL_MS = 6 * 60 * 60 * 1000;

export async function fetchTitlesForPaths(
  subjectEmail: string,
  propertyId: string,
  paths: string[],
): Promise<string[]> {
  const want = new Set(paths.map(normPath).filter(Boolean));
  if (want.size === 0) return [];
  const key = `${propertyId}|${[...want].sort().join(",")}`;
  const hit = titleCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.titles;

  // Ordered by activeUsers, NOT screenPageViews: page_view is unreliably
  // fired on these landing pages (measured on 472039720 — 546 users over
  // 7 days against 5 recorded views), so ranking by it would push real
  // pages past the row limit and lose their titles.
  const rows = await callGa4(subjectEmail, propertyId, "runReport", {
    dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
    dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
    metrics: [{ name: "activeUsers" }],
    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
    limit: 500,
  });
  const titles = new Set<string>();
  for (const r of rows) {
    if (!want.has(normPath(dim(r, 0)))) continue;
    const t = dim(r, 1).trim().toLowerCase();
    if (t) titles.add(t);
  }
  const out = [...titles];
  titleCache.set(key, { expiresAt: Date.now() + TITLE_TTL_MS, titles: out });
  return out;
}

/**
 * Live visitors on this project's pages, right now (GA4's realtime
 * window is the trailing 30 minutes).
 *
 * Two realtime calls: title x device and title x city. Both are needed
 * anyway for the breakdowns, and the device call doubles as the source
 * of the headline total.
 *
 * On summing: `activeUsers` is a unique-user metric, so summing it
 * across rows can double-count one visitor who appears under two
 * dimension values. Device is effectively disjoint per visitor inside a
 * 30-minute window so the total is safe; a visitor who opens TWO of the
 * project's own pages in that window would count twice, which on
 * single-page LPs is rare and always errs high by design rather than
 * silently dropping people.
 */
export async function fetchLive(
  subjectEmail: string,
  propertyId: string,
  paths: string[],
): Promise<Ga4Live> {
  const titles = await fetchTitlesForPaths(subjectEmail, propertyId, paths).catch(
    () => [] as string[],
  );
  const want = new Set(titles);

  const [deviceRows, cityRows] = await Promise.all([
    callGa4(subjectEmail, propertyId, "runRealtimeReport", {
      dimensions: [{ name: "unifiedScreenName" }, { name: "deviceCategory" }],
      metrics: [{ name: "activeUsers" }, { name: "keyEvents" }],
      limit: 250,
    }),
    callGa4(subjectEmail, propertyId, "runRealtimeReport", {
      dimensions: [{ name: "unifiedScreenName" }, { name: "city" }],
      metrics: [{ name: "activeUsers" }],
      limit: 250,
    }).catch(() => [] as ReportRow[]),
  ]);

  const mine = (r: ReportRow) => want.has(dim(r, 0).trim().toLowerCase());
  const matched = deviceRows.filter(mine);

  // No title map (or nobody on our pages) but the property has traffic →
  // report the property total and flag it unscoped rather than claim a
  // zero we can't stand behind.
  const scoped = want.size > 0;
  const rows = scoped ? matched : deviceRows;

  const byDevice = { desktop: 0, mobile: 0, tablet: 0 };
  let total = 0;
  let keyEvents = 0;
  for (const r of rows) {
    const users = met(r, 0);
    total += users;
    keyEvents += met(r, 1);
    const d = dim(r, 1).trim().toLowerCase();
    if (d === "desktop") byDevice.desktop += users;
    else if (d === "mobile") byDevice.mobile += users;
    else if (d === "tablet") byDevice.tablet += users;
  }

  const cityAgg = new Map<string, number>();
  for (const r of scoped ? cityRows.filter(mine) : cityRows) {
    const c = dim(r, 1).trim();
    if (!c || c === "(not set)") continue;
    cityAgg.set(c, (cityAgg.get(c) ?? 0) + met(r, 0));
  }
  const topCities = [...cityAgg.entries()]
    .map(([city, users]) => ({ city, users }))
    .sort((a, b) => b.users - a.users)
    .slice(0, 4);

  return {
    activeUsers: total,
    keyEvents,
    byDevice,
    topCities,
    scoped,
    fetchedAt: Date.now(),
  };
}

/**
 * Which dimension attributes a session to a project on this property.
 *
 * `landingPage` is the correct one and is what GA4's own Landing page
 * report uses — it credits a conversion back to the page the session
 * STARTED on, so a lead submitted on a shared `/thank-you/` still counts
 * for the project whose page brought the visitor in.
 *
 * But it is unavailable on properties that don't fire `page_view`: GA4
 * derives landingPage from that event, and the Mida platform fires
 * `mida_pageview` instead. Measured over 28 days:
 *
 *   402649067  (not set) 900 of ~3,400 sessions   → landingPage usable
 *   380361496  (not set) 417 of ~14,000           → landingPage usable
 *   533952214  (not set) 134 of ~14,200           → landingPage usable
 *   472039720  (not set) 14,000 of ~14,400 (97%)  → landingPage UNUSABLE
 *
 * So the mode is measured per property rather than assumed. Getting this
 * wrong is not cosmetic: on 380361496, landingPage credits
 * /mia-beer-yaakov with 286 key events while pagePath puts all 188 of
 * the domain's conversions on one unattributable `/thank-you/`.
 */
export type AttributionMode = "landingPage" | "pagePath";

const modeCache = new Map<string, { expiresAt: number; mode: AttributionMode }>();
const MODE_TTL_MS = 6 * 60 * 60 * 1000;

/** Share of sessions with no landing page above which we stop trusting it. */
const NOT_SET_LIMIT = 0.5;

export async function detectAttributionMode(
  subjectEmail: string,
  propertyId: string,
): Promise<AttributionMode> {
  const hit = modeCache.get(propertyId);
  if (hit && hit.expiresAt > Date.now()) return hit.mode;

  let mode: AttributionMode = "pagePath";
  try {
    const rows = await callGa4(subjectEmail, propertyId, "runReport", {
      dateRanges: [{ startDate: "28daysAgo", endDate: "today" }],
      dimensions: [{ name: "landingPage" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 200,
    });
    let total = 0;
    let unattributed = 0;
    for (const r of rows) {
      const v = dim(r, 0).trim();
      const s = met(r, 0);
      total += s;
      if (!v || v === "(not set)") unattributed += s;
    }
    if (total > 0 && unattributed / total < NOT_SET_LIMIT) mode = "landingPage";
  } catch {
    // Leave it on pagePath — the conservative choice, since pagePath is
    // populated on every property tested.
  }
  modeCache.set(propertyId, { expiresAt: Date.now() + MODE_TTL_MS, mode });
  return mode;
}

/**
 * Tokens that carry no project identity — stripped before deciding
 * whether a conversion page belongs to a project. Without this,
 * `/thank-you-luria/` and `/thank-you-nofarim/` would both match every
 * project on the property via the shared "thank"/"you" tokens, and two
 * projects sharing a domain would report each other's leads.
 *
 * Only used in `pagePath` mode — in `landingPage` mode GA has already
 * done the attribution properly and no token guessing is needed.
 */
const GENERIC_PATH_TOKENS = new Set([
  "thank", "thanks", "you", "thankyou", "todah", "toda", "success", "done",
  "home", "index", "main", "page", "pages", "form", "forms", "lead", "leads",
  "landing", "site", "www", "lp", "new", "old", "test", "temp",
]);

/**
 * Distinctive tokens for a project, taken from its own landing paths.
 * `/pisgat-zeev-nofarim` → {pisgat, zeev, nofarim}, which is what lets
 * `/thank-you-nofarim/` be recognised as that project's conversion page.
 * Tokens under 4 chars are dropped as too collision-prone.
 */
function pathTokens(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    for (const t of normPath(p).split(/[^a-z0-9֐-׿]+/)) {
      if (t.length >= 4 && !GENERIC_PATH_TOKENS.has(t)) out.add(t);
    }
  }
  return out;
}

/**
 * "Does a key event on this page belong to this project?"
 *
 * Exported because BOTH GA4 surfaces need the identical answer. The live
 * block counts client-side and the period report filters API-side, but if
 * they disagree the same project page shows a live conversion counter
 * ticking above a period section reporting none — which is exactly what
 * לוריא did before this was shared.
 *
 * In `landingPage` mode GA has already credited the conversion back to
 * the entry page, so ownership is plain set membership. In `pagePath`
 * mode the key event fires on a separate thank-you page that no column
 * links back to the project, so the link is distinctive-token overlap
 * with the project's own paths — generic tokens stripped, so two projects
 * sharing a domain cannot claim each other's leads.
 */
export function ownsConversionPath(
  mode: AttributionMode,
  paths: string[],
): (page: string) => boolean {
  const want = new Set(paths.map(normPath).filter(Boolean));
  const tokens = pathTokens(paths);
  return (page: string): boolean => {
    const norm = normPath(page);
    if (want.has(norm)) return true;
    if (mode === "landingPage") return false;
    return norm
      .split(/[^a-z0-9֐-׿]+/)
      .filter(Boolean)
      .some((t) => tokens.has(t));
  };
}

/**
 * Today-so-far and last-7-days totals for this project's pages.
 *
 * The dimension used is decided per property by `detectAttributionMode`:
 *
 * `landingPage` mode (the good case, 3 of 4 properties measured) — GA4
 * has already credited every session AND its conversions back to the
 * page the visit started on, which is exactly what GA's own Landing page
 * report shows. Nothing is guessed: /mia-beer-yaakov's 286 key events
 * over 28 days come straight from GA.
 *
 * `pagePath` mode (Mida properties, where landingPage is ~97% "(not
 * set)") — sessions can still be counted on the project's own paths, but
 * conversions cannot: every key event fires on a thank-you page and none
 * on the landing page itself (472039720: `/thank-you-luria/` 109,
 * `/thank-you-nofarim/` 107, `/luria/` 0). Counting only the landing
 * paths would report 0 leads for a project that produced 109. So in this
 * mode conversion pages are matched by distinctive-token overlap with
 * the project's own paths, and the matched pages are returned so the UI
 * can show exactly what was counted.
 *
 * Rows are fetched broadly and filtered client-side on `normPath`
 * instead of using an API-side filter, because GA4 filters match the raw
 * dimension value: `/luria/` and `/Luria-your-new-love-awaits/` both
 * exist on one property and an exact-match filter would miss them. Same
 * reasoning as the client-side URL filter in lib/clarity.ts.
 */
export async function fetchWindows(
  subjectEmail: string,
  propertyId: string,
  paths: string[],
): Promise<{
  today: Ga4Window;
  last7: Ga4Window;
  mode: AttributionMode;
  /** Extra conversion pages credited to this project (pagePath mode only). */
  conversionPaths: string[];
}> {
  const want = new Set(paths.map(normPath).filter(Boolean));
  const tokens = pathTokens(paths);
  const conversionPaths = new Set<string>();
  const mode = await detectAttributionMode(subjectEmail, propertyId);

  // In landingPage mode GA has done the attribution properly, so a
  // conversion counts for this project exactly when the session started
  // on one of its pages — no token guessing. In pagePath mode the
  // conversion lives on a separate thank-you page, so fall back to
  // distinctive-token overlap. Generic tokens are excluded above, so two
  // projects sharing a domain cannot claim each other's leads.
  const ownsConversion = (p: string): boolean => {
    const norm = normPath(p);
    if (want.has(norm)) return true;
    if (mode === "landingPage") return false;
    const parts = norm.split(/[^a-z0-9֐-׿]+/).filter(Boolean);
    return parts.some((t) => tokens.has(t));
  };

  const query = (startDate: string) =>
    callGa4(subjectEmail, propertyId, "runReport", {
      dateRanges: [{ startDate, endDate: "today" }],
      dimensions: [{ name: mode }],
      metrics: [
        { name: "activeUsers" },
        { name: "sessions" },
        { name: "keyEvents" },
      ],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 500,
    });

  const [todayRows, weekRows] = await Promise.all([
    query("today"),
    query("7daysAgo"),
  ]);

  const sum = (rows: ReportRow[], collect: boolean): Ga4Window => {
    const out = { users: 0, sessions: 0, keyEvents: 0, keyEventsSite: 0 };
    for (const r of rows) {
      const path = normPath(dim(r, 0));
      if (want.has(path)) {
        out.users += met(r, 0);
        out.sessions += met(r, 1);
      }
      // keyEvents is a plain count, so summing across pages is exact —
      // unlike activeUsers, which is a unique-user metric.
      const ke = met(r, 2);
      if (ke <= 0) continue;
      out.keyEventsSite += ke;
      if (ownsConversion(path)) {
        out.keyEvents += ke;
        if (collect && !want.has(path)) conversionPaths.add(path);
      }
    }
    return out;
  };

  // Collect the credited conversion pages from the 7-day window — the
  // today window is often empty and would leave the source line blank.
  const last7 = sum(weekRows, true);
  return {
    today: sum(todayRows, false),
    last7,
    mode,
    conversionPaths: [...conversionPaths],
  };
}
