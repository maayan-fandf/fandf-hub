/**
 * Microsoft Clarity Data Export API client.
 *
 * The free-tier endpoint is `project-live-insights` with `numOfDays: 1|2|3`.
 * We default to 3 and rely on aggressive caching to stay under the
 * 10-calls/project/day rate limit. v1.5 (Cloud Scheduler daily snapshot
 * to a sheet tab) is the path to longer windows.
 *
 * The API supports `dimension1=URL` which breaks down each metric per
 * URL. The `dimension1Filter` parameter is silently ignored on the
 * free-tier endpoint (probed 2026-05-04 — passing it returns the same
 * 1000 rows as omitting it). So we ALWAYS request URL-broken-down data
 * and filter to the target URL client-side using path-level matching
 * (the `Url` field on each row includes UTM + fbclid query strings, so
 * exact-string matching never hits).
 *
 * Returns null whenever the API gives us no useful data (no token,
 * 4xx/5xx, no sessions for the URL, etc.) so the UI silently drops
 * the section rather than crash the project page.
 */

export type ClarityInsights = {
  sessions: number;
  engagementSecondsAvg: number;
  scrollDepthPctAvg: number;
  rageClicks: number;
  deadClicks: number;
  quickbacks: number;
  excessiveScroll: number;
  /** Device split is not available on the free-tier project-live-insights
   *  endpoint — kept on the type so the UI tile renders "—" instead of
   *  disappearing. Populated by future v1.5 snapshot job. */
  deviceSplit: { desktop: number; mobile: number; tablet: number };
  rawFetchedAt: number;
};

const ENDPOINT = "https://www.clarity.ms/export-data/api/v1/project-live-insights";

// Module-scope in-memory cache. Per-instance cache keyed by
// (token-suffix, normalized-target-url) so two projects sharing one
// workspace token but pointing at different landing pages don't collide.
type CacheEntry = { expiresAt: number; value: ClarityInsights };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Fetch the trailing-3-day insights for a single landing URL.
 *
 * Even when the workspace tracks multiple landing pages, we get all of
 * them in one API call (`dimension1=URL`) and filter client-side. That
 * means hitting two pages from the same workspace inside the cache
 * window only costs one upstream call (the second is a cache miss on
 * the URL key but we re-fetch — kept simple over premature optimization).
 */
export async function fetchClarityInsights(
  landingUrl: string,
  apiToken: string,
): Promise<ClarityInsights | null> {
  const token = (apiToken || "").trim();
  if (!token) return null;
  const url = (landingUrl || "").trim();
  if (!url) return null;

  const targetKey = pathKey(url);
  if (!targetKey) return null;

  const cacheKey = `${token.slice(-8)}|${targetKey}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  try {
    const params = new URLSearchParams({
      numOfDays: "3",
      dimension1: "URL",
    });
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(
        `[clarity] ${res.status} for landing=${url}: ${(await res
          .text()
          .catch(() => ""))
          .slice(0, 200)}`,
      );
      return null;
    }
    const raw = (await res.json().catch(() => null)) as unknown;
    const parsed = parseClarityResponse(raw, targetKey);
    if (!parsed) {
      console.warn(`[clarity] no parseable data for landing=${url}`);
      return null;
    }
    if (parsed.sessions === 0) return null;
    cache.set(cacheKey, { expiresAt: now + TTL_MS, value: parsed });
    return parsed;
  } catch (e) {
    console.warn(
      `[clarity] fetch failed for landing=${url}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/**
 * Aggregate Clarity's per-URL response into our flattened shape, keeping
 * only rows whose `Url` matches the target. URL matching compares
 * `pathKey()` (host + path, lowercased, no trailing slash, no query)
 * because Clarity stores the full URL with UTM + fbclid params on every
 * row.
 *
 * Per-block aggregation rules (response schema probed 2026-05-04):
 *   - Traffic:           sum totalSessionCount across matched rows
 *   - EngagementTime:    average activeTime (seconds) across matched rows
 *   - ScrollDepth:       average averageScrollDepth across matched rows
 *   - frustration metrics (RageClick / DeadClick / Quickback /
 *     ExcessiveScroll): sum subTotal (event count) across matched rows
 */
function parseClarityResponse(
  raw: unknown,
  targetKey: string,
): ClarityInsights | null {
  if (!Array.isArray(raw)) return null;

  const out: ClarityInsights = {
    sessions: 0,
    engagementSecondsAvg: 0,
    scrollDepthPctAvg: 0,
    rageClicks: 0,
    deadClicks: 0,
    quickbacks: 0,
    excessiveScroll: 0,
    deviceSplit: { desktop: 0, mobile: 0, tablet: 0 },
    rawFetchedAt: Date.now(),
  };

  const matchesTarget = (row: Record<string, unknown>): boolean => {
    const u = row.Url ?? row.URL ?? row.url ?? row.pageUrl;
    if (!u || typeof u !== "string") return false;
    return pathKey(u) === targetKey;
  };

  for (const block of raw) {
    if (!block || typeof block !== "object") continue;
    const b = block as { metricName?: string; information?: unknown };
    const name = String(b.metricName || "");
    const rows = (Array.isArray(b.information) ? b.information : []).filter(
      (r): r is Record<string, unknown> =>
        !!r && typeof r === "object" && matchesTarget(r as Record<string, unknown>),
    );

    switch (name) {
      case "Traffic": {
        for (const r of rows) out.sessions += numOf(r.totalSessionCount);
        break;
      }
      case "EngagementTime": {
        out.engagementSecondsAvg = avgField(rows, "activeTime");
        break;
      }
      case "ScrollDepth": {
        out.scrollDepthPctAvg = avgField(rows, "averageScrollDepth");
        break;
      }
      case "RageClickCount":
      case "RageClick": {
        for (const r of rows) out.rageClicks += numOf(r.subTotal);
        break;
      }
      case "DeadClickCount":
      case "DeadClick": {
        for (const r of rows) out.deadClicks += numOf(r.subTotal);
        break;
      }
      case "QuickbackClick":
      case "Quickback": {
        for (const r of rows) out.quickbacks += numOf(r.subTotal);
        break;
      }
      case "ExcessiveScroll": {
        for (const r of rows) out.excessiveScroll += numOf(r.subTotal);
        break;
      }
    }
  }

  return out;
}

function numOf(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function avgField(rows: Record<string, unknown>[], field: string): number {
  if (rows.length === 0) return 0;
  let sum = 0;
  let count = 0;
  for (const r of rows) {
    const n = numOf(r[field]);
    if (Number.isFinite(n)) {
      sum += n;
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Reduce a URL to "host+path" (lowercased, no trailing slash, no query
 * string, www. stripped). Used as the cache key suffix and as the
 * client-side filter key against Clarity's per-row `Url`. Returns "" on
 * unparseable input so callers can early-exit.
 */
function pathKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return url
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\?.*$/, "")
      .replace(/#.*$/, "")
      .replace(/\/+$/, "");
  }
}

/**
 * Build the Clarity dashboard URL for a specific filtered view —
 * used by the section header link so the user can deep-dive.
 * Falls back to the workspace root when the URL is unknown.
 */
export function clarityDashboardUrlForUrl(landingUrl: string): string {
  const url = (landingUrl || "").trim();
  if (!url) return "https://clarity.microsoft.com/";
  return `https://clarity.microsoft.com/projects?url=${encodeURIComponent(url)}`;
}
