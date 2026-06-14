/**
 * Server-only thin PostgREST client for the BMBY warehouse (Supabase
 * project zkuzyxrkqjtramucjhid). Mirrors lib/sa.ts: lazy env read, no
 * SDK, and NO top-level secret access — so a type-only import elsewhere
 * can never drag the key into a client bundle. Consumed by
 * lib/crmEnrichment.ts to attach authoritative held / (later) speed-to-
 * lead / objections onto the CRM funnel for bmby-platform projects.
 *
 * Access (see bmby-supabase-integration-plan.md §12.2): local dev uses
 * SUPABASE_SERVICE_ROLE_KEY from .env.local; prod will use the read-only
 * key Nadav provisions — set it as SUPABASE_CRM_KEY (preferred over the
 * service_role fallback) so service_role never ships to App Hosting.
 */

const DEFAULT_BASE = "https://zkuzyxrkqjtramucjhid.supabase.co/rest/v1/";

function baseUrl(): string {
  const u = (process.env.SUPABASE_URL || DEFAULT_BASE).trim();
  return u.endsWith("/") ? u : u + "/";
}

function apiKey(): string {
  // Prefer a dedicated (read-only) key; fall back to the service_role
  // key used for local dev + probes.
  return (
    process.env.SUPABASE_CRM_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  ).trim();
}

/** Feature flag — enrichment stays dormant until explicitly enabled
 *  (ships "0" in prod; "1" locally). Same idiom as lib/sa.ts useSA*. */
export function useSupabaseCrmEnrichment(): boolean {
  return String(process.env.SUPABASE_CRM_ENRICHMENT || "").trim() === "1";
}

/** True when we have a key to reach the warehouse at all. */
export function supabaseConfigured(): boolean {
  return !!apiKey();
}

function authHeaders(): Record<string, string> {
  const k = apiKey();
  return { apikey: k, Authorization: `Bearer ${k}` };
}

/** Raw GET against a PostgREST path (e.g. "v_bmby_journey_meetings?..."). */
export async function supabaseFetch(
  path: string,
  init?: { extraHeaders?: Record<string, string> },
): Promise<Response> {
  return fetch(baseUrl() + path, {
    headers: { ...authHeaders(), ...(init?.extraHeaders || {}) },
    cache: "no-store", // caching is done one layer up via unstable_cache
  });
}

/** Exact row count for a filtered query, via the Content-Range header
 *  (Prefer: count=exact + Range 0-0 so no rows are pulled). Returns null
 *  on any error so callers degrade gracefully. */
export async function supabaseCount(pathWithSelect: string): Promise<number | null> {
  try {
    const res = await supabaseFetch(pathWithSelect, {
      extraHeaders: { Prefer: "count=exact", Range: "0-0" },
    });
    const cr = res.headers.get("content-range"); // "0-0/1234" | "*/0"
    if (!cr) return null;
    const n = Number(cr.split("/")[1]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** JSON rows for a query. Caller keeps result sets small via filters;
 *  returns [] on error. */
export async function supabaseRows<T = Record<string, unknown>>(
  path: string,
): Promise<T[]> {
  try {
    const res = await supabaseFetch(path);
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j) ? (j as T[]) : [];
  } catch {
    return [];
  }
}
