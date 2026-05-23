import { unstable_cache } from "next/cache";

/**
 * Live USD→ILS rate for the budget desk: Taboola/Outbrain budgets are
 * tracked in ILS (Supermetrics-normalized) but set in the platform in
 * USD, so the "פתח + העתק" copies the required daily budget in USD.
 *
 * Source: open.er-api.com (free, no API key, daily ECB-ish rates).
 * Cached 12h; falls back to a sane constant if the fetch fails so a
 * network blip never breaks the desk.
 */

const FALLBACK_USD_ILS = 3.7;

async function fetchUsdIls(): Promise<number> {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      // Revalidate daily at the data layer too; unstable_cache wraps this.
      next: { revalidate: 43200 },
    });
    if (!res.ok) return FALLBACK_USD_ILS;
    const data = (await res.json()) as { rates?: { ILS?: number } };
    const ils = data?.rates?.ILS;
    return typeof ils === "number" && ils > 0 && ils < 100 ? ils : FALLBACK_USD_ILS;
  } catch {
    return FALLBACK_USD_ILS;
  }
}

const getUsdIlsRateCached = unstable_cache(fetchUsdIls, ["usdIlsRate"], {
  revalidate: 43200, // 12h
  tags: ["usdIlsRate"],
});

/** USD→ILS rate (e.g. 3.72 means 1 USD = 3.72 ILS). Divide an ILS amount
 *  by this to get USD. */
export async function getUsdIlsRate(): Promise<number> {
  try {
    return await getUsdIlsRateCached();
  } catch {
    return FALLBACK_USD_ILS;
  }
}
