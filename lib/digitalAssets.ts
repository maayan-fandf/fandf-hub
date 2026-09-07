import { cache } from "react";
import { unstable_cache } from "next/cache";
import { sheetsClient, driveFolderOwner } from "@/lib/sa";

/**
 * נכסים דיגיטליים — everything running for a project OUTSIDE the paid
 * campaigns, in one place, with the two facts that make a link list worth
 * looking at: what price it publishes, and whether anyone has checked it
 * lately.
 *
 * Four surfaces, all already populated:
 *
 *   דף נחיתה   Keys "Landing URL" — a cell can hold several
 *   יד2        Keys "yad2lookup" → the Yad2 affiliate sheet
 *   כתבה       Keys "בנפיט" → the media workbook's `benefit` tab
 *   מיניסייט   the second and later URLs of the landing cell
 *
 * The prices come from LANDING_PRICES, which a Puppeteer job rewrites
 * nightly (scripts/scrape-landing-prices.mjs). Reading that tab rather
 * than re-fetching the pages here is deliberate: those pages take 5–20
 * seconds each to render, which is not something a page load can pay, and
 * the job already does it once a night for the whole portfolio.
 *
 * The lead counts are NOT read here. They come from the CRM funnel the
 * section is rendered beside, where יד2 / כתבה / אתר החברה are already
 * channels — asking a second source for the same number is how two
 * numbers for one question get onto one screen.
 */

const TAB = "LANDING_PRICES";
/** The scrape runs nightly; anything fresher than this is the same
 *  answer, so the read is cached for an hour rather than per request. */
const TTL_SECONDS = 60 * 60;

export type AssetKind = "landing" | "yad2" | "article" | "minisite";

export type DigitalAsset = {
  kind: AssetKind;
  label: string;
  url: string;
  /** Published "starting from" price in NIS, or null when the page was
   *  read and carried none — which is a fact about the page, not a
   *  failure to look. */
  price: number | null;
  /** Every distinct price found, for the ones that list per-room. */
  allPrices: number[];
  /** Yad2 only: "sponsored" (a marketing page with a החל-מ anchor) vs
   *  "organic" (a per-apartment table with no headline). The two are not
   *  comparable and the UI must not put them side by side as if they
   *  were. */
  pageType: string;
};

export type DigitalAssets = {
  assets: DigitalAsset[];
  /** When the scrape last looked at this project. */
  checkedAt: string;
  /** The scraper's own verdict for the row: ok / no-price / fetch-error. */
  status: string;
  notes: string;
};

const num = (v: unknown): number | null => {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const list = (v: unknown): number[] =>
  String(v ?? "")
    .split("|")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);

/** The landing cell can hold several URLs. The first is the landing page
 *  proper; the rest are minisites / secondary pages, which is how Keys has
 *  been used in practice (לוריא carries /luria/ and /luria-total-package/). */
function splitUrls(cell: string): string[] {
  return String(cell ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

/** Read as the fixed owner identity, not as the viewer. The tab is one
 *  portfolio-wide table with no per-user content, so impersonating each
 *  reader would fragment the cache into one copy per person for an answer
 *  that is identical for all of them. */
const loadTab = unstable_cache(
  async (): Promise<Record<string, string>[]> => {
    const ssId = process.env.SHEET_ID_COMMENTS;
    if (!ssId) return [];
    const sheets = sheetsClient(driveFolderOwner());
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: `${TAB}!A1:Z400`,
    });
    const rows = (res.data.values ?? []) as unknown[][];
    if (rows.length < 2) return [];
    const header = rows[0].map((h) => String(h ?? "").trim());
    return rows.slice(1).map((r) => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => {
        o[h] = String(r[i] ?? "");
      });
      return o;
    });
  },
  ["digital-assets-landing-prices"],
  { revalidate: TTL_SECONDS, tags: ["landing-prices"] },
);

/**
 * One project's digital assets. Matched on the project NAME as the
 * scraper wrote it, which is the Keys name — the same string the rest of
 * the report is keyed on.
 *
 * Returns null when the scrape has no row for this project at all, which
 * the section renders as "not scanned yet" rather than as "no assets": a
 * project can be missing from the scrape because it carries no URL of any
 * kind, and those two states read very differently to whoever is asking.
 */
export const getDigitalAssets = cache(
  async (project: string): Promise<DigitalAssets | null> => {
    const rows = await loadTab().catch(() => []);
    const want = String(project ?? "").trim();
    const row = rows.find((r) => String(r.project ?? "").trim() === want);
    if (!row) return null;

    const assets: DigitalAsset[] = [];
    const landingUrls = splitUrls(row.landing_url);
    if (landingUrls[0]) {
      assets.push({
        kind: "landing",
        label: "דף נחיתה",
        url: landingUrls[0],
        price: num(row.headline_price),
        allPrices: list(row.all_prices),
        pageType: "",
      });
    }
    // Secondary landing URLs. Same scrape covers only the one that read,
    // so these carry the link without a price rather than repeating the
    // first page's number beside a different URL.
    for (const u of landingUrls.slice(1)) {
      assets.push({
        kind: "minisite",
        label: "מיניסייט",
        url: u,
        price: null,
        allPrices: [],
        pageType: "",
      });
    }
    if (row.yad2_url) {
      assets.push({
        kind: "yad2",
        label: "יד2",
        url: row.yad2_url,
        price: num(row.yad2_headline_price),
        allPrices: list(row.yad2_all_prices),
        pageType: String(row.yad2_page_type ?? ""),
      });
    }
    if (row.article_url) {
      assets.push({
        kind: "article",
        label: "כתבה",
        url: row.article_url,
        price: num(row.article_headline_price),
        allPrices: list(row.article_all_prices),
        pageType: "",
      });
    }
    if (!assets.length) return null;
    return {
      assets,
      checkedAt: String(row.scraped_at_iso ?? ""),
      status: String(row.status ?? ""),
      notes: String(row.notes ?? ""),
    };
  },
);
