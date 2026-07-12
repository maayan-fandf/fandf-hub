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

/** Separate flag for the Sehel warehouse funnel (sehel_leads_daily /
 *  sehel_touches / sehel_meetings). Kept independent of the always-on BMBY
 *  flag so Sehel projects can be verified + rolled out on their own — ships
 *  "0" until the warehouse numbers are cross-checked against the Sheet. */
export function useSupabaseSehelWarehouse(): boolean {
  return String(process.env.SUPABASE_SEHEL_WAREHOUSE || "").trim() === "1";
}

/** Optional canary allowlist — a BASE64-encoded comma-separated list of
 *  Keys.CRM account names. When non-empty, enrichment runs ONLY for those
 *  projects (even with the master flag on); empty/unset = all bmby projects.
 *
 *  Why base64: the App Hosting → Cloud Run env pipeline corrupts non-ASCII
 *  values (Hebrew project names came through as "?"), so the list is encoded
 *  to ASCII and decoded here. Regenerate with:
 *    node -e "console.log(Buffer.from('נתיבות,רעננה קנקו').toString('base64'))" */
export function supabaseCrmProjectAllowed(crmAccount: string): boolean {
  const raw = String(process.env.SUPABASE_CRM_PROJECTS || "").trim();
  if (!raw) return true;
  let list = raw;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    if (decoded.trim()) list = decoded;
  } catch {
    /* fall back to the raw value (plain ASCII list) */
  }
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(crmAccount.trim());
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Like supabaseRows but follows PostgREST pagination (Range headers)
 *  until the result set is exhausted — for queries that can exceed the
 *  1000-row default cap (e.g. a project's full meeting history or a
 *  high-volume project's monthly leads). `maxRows` is a safety valve so a
 *  runaway filter can't page forever.
 *
 *  Each page is retried on a transient error (HTTP 429 / 5xx / network
 *  throw) with exponential backoff. This matters because the per-creative
 *  meetings export pages many projects back-to-back and can get rate-
 *  limited mid-run; without the retry, a single throttled page silently
 *  returned partial/empty and the export wrote "0 meetings" over good data
 *  (kenko Feb 2026 lost all scheduled/held this way). On a NON-transient
 *  4xx or after exhausting retries, returns whatever it has so far
 *  (preserves the graceful-degrade contract callers rely on). */
export async function supabaseRowsAll<T = Record<string, unknown>>(
  path: string,
  opts?: { pageSize?: number; maxRows?: number },
): Promise<T[]> {
  const pageSize = opts?.pageSize ?? 1000;
  const maxRows = opts?.maxRows ?? 20000;
  const out: T[] = [];
  for (let start = 0; start < maxRows; start += pageSize) {
    let page: T[] | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await supabaseFetch(path, {
          extraHeaders: { Range: `${start}-${start + pageSize - 1}` },
        });
        if (res.ok) {
          const j = await res.json();
          page = Array.isArray(j) ? (j as T[]) : [];
          break;
        }
        // Retry throttling / transient server errors; bail on other 4xx.
        if (res.status === 429 || res.status >= 500) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        return out;
      } catch {
        await sleep(300 * 2 ** attempt);
      }
    }
    if (page === null) break; // exhausted retries — return what we have
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}
