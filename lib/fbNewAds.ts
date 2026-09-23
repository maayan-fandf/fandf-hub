import { unstable_cache } from "next/cache";
import { sheetsClient, driveFolderOwner } from "@/lib/sa";
import { buildMatchMap, matchSlug } from "@/lib/campaignMatch";
import { listAdsCreatedSince, metaConfigured, MetaGraphError } from "@/lib/metaGraph";
import type { MetaAd } from "@/lib/metaGraph";
import type { ReportFbAd } from "@/lib/reportShared";
import { adNameOf, fbCardKey, normCardName } from "@/lib/reportShared";

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
  /** How many of the ads turned up OUTSIDE the accounts this project is known
   *  to advertise in — i.e. only the widening pass found them. */
  foreign: number;
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

/** Distinct non-empty texts in first-seen order. Compared with whitespace
 *  collapsed — the same primary text arrives as both `video_data.message`
 *  and `creative.body` — but kept as written, line breaks included, since
 *  the line breaks are part of what the brief specified. */
function distinctTexts(list: (string | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    const s = String(v ?? "").trim();
    const k = s.replace(/\s+/g, " ");
    if (!s || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * An ad's copy as the reader of the ad sees it. Lists, not strings: a
 * dynamic-creative ad holds several headlines and texts and Meta rotates
 * them, and every variant is something the brief has to allow.
 */
export type FbAdCopy = {
  /** Headline(s) — the bold line under the image. */
  titles: string[];
  /** Primary text(s) — the copy above the image. */
  bodies: string[];
  /** Where the click goes. "" when the ad opens a lead form. */
  link: string;
};

/** The "link" Meta reports for a lead-form ad — a placeholder, not a page. */
const LEAD_FORM_LINK = /^https?:\/\/fb\.me\/?$/i;

/**
 * An ad's copy, from wherever this creative keeps it.
 *
 * Three places, and which one depends on how the ad was built — measured on
 * גינדי מרום ראשון's launches of 2026-09-23:
 *   - `asset_feed_spec` — every IMAGE ad. `body`/`title` were empty and
 *     `object_story_spec` held only the page ids; the text was here, as
 *     lists (one entry each on those ads; a dynamic-creative ad has several).
 *   - `object_story_spec.video_data` / `.link_data` — the VIDEO ads, and a
 *     classic single-image or carousel ad (whose cards each carry their own
 *     headline, collected here too).
 *   - `creative.body` / `creative.title` — Meta's flattened copy, present on
 *     the video ads beside video_data; the last resort.
 * All are read and de-duplicated rather than picking one, so a creative
 * that fills two places shows its text once and one that fills an
 * unexpected place still shows it.
 */
export function adCopyOf(c: MetaAd["creative"]): FbAdCopy {
  const afs = c?.asset_feed_spec;
  const ld = c?.object_story_spec?.link_data;
  const vd = c?.object_story_spec?.video_data;
  const texts = (xs?: { text?: string }[]) => (xs ?? []).map((x) => x.text);
  const kids = ld?.child_attachments ?? [];
  const link =
    [
      afs?.link_urls?.[0]?.website_url,
      ld?.link,
      ld?.call_to_action?.value?.link,
      vd?.call_to_action?.value?.link,
      c?.link_url,
    ]
      .map((u) => clean(u))
      .find((u) => u && !LEAD_FORM_LINK.test(u)) ?? "";
  return {
    titles: distinctTexts([
      ...texts(afs?.titles),
      ld?.name,
      ...kids.map((k) => k.name),
      vd?.title,
      c?.title,
    ]),
    bodies: distinctTexts([...texts(afs?.bodies), ld?.message, vd?.message, c?.body]),
    link,
  };
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
  const known = bySlug[slugLower] ?? [];
  let accounts = known;
  let sweptAll = false;
  const { listAdAccounts } = await import("@/lib/metaGraph");
  if (!accounts.length) {
    // Never advertised on Facebook, or advertises under a campaign name the
    // Keys patterns miss. 23 accounts is ~15s — slow for a button, but this
    // is the path where the alternative is an empty answer with no reason.
    accounts = (await listAdAccounts()).map((a) => clean(a.account_id)).filter(Boolean);
    sweptAll = true;
  }

  const matchMap = await buildMatchMap(subjectEmail);
  const failed: { accountId: string; error: string }[] = [];
  const ads: ReportFbAd[] = [];
  /** card key → the card, so a creative's further ad sets land on it. */
  const seen = new Map<string, ReportFbAd>();

  const scan = async (list: string[]) => {
    for (const accountId of list) {
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

        // THE SAME KEY THE CARDS USE (lib/reportShared fbCardKey), not a raw
        // `campaign|ad`. Meta writes one ad name with a VARYING number of
        // invisible bidi marks, so the raw string is not even stable against
        // itself: on אחוזת אפרידר, 2026-09-22, three creatives came back under
        // nine spellings — "2026-09-22A פיקדון" with none, one and two leading
        // U+200E — which sailed through both tests below and put the same
        // creative on screen three times. The same mismatch also made an ad
        // that IS already in the grid read as new, because the card's name had
        // been normalised and Meta's had not.
        const key = fbCardKey(campaign, ad);
        if (knownKeys?.has(key)) continue;
        // One creative, launched into several ad sets, comes back as one ad
        // per ad set — five of them per creative on גינדי מרום ראשון. The
        // card stays one per creative; the audiences collect on it.
        const dup = seen.get(key);
        if (dup) {
          const set = clean(r.adset?.name);
          if (set && !dup.adSets?.includes(set)) dup.adSets = [...(dup.adSets ?? []), set];
          // The card speaks for all its ad sets now, so its status must too:
          // if any copy is delivering, the creative is — the same rule as
          // lib/reportCreatives' status merge. First-row-wins read a creative
          // live in four audiences as paused when the first was.
          const st = clean(r.effective_status);
          if (st.toUpperCase() === "ACTIVE" && dup.status.toUpperCase() !== "ACTIVE") dup.status = st;
          continue;
        }

        // Cleaned, so the card's title matches the grid's spelling of the same
        // ad and the client's next knownKeys round-trips.
        seen.set(key, pushAd(r, accountId, campaign, normCardName(adNameOf(ad)), unmapped));
      }
    }
  };

  function pushAd(
    r: Awaited<ReturnType<typeof listAdsCreatedSince>>[number],
    accountId: string,
    campaign: string,
    ad: string,
    unmapped: boolean,
  ): ReportFbAd {
      const image = clean(r.creative?.thumbnail_url);
      const preview = clean(r.preview_shareable_link);
      const copy = adCopyOf(r.creative);
      const adSet = clean(r.adset?.name);
      const card: ReportFbAd = {
        account: accountId,
        campaign,
        ad,
        status: clean(r.effective_status),
        url: "",
        destUrl: copy.link,
        // The same two fields the active cards show their headline and
        // "📝 טקסט המודעה" from, so a just-launched ad reads exactly like the
        // running ones — which is what an account manager checks it against
        // the brief in. Every variant, since a dynamic-creative ad rotates
        // them. `title` used to carry the AD SET name here, for want of a
        // field; that is `adSets` now.
        title: copy.titles.join(" | "),
        body: copy.bodies.join("\n\n— — —\n\n"),
        adSets: adSet ? [adSet] : [],
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
      };
      ads.push(card);
      return card;
  }

  await scan(accounts);

  /**
   * FOUND NOTHING IN THE PROJECT'S OWN ACCOUNTS? LOOK EVERYWHERE.
   *
   * The account list above is derived from where this project has ADVERTISED
   * BEFORE, which is circular against the one case that matters: an ad
   * launched into an account the project has no history in. That is not
   * hypothetical — it is the first thing that happened in real use, on לוריא,
   * where the ad someone had just put up was in another account entirely and
   * the button reported "nothing new" with complete confidence.
   *
   * So a scoped miss widens instead of giving up. It costs ~15s across 23
   * accounts, and it is spent only on the path where the alternative is a
   * wrong answer — a hit never reaches here. `matchSlug` still decides
   * ownership, so widening the SEARCH does not widen what gets shown: an ad
   * belonging to another project is still dropped wherever it is found.
   */
  if (!ads.length && !sweptAll) {
    const all = (await listAdAccounts())
      .map((a) => clean(a.account_id))
      .filter((id) => id && !known.includes(id));
    if (all.length) {
      await scan(all);
      sweptAll = true;
      accounts = [...known, ...all];
    }
  }

  // Newest first: the ad someone just launched is the one they came to see.
  ads.sort((a, b) => String(b.liveCreatedIso).localeCompare(String(a.liveCreatedIso)));

  /** Ads found somewhere OTHER than the project's known accounts — worth
   *  telling the reader, because it means the project has started
   *  advertising from a new account and nothing else in the hub knows yet. */
  const foreign = ads.filter((a) => !known.includes(a.account)).length;

  return { ads, accounts, sweptAll, hours, failed, foreign };
}
