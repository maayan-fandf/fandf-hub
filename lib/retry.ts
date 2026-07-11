/**
 * Small retry-with-backoff helper for the flaky upstreams the hub depends
 * on — the Apps Script `/exec` endpoint (headers-timeout + HTML-error-page
 * responses) and the Google Sheets API (429 / 5xx / transient network).
 * Both were silently `.catch(() => null)`'d at call sites, so a single
 * transient hiccup blanked whole sections. Retrying the transient ones
 * before that catch fires keeps the sections populated.
 */

/** Heuristic: is this error worth retrying (transient), vs a real failure
 *  (auth denied, bad request) that will fail again identically? */
export function isTransientError(e: unknown): boolean {
  const o = e as { message?: unknown; code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  const msg = String(o?.message ?? e ?? "");
  const code = String(o?.code ?? "");
  const status = Number(
    typeof o?.status === "number" ? o.status : o?.response?.status,
  );
  if (Number.isFinite(status) && (status === 429 || status >= 500)) return true;
  return /fetch failed|UND_ERR|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|timeout|aborted|abort|rate.?limit|quota|backend ?error|internal error|service is currently unavailable|try again|\b(429|500|502|503|504)\b|returned HTML|non-JSON|returned empty/i.test(
    `${msg} ${code}`,
  );
}

export type RetryOpts = {
  /** Extra attempts after the first (default 2 → 3 total). */
  retries?: number;
  /** First backoff, doubled each attempt, with jitter (default 350ms). */
  baseDelayMs?: number;
  /** Override the transient classifier. */
  retryable?: (e: unknown) => boolean;
  /** Called before each retry (attempt = the upcoming attempt, 1-based). */
  onRetry?: (e: unknown, attempt: number) => void;
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 350;
  const retryable = opts.retryable ?? isTransientError;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= retries || !retryable(e)) throw e;
      opts.onRetry?.(e, attempt + 1);
      const jitter = Math.floor(Math.random() * 150);
      await new Promise((r) => setTimeout(r, base * 2 ** attempt + jitter));
    }
  }
  throw lastErr;
}
