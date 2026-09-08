import { unstable_cache } from "next/cache";
import { sheetsClient, driveFolderOwner } from "@/lib/sa";
import { buildMatchMap, matchSlug } from "@/lib/campaignMatch";
import { listAdsCreatedSince, metaConfigured, MetaGraphError } from "@/lib/metaGraph";
import type { ReportFbAd } from "@/lib/reportShared";

/**
 * "מודעות שעלו עכשיו" — the on-demand pull behind the רענון button on the
 * Facebook creatives block.
 *
 * WHY THIS CANNOT BE A CACHE BUST. The obvious implementation of a refresh
 * button — re-read the sources, skip the cache — returns nothing, because
 * the ad is in none of the sources yet. A creative card is born from
 * `facebook-ads-metrics` (Supermetrics, daily trigger) or from the
 * `facebook-ads-assets 365` tab, with the Supabase warehouse (nightly) as a
 * backfill and our own fb-ad-previews cron (nightly) adding only the link
 * and the image to cards that ALREADY exist. An ad launched ten minutes ago
 * appears in none of them, and `fillAssetsFromWarehouse` is explicitly
 * forbidden from inventing card identities. So the only way to answer
 * "did my ad go up?" is to ask Meta.
 *
 * WHICH ACCOUNT. The hub has no project → ad-account-id mapping: every
 * project scoping in the app is campaign-NAME matching against the Keys
 * `campaign ID` column. Rather than build a new mapping — the
 * `Accounts lookup` tab pairs FB account names with ids, but nothing reads
 * that half of it and the join would be on Hebrew display names — this
 * derives the account from data the hub already has. The fb-ad-previews tab
 * carries `account_id` beside `campaign` on every row, so the project's
 * accounts are just the distinct ids on rows whose campaign passes the same
 * `mine()` predicate the report uses. Measured 2026-09-08: 49 of the 50
 * projects that have a campaign ID resolve, 5 of them to two accounts.
 *
 * The one project it cannot resolve is one that has never run a Facebook ad,
 * and that is exactly the case where there is no "already shown" to compare
 * against — so it falls back to asking every account the token can see.
 */

const TAB = "fb-ad-previews";

/** How far back "just launched" reaches. Three days rather than one: the
 *  cron runs nightly, so anything newer than the last run is by definition
 *  missing, and a Friday launch should still be catchable on Sunday. */
export const DEFAULT_HOURS = 72;
const MAX_HOURS = 24 * 14;

export type FbNewAdsResult = {
  ads: ReportFbAd[];
  /** Ad accounts actually queried. */
  accounts: string[];
  /** True when no account could be derived and every visible account was
   *  swept instead — the slow path, worth saying out loud in the UI. */
  sweptAll: boolean;
  hours: number;
  /** Accounts that errored, so a partial answer never passes as a whole one. */
  failed: { accountId: string; error: string }[];
};

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

/**
 * slug → the ad accounts that slug's campaigns live in.
 *
 * Cached 30 minutes and keyed on nothing but the subject: the underlying
 * read is the whole 30k-row previews tab, and the answer — which account a
 * project advertises in — changes on the scale of quarters, not minutes.
 * Built for EVERY project in one pass so twenty project pages share one read.
 */
const accountsBySlugCached = unstable_cache(
  async (subjectEmail: string): Promise<Record<string, string[]>> => {
    const matchMap = await buildMatchMap(subjectEmail);
    const sheets = sheetsClient(subjectEmail);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId:
        process.env.SHEET_ID_CREATIVES ||
        "1q-WFtFLDnltznwYKax2yZ1O-q_VToULWN8-sn-8xXuA",
      range: `'${TAB}'!A:H`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const vals = (res.data.values ?? []) as unknown[][];
    if (vals.length < 2) return {};
    const hdr = (vals[0] as unknown[]).map((h) => clean(h));
    const iCamp = hdr.indexOf("campaign");
    const iAcct = hdr.indexOf("account_id");
    if (iCamp < 0 || iAcct < 0) return {};

    // Counted, not just collected: a project can have a stray row in a
    // second account (a campaign that was moved, a one-off test), and the
    // count is what lets the caller keep the real account first.
    const counts = new Map<string, Map<string, number>>();
    for (let r = 1; r < vals.length; r++) {
      const camp = clean(vals[r][iCamp]);
      const acct = clean(vals[r][iAcct]);
      if (!camp || !acct) continue;
      const slug = matchSlug(camp, matchMap);
      if (!slug) continue;
      let m = counts.get(slug);
      if (!m) counts.set(slug, (m = new Map()));
      m.set(acct, (m.get(acct) ?? 0) + 1);
    }
    const out: Record<string, string[]> = {};
    for (const [slug, m] of counts) {
      out[slug] = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
    }
    return out;
  },
  ["fbNewAds:accountsBySlug"],
  { revalidate: 1800, tags: ["fbNewAdsAccounts"] },
);

/** Meta's `created_time` is `2026-09-06T16:44:00+0300` — ISO-ish but with a
 *  compact offset Date can still parse. Reduced to a plain date for display. */
function isoDate(v: unknown): string {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

/** Days since creation, floored at 0 — the card's ageDays field. */
function ageDays(v: unknown): number {
  const t = Date.parse(String(v ?? ""));
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/**
 * The ads created in the last `hours` that belong to this project and are
 * not already on the page.
 *
 * `knownKeys` is the set of `campaign|ad` keys the page is already showing,
 * lowercased by the caller with the report's own cardKey rules. Filtering
 * here rather than in the browser keeps the answer honest: the button says
 * how many NEW ads it found, and an ad the page already shows is not one.
 */
export async function getNewFbAdsForProject(opts: {
  subjectEmail: string;
  slug: string;
  hours?: number;
  knownKeys?: Set<string>;
  /** Preview links resolve only for a viewer with a Business Manager session
   *  on the account, so they are staff-only — same rule NativeProjectRail
   *  applies to the cards it renders. */
  withPreviews: boolean;
}): Promise<FbNewAdsResult> {
  const { subjectEmail, slug, knownKeys, withPreviews } = opts;
  if (!metaConfigured()) throw new Error("META_ACCESS_TOKEN is not set");

  const hours = Math.min(MAX_HOURS, Math.max(1, opts.hours || DEFAULT_HOURS));
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const slugLower = slug.toLowerCase();

  const bySlug = await accountsBySlugCached(subjectEmail);
  let accounts = bySlug[slugLower] ?? [];
  let sweptAll = false;
  if (!accounts.length) {
    // Never advertised on Facebook, or advertises under a campaign name the
    // Keys patterns miss. 23 accounts is ~15s — slow for a button, but this
    // is the path where the alternative is an empty answer with no reason.
    const { listAdAccounts } = await import("@/lib/metaGraph");
    accounts = (await listAdAccounts()).map((a) => clean(a.account_id)).filter(Boolean);
    sweptAll = true;
  }

  const matchMap = await buildMatchMap(subjectEmail);
  const failed: { accountId: string; error: string }[] = [];
  const ads: ReportFbAd[] = [];
  const seen = new Set<string>();

  for (const accountId of accounts) {
    let rows;
    try {
      rows = await listAdsCreatedSince(accountId, since);
    } catch (e) {
      failed.push({
        accountId,
        error:
          e instanceof MetaGraphError
            ? `${e.status}${e.code ? `/${e.code}` : ""} ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
      });
      continue;
    }

    for (const r of rows) {
      const campaign = clean(r.campaign?.name);
      const ad = clean(r.name);
      if (!campaign || !ad) continue;

      // Three outcomes, and the middle one is the point of the feature.
      // Matches THIS project → ours. Matches ANOTHER project → someone
      // else's ad that happens to share our account; showing it here would
      // be a leak of the wrong kind, so it is dropped. Matches NOTHING →
      // a campaign nobody has added to Keys yet, which is precisely the
      // "just launched" case the sheets are blind to. Those are shown,
      // flagged, because a campaign missing from Keys is itself the defect
      // an account manager is checking for.
      const matched = matchSlug(campaign, matchMap);
      if (matched && matched !== slugLower) continue;
      const unmapped = !matched;

      const key = `${campaign}|${ad}`.toLowerCase();
      if (knownKeys?.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);

      const image = clean(r.creative?.thumbnail_url);
      const preview = clean(r.preview_shareable_link);
      ads.push({
        account: accountId,
        campaign,
        ad,
        status: clean(r.effective_status),
        url: "",
        destUrl: "",
        body: "",
        title: clean(r.adset?.name),
        thumb: image,
        image,
        impressions: 0,
        clicks: 0,
        cost: 0,
        leads: 0,
        cpl: 0,
        ctr: 0,
        crmLeads: 0,
        scheduled: 0,
        held: 0,
        costPerSched: 0,
        costPerHeld: 0,
        ageDays: ageDays(r.created_time),
        ctrEarly: 0,
        ctrRecent: 0,
        fatigued: false,
        fatigueReason: "",
        isWinner: false,
        daily: [],
        history: null,
        noWindowData: true,
        liveCreatedIso: isoDate(r.created_time),
        unmappedCampaign: unmapped,
        previews: withPreviews && preview ? [preview] : undefined,
      });
    }
  }

  // Newest first: the ad someone just launched is the one they came to see.
  ads.sort((a, b) => String(b.liveCreatedIso).localeCompare(String(a.liveCreatedIso)));

  return { ads, accounts, sweptAll, hours, failed };
}
