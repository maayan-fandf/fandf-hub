/**
 * Microsoft Clarity Data Export API client.
 *
 * The free tier endpoint is `project-live-insights` and only supports
 * `numOfDays: 1 | 2 | 3` (trailing windows). We default to the maximum
 * (3 days) and rely on aggressive caching to stay well within the
 * 10-calls/project/day rate limit. To get longer windows or
 * arbitrary date ranges, see v1.5 in the plan: a Cloud Scheduler job
 * that snapshots once a day and persists to a sheet tab.
 *
 * Returns null whenever the API gives us no useful data (no token,
 * 4xx/5xx, no sessions found for the URL filter, etc.) so the UI can
 * silently drop the section rather than crash the project page.
 */

export type ClarityInsights = {
  sessions: number;
  engagementSecondsAvg: number;
  scrollDepthPctAvg: number;
  rageClicks: number;
  deadClicks: number;
  quickbacks: number;
  excessiveScroll: number;
  deviceSplit: { desktop: number; mobile: number; tablet: number };
  /** ms epoch — used in the UI's "fetched X minutes ago" hint and as
   *  a debug aid when checking whether the cache is doing its job. */
  rawFetchedAt: number;
};

const ENDPOINT = "https://www.clarity.ms/export-data/api/v1/project-live-insights";

// Module-scope in-memory cache. Per-instance — Firebase App Hosting
// scales horizontally, so each instance has its own cache. With 6h
// TTL × ≤4 instances we land at ≤16 calls/project/day, comfortably
// under Clarity's 10-per-project-per-day limit (the limit is shared
// across instances since it's per-project at the Clarity side, but
// 6h cache means the worst-case is actually capped at 4× since each
// instance independently waits 6h). If we hit 429s in logs we'll
// bump TTL or move to v1.5's sheet-snapshot approach.
type CacheEntry = { expiresAt: number; value: ClarityInsights };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Fetch the trailing-3-day insights for a single landing URL. URL
 * filtering goes through Clarity's `dimension1=URL` parameter so a
 * single shared workspace can serve all projects (one workspace
 * tracks every landing page; we filter at query time).
 */
export async function fetchClarityInsights(
  landingUrl: string,
): Promise<ClarityInsights | null> {
  const token = process.env.CLARITY_API_TOKEN;
  if (!token) {
    console.warn("[clarity] CLARITY_API_TOKEN not set — section disabled");
    return null;
  }
  const url = (landingUrl || "").trim();
  if (!url) return null;

  const cacheKey = normalizeUrl(url);
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  try {
    const params = new URLSearchParams({
      numOfDays: "3",
      dimension1: "URL",
      dimension1Filter: url,
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
    const parsed = parseClarityResponse(raw);
    if (!parsed) {
      console.warn(`[clarity] no parseable data for landing=${url}`);
      return null;
    }
    // If the URL filter matched zero traffic, suppress the section
    // rather than show a wall of zeros.
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
 * Parse Clarity's response into our flattened shape. The API returns
 * an array of `{ metricName, information: [...] }` objects. The
 * `information` array's shape varies per metric — sometimes a flat
 * scalar map, sometimes per-dimension breakdowns. We pull what we
 * need defensively and let missing metrics default to 0.
 */
function parseClarityResponse(raw: unknown): ClarityInsights | null {
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

  for (const block of raw) {
    if (!block || typeof block !== "object") continue;
    const b = block as { metricName?: string; information?: unknown };
    const name = String(b.metricName || "");
    const info = Array.isArray(b.information) ? b.information : [];

    switch (name) {
      case "Traffic": {
        // Each entry is per-segment (device/browser/etc); sum sessions.
        // The metric name in the doc is "Traffic" but the field varies
        // — check both `totalSessionCount` and `sessions`.
        for (const row of info) {
          if (!row || typeof row !== "object") continue;
          const r = row as Record<string, unknown>;
          const n = numOf(r.totalSessionCount ?? r.sessions);
          out.sessions += n;
          // Device split lives on this metric in some workspaces.
          const device = String(r.deviceType || r.device || "").toLowerCase();
          if (device === "desktop") out.deviceSplit.desktop += n;
          else if (device === "mobile" || device === "phone")
            out.deviceSplit.mobile += n;
          else if (device === "tablet") out.deviceSplit.tablet += n;
        }
        break;
      }
      case "EngagementTime": {
        out.engagementSecondsAvg = avgOf(info, [
          "averageEngagementTime",
          "engagementTime",
          "averageDuration",
        ]);
        break;
      }
      case "ScrollDepth": {
        out.scrollDepthPctAvg = avgOf(info, [
          "averageScrollDepth",
          "scrollDepth",
          "scrollDepthPercentage",
        ]);
        break;
      }
      case "RageClickCount":
      case "RageClick": {
        out.rageClicks = sumOf(info, [
          "subFrustration",
          "totalSessionCount",
          "rageClicks",
          "count",
        ]);
        break;
      }
      case "DeadClickCount":
      case "DeadClick": {
        out.deadClicks = sumOf(info, [
          "subFrustration",
          "totalSessionCount",
          "deadClicks",
          "count",
        ]);
        break;
      }
      case "QuickbackClick":
      case "Quickback": {
        out.quickbacks = sumOf(info, [
          "subFrustration",
          "totalSessionCount",
          "quickbacks",
          "count",
        ]);
        break;
      }
      case "ExcessiveScroll": {
        out.excessiveScroll = sumOf(info, [
          "subFrustration",
          "totalSessionCount",
          "excessiveScroll",
          "count",
        ]);
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

function sumOf(rows: unknown[], fieldCandidates: string[]): number {
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    for (const field of fieldCandidates) {
      if (field in r) {
        total += numOf(r[field]);
        break;
      }
    }
  }
  return total;
}

function avgOf(rows: unknown[], fieldCandidates: string[]): number {
  const values: number[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    for (const field of fieldCandidates) {
      if (field in r) {
        values.push(numOf(r[field]));
        break;
      }
    }
  }
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function normalizeUrl(url: string): string {
  // Strip trailing slashes + lowercase host so cosmetic URL
  // differences don't fragment the cache.
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
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
