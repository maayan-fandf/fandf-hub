/**
 * Period-scoped GA4 analytics for the אנליטיקס section, which sits
 * between קמפיינים and מגמות on the project page.
 *
 * Distinct from lib/ga4.ts's live section in three ways: it covers the
 * report window rather than the trailing 30 minutes, it is rendered
 * server-side with no polling, and it answers "who arrived and how did
 * they behave" rather than "who is here now".
 *
 * ── What is deliberately NOT here ──
 *
 * Conversions. Key-event tagging is inconsistent across the estate in
 * ways that produce confidently wrong numbers: one property tags nothing
 * at all, another tags `thank2` (541) while `thank` (1,344) and
 * `generate_lead` (761) sit untagged, a third double-counts
 * `generate_lead` + `generate_lead_GA`, a fourth counts button clicks as
 * confirmations. The hub already counts leads from the CRM; a second,
 * wrong lead number beside it is the worst thing this section could do.
 *
 * `screenPageViews`, `bounceRate`, `newUsers` and
 * `sessionDefaultChannelGroup` are excluded too — see the rejection
 * notes on each helper below.
 */

import { unstable_cache } from "next/cache";
import { analyticsAccessToken } from "@/lib/sa";
import { normPath, detectAttributionMode, type AttributionMode } from "@/lib/ga4";

const DATA_API = "https://analyticsdata.googleapis.com/v1beta";

export type Ga4Point = {
  date: string;
  sessions: number;
  users: number;
  keyEvents: number;
};

/** Days covered when neither a free range nor a month override is set. */
const DEFAULT_WINDOW_DAYS = 28;

export type Ga4SourceBucket = {
  key: string;
  label: string;
  sessions: number;
  engaged: number;
  keyEvents: number;
  /** Share of sessions that converted. See `mergeRate`. */
  convRate: number;
};

export type Ga4CampaignRow = {
  campaign: string;
  sessions: number;
  engaged: number;
  avgSeconds: number;
  keyEvents: number;
  convRate: number;
};

/**
 * Combine GA4's `sessionKeyEventRate` across rows that we merge.
 *
 * The rate must come from GA, not from keyEvents/sessions. GA defines it
 * as (sessions with at least one key event) / sessions, so a session
 * firing two key events counts once. Deriving it instead overstates by
 * up to 3.2x on properties that fire several key events per session —
 * measured 8.90% against a true 2.80% on 533952214 and 8.50% against
 * 2.96% on 403508264.
 *
 * A rate cannot be summed, but it CAN be weighted by sessions and then
 * divided by the total, because rate_i x sessions_i is exactly the
 * converting-session count for that row. So this stays exact through
 * source bucketing and campaign-name merging.
 */
function mergeRate(weightedSum: number, sessions: number): number {
  return sessions > 0 ? weightedSum / sessions : 0;
}

export type Ga4PageRow = {
  path: string;
  sessions: number;
  engagementRate: number;
  avgSeconds: number;
};

/**
 * One node of the channel → campaign → ad-group tree.
 *
 * Three levels, not four, because that is what GA4 actually carries:
 *
 *   Google campaigns expose `sessionGoogleAdsAdGroupName` with real
 *   names (`Rm`, `חיפשו`, `55+`, `גנרי`, `מותג`) and BELOW that only
 *   `sessionManualAdContent`, which for Google is an opaque asset id
 *   (797432864778) sitting roughly 1:1 with the ad group — a fourth
 *   level of numbers nobody can read.
 *
 *   Meta campaigns leave the ad-group dimension `(not set)` entirely and
 *   put F&F's own ad codes in `sessionManualAdContent` instead
 *   (2026-05-26A, 2026-05-20A, 2026-05-26B s30).
 *
 * So the third level is "ad group" on Google and "ad" on Meta. The node
 * carries `childLabel` so the UI can name it correctly per branch rather
 * than picking one word that is wrong half the time.
 */
export type Ga4TreeNode = {
  key: string;
  label: string;
  /** Platform key for the logo — resolved from the channel bucket. */
  platform: string;
  sessions: number;
  keyEvents: number;
  convRate: number;
  /** Hebrew name for what this node's children ARE. */
  childLabel?: string;
  children: Ga4TreeNode[];
};

export type Ga4CityRow = { city: string; sessions: number; keyEvents: number };

/**
 * A placement or medium delivering traffic that never converts.
 *
 * Meta writes the PLACEMENT into utm_medium, so `sessionMedium` carries
 * values like `Facebook_Right_Column`, `Instagram_Stories` and `an`
 * alongside ordinary mediums like `cpc` and `organic`. Querying it gives
 * placement-level visibility that nothing else in the hub has.
 *
 * The case this exists for: on גינדי over 28 days
 * `Facebook_Right_Column` was the LARGEST placement by volume — 1,888
 * sessions — with exactly 0 key events, while its siblings converted
 * normally (Facebook_Mobile_Feed 534/138, Instagram_Feed 101/31). Its
 * traffic was US 1,290, Sweden 323, Ireland 273: the same three-country
 * signature that placement shows on seven other properties, for ~3,034
 * sessions and zero conversions in total.
 *
 * Deliberately not restricted to Meta placements. Keeping ordinary
 * mediums in scope lets the same rule catch a Google campaign delivering
 * to the wrong country, which is a real case on this estate.
 */
export type Ga4PlacementLeak = {
  placement: string;
  sessions: number;
  keyEvents: number;
  foreignSessions: number;
  foreignShare: number;
  topCountries: string[];
};

/* Thresholds, kept together so they can be tuned in one place.
 * MIN_SESSIONS keeps dormant pages out — residual bot traffic dominates
 * anything with a handful of sessions. MIN_FOREIGN_SHARE is what
 * separates "this placement performs badly" from "this placement is not
 * reaching the country we sell in". */
const LEAK_MIN_SESSIONS = 40;
const LEAK_MIN_FOREIGN_SHARE = 0.6;

/**
 * Mediums that are not bought media and so can never be a "placement".
 *
 * Without this the block flags `referral` and `(none)` — on קאזר both
 * tripped the rule (93 sessions at 91% foreign, 52 at 81%) — and then
 * advises checking the campaign's placement settings, which cannot fix
 * traffic nobody bought. `cpc` deliberately stays in scope: it is paid,
 * and it is how a Google campaign delivering to the wrong country shows
 * up here.
 */
const NON_PAID_MEDIUMS = new Set([
  "(none)",
  "(not set)",
  "(data not available)",
  "referral",
  "organic",
  "email",
  "sms",
  "affiliate",
]);

export type Ga4DeviceRow = {
  device: "mobile" | "desktop" | "tablet" | "other";
  label: string;
  sessions: number;
  keyEvents: number;
  keyEventRate: number;
};

export type Ga4ConversionData = {
  keyEvents: number;
  prevKeyEvents: number;
  /** GA4's own session key-event rate, not derived by us. */
  sessionRate: number;
  prevSessionRate: number;
  /** Per-event split, e.g. generate_lead vs Thankyoupage. */
  byEvent: { event: string; count: number }[];
};

/** One age bracket, split by gender — the shape a grouped bar chart needs. */
export type Ga4DemoRow = {
  bucket: string;
  male: number;
  female: number;
  maleKeyEvents: number;
  femaleKeyEvents: number;
};

/** GA4's age brackets, in order. It never classifies under-18s, so
 *  unlike Meta's equivalent chart there is no 13-17 column. */
export const AGE_ORDER = ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"];

/**
 * Age and gender, which need Google Signals switched on for the
 * property. Two properties in the estate have it off entirely and
 * return nothing, so this is null rather than empty in that case.
 *
 * `knownShare` is the fraction of users GA could actually classify, and
 * it is NOT incidental — measured 21% / 22% / 32% across properties,
 * because only signed-in Google users with ads personalisation get a
 * bracket. Every figure here therefore describes that minority, and the
 * UI must say so; presented as "the audience" it would be false.
 */
export type Ga4Demographics = {
  /** Age brackets in AGE_ORDER, each split by gender. */
  rows: Ga4DemoRow[];
  maleUsers: number;
  femaleUsers: number;
  maleKeyEvents: number;
  femaleKeyEvents: number;
  knownUsers: number;
  totalUsers: number;
};

/**
 * New vs returning visitors, and how each converts.
 *
 * This is the honest answer to "can we see multi-channel journeys". GA4's
 * Data API exposes no conversion path, no assist and no time-to-
 * conversion field, and comparing first-touch to last-touch turned out
 * to be redundant here: key-event totals are conserved exactly across
 * the two attributions on every property measured, and Meta's share
 * moves by under 1.2 points. The reason is structural — F&F traffic is
 * overwhelmingly single-session, so there is barely any journey for the
 * two attributions to disagree about.
 *
 * What DOES carry signal is whether people convert on the first visit or
 * come back to do it: returning users were 18% of sessions but 35% of
 * key events on one property, and 9% vs 22% on another.
 */
/**
 * Campaigns that introduced converting users but did not close them.
 *
 * This is the ONE place first-touch and last-touch attribution genuinely
 * diverge on this estate. A channel-level comparison was measured and
 * rejected — key-event totals are conserved exactly across the two
 * attributions and channel shares move under 1.2 points — but at
 * CAMPAIGN level a real difference survives, because a campaign that has
 * stopped running keeps its first-touch credit while all last-touch
 * credit moves to whatever is live now.
 *
 * Measured on 526091009: Gohari-iris_2026-03-05_FB holds 5 first-touch
 * key events against 0 last-touch, Gohari-Jade_2026-03-05_FB 3 against
 * 0, and "New Leads Campaign" 4 while being absent from the last-touch
 * list entirely — roughly 5% of key events.
 *
 * Deliberately NOT called assisted conversions: GA4 has no assist or
 * path data, and this is a narrower, verifiable claim — "this campaign
 * brought people who converted later".
 */
export type Ga4IntroRow = {
  campaign: string;
  introKeyEvents: number;
  closeKeyEvents: number;
};

export type Ga4Returning = {
  rows: {
    kind: "new" | "returning";
    label: string;
    sessions: number;
    keyEvents: number;
    convRate: number;
  }[];
};

export type Ga4ReportData = {
  window: { start: string; end: string };
  prevWindow: { start: string; end: string };
  trend: Ga4Point[];
  totals: { sessions: number; users: number };
  prevTotals: { sessions: number; users: number };
  quality: { engagementRate: number; avgSeconds: number; engagedSessions: number };
  prevQuality: { engagementRate: number; avgSeconds: number; engagedSessions: number };
  sources: Ga4SourceBucket[];
  /** Null when campaign tagging is too broken to show — see CAMPAIGN_COVERAGE_MIN. */
  campaigns: Ga4CampaignRow[] | null;
  campaignCoverage: number;
  unattributedSessions: number;
  /** Only populated when the project owns more than one page. */
  pages: Ga4PageRow[];
  /** Israeli cities only, biggest first. Foreign traffic is filtered out
   *  upstream — it is bot/proxy noise on these properties. */
  cities: Ga4CityRow[];
  /**
   * Traffic from outside Israel.
   *
   * Kept in detail rather than as one number because on some projects it
   * is not a rounding error: /mia-beer-yaakov drew 1,410 sessions from
   * India, 488 from Bangladesh and 172 from Ethiopia over 28 days
   * against 2,484 Israeli — roughly half the traffic to a Hebrew
   * landing page for a town near Rishon LeZion, converting at zero.
   *
   * What makes it invisible elsewhere is that its engagement rate
   * (0.51) is almost identical to Israel's (0.52), so nothing in a
   * normal report flags it.
   */
  abroad: {
    sessions: number;
    keyEvents: number;
    convRate: number;
    topCountries: {
      country: string;
      sessions: number;
      keyEvents: number;
      convRate: number;
    }[];
  };
  israel: { sessions: number; keyEvents: number; convRate: number };
  /** Placements/mediums delivering non-converting foreign traffic.
   *  Empty unless the property tags key events — otherwise every
   *  placement trivially has zero conversions. */
  placementLeaks: Ga4PlacementLeak[];
  /** channel → campaign → ad group / ad, for the expandable table. */
  tree: Ga4TreeNode[];
  devices: Ga4DeviceRow[];
  /** Null when the property tags no key events at all — a conversion
   *  block reading 0% would be indistinguishable from real failure. */
  conversions: Ga4ConversionData | null;
  /** Null when Google Signals is off for the property. */
  demographics: Ga4Demographics | null;
  returning: Ga4Returning | null;
  /** Campaigns with materially more first-touch than last-touch credit. */
  intro: Ga4IntroRow[];
  mode: AttributionMode;
  /** True when the project owns its whole domain and no filter was applied. */
  wholeSite: boolean;
};

/* ── Date helpers (Asia/Jerusalem, matching the rest of the codebase) ── */

function ilToday(): Date {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return new Date(`${s}T00:00:00Z`);
}
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number): Date =>
  new Date(d.getTime() + n * 86_400_000);
const daysBetween = (a: string, b: string): number =>
  Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) /
      86_400_000,
  );

/**
 * The window this section reports on.
 *
 * Always ends YESTERDAY, never today. GA4's current day is partial and
 * skews engagement badly — measured engagementRate 0.054 for a part-day
 * against ~0.38 for the same property's full days — so including it
 * would make every project look like it fell off a cliff this morning.
 */
export function reportWindow(
  monthFilter?: string,
  dateRange?: { from: string; to: string },
): {
  start: string;
  end: string;
  prevStart: string;
  prevEnd: string;
} {
  const yesterday = addDays(ilToday(), -1);
  let end = yesterday;
  let start = addDays(end, -(DEFAULT_WINDOW_DAYS - 1));

  // Precedence matches the rest of the page: an explicit ?from/?to range
  // from the shared DateRangePicker wins, then ?monthOverride, then the
  // default trailing window. This section must never show a different
  // period from the CRM funnel and the report beside it.
  const m = (monthFilter || "").trim();
  if (dateRange?.from && dateRange?.to && dateRange.from <= dateRange.to) {
    start = new Date(`${dateRange.from}T00:00:00Z`);
    const to = new Date(`${dateRange.to}T00:00:00Z`);
    // Still never include today — a partial day craters engagement.
    end = to < yesterday ? to : yesterday;
    if (end < start) end = start;
  } else if (/^\d{4}-\d{2}$/.test(m)) {
    const [y, mo] = m.split("-").map(Number);
    const first = new Date(Date.UTC(y, mo - 1, 1));
    const last = new Date(Date.UTC(y, mo, 0));
    start = first;
    end = last < yesterday ? last : yesterday;
  }
  const len = daysBetween(iso(start), iso(end));
  return {
    start: iso(start),
    end: iso(end),
    prevStart: iso(addDays(start, -(len + 1))),
    prevEnd: iso(addDays(start, -1)),
  };
}

/* ── API plumbing ─────────────────────────────────────────────────── */

type Row = { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] };
type Report = { rows?: Row[] };

const dim = (r: Row, i: number): string => r.dimensionValues?.[i]?.value ?? "";
const met = (r: Row, i: number): number => {
  const n = Number(r.metricValues?.[i]?.value);
  return Number.isFinite(n) ? n : 0;
};

async function batchRun(
  subjectEmail: string,
  propertyId: string,
  requests: Record<string, unknown>[],
): Promise<Report[]> {
  const token = await analyticsAccessToken(subjectEmail);
  const res = await fetch(`${DATA_API}/properties/${propertyId}:batchRunReports`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requests }),
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ga4 batch ${res.status} on ${propertyId}: ${txt.slice(0, 200)}`);
  }
  const json = (await res.json()) as { reports?: Report[] };
  return json.reports ?? [];
}

/**
 * The RAW dimension values (not normalized) for this project's pages.
 *
 * Needed because every report below filters API-side via `inListFilter`,
 * which matches raw values — and the raw data holds real variants of one
 * page (`/luria/` alongside `/Luria-your-new-love-awaits/`, trailing
 * slashes present on pagePath and absent on landingPage).
 *
 * Filtering server-side is a correctness requirement, not an
 * optimization: `date × landingPage` on a property with 148 landing
 * pages over 28 days is ~4,100 rows, which silently truncates against
 * any sane row limit and would quietly lose days from the trend.
 */
const rawValuesCache = new Map<string, { expiresAt: number; values: string[] }>();
const RAW_TTL_MS = 6 * 60 * 60 * 1000;

async function resolveRawPageValues(
  subjectEmail: string,
  propertyId: string,
  mode: AttributionMode,
  paths: string[],
): Promise<string[]> {
  const want = new Set(paths.map(normPath).filter(Boolean));
  const key = `${propertyId}|${mode}|${[...want].sort().join(",")}`;
  const hit = rawValuesCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.values;

  const [report] = await batchRun(subjectEmail, propertyId, [
    {
      dateRanges: [{ startDate: "90daysAgo", endDate: "today" }],
      dimensions: [{ name: mode }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 1000,
    },
  ]);
  const values: string[] = [];
  for (const r of report?.rows ?? []) {
    const raw = dim(r, 0);
    if (raw && want.has(normPath(raw))) values.push(raw);
  }
  rawValuesCache.set(key, { expiresAt: Date.now() + RAW_TTL_MS, values });
  return values;
}

/* ── Source classification ────────────────────────────────────────── */

/**
 * Buckets derived from `sessionSourceMedium` in our own code.
 *
 * `sessionDefaultChannelGroup` is populated everywhere and would be the
 * obvious choice — it is also actively wrong here. Meta writes placement
 * names into `utm_medium` (`Facebook_Mobile_Feed`, `Instagram_Reels`),
 * so GA4 cannot recognise the traffic as paid: ~5,110 sessions of paid
 * Facebook on one property are filed under "Organic Social", and 8,004
 * paid Meta sessions on another land in "Unassigned". A client-visible
 * paid-vs-organic split built on it would report our own campaigns as
 * free traffic.
 */
/**
 * `an` (Meta Audience Network) is deliberately NOT in this set.
 *
 * It is technically Meta inventory, but bucketing it with Facebook and
 * Instagram produces a materially wrong conclusion. Measured on
 * /mia-beer-yaakov over 28 days: an/an served 1,347 sessions to India,
 * 464 to Bangladesh, 166 to Ethiopia, 120 to Nepal and 81 to Congo for
 * 9 key events in total, while fb/Facebook_Mobile_Feed served 1,035
 * Israeli sessions for 103. Blended, Meta reads 3.5% against Google's
 * 11% and looks like the weaker channel — split, Facebook and Instagram
 * are the strongest thing on the account and Audience Network is the
 * entire problem.
 *
 * This is also where the section's foreign-traffic block comes from:
 * the two findings are the same finding.
 */
const META_SOURCES = new Set(["fb", "facebook", "ig", "instagram", "meta", "msg"]);
const AUDIENCE_NETWORK_SOURCES = new Set(["an", "audiencenetwork", "audience_network"]);
const PAID_MEDIUMS = new Set(["cpc", "ppc", "paid", "paidsearch", "paid_search"]);

const SOURCE_LABELS: Record<string, string> = {
  meta: "מטא (פייסבוק/אינסטגרם)",
  audiencenetwork: "Audience Network (מטא)",
  googleads: "גוגל (ממומן)",
  taboola: "טאבולה / אאוטבריין",
  organic: "חיפוש אורגני",
  direct: "כניסה ישירה",
  referral: "הפניות מאתרים",
  other: "אחר",
};

function classifySource(sourceMedium: string): string {
  const [rawSource = "", rawMedium = ""] = sourceMedium
    .toLowerCase()
    .split("/")
    .map((s) => s.trim());
  if (AUDIENCE_NETWORK_SOURCES.has(rawSource)) return "audiencenetwork";
  if (META_SOURCES.has(rawSource)) return "meta";
  if (rawSource.includes("facebook") || rawSource.includes("instagram")) return "meta";
  if (rawSource.includes("google") && PAID_MEDIUMS.has(rawMedium)) return "googleads";
  if (rawSource.includes("taboola") || rawSource.includes("outbrain")) return "taboola";
  if (rawMedium === "organic") return "organic";
  if (rawSource === "(direct)" || rawMedium === "(none)") return "direct";
  if (rawMedium === "referral") return "referral";
  return "other";
}

/* ── Campaign sanitising ──────────────────────────────────────────── */

const CAMPAIGN_NOISE = new Set([
  "(direct)", "(organic)", "(referral)", "(not set)", "(cross-network)",
  "(ai-assistant)", "(none)", "",
]);

/** Below this share of paid sessions carrying a usable campaign name,
 *  the table is suppressed rather than shown half-wrong. */
const CAMPAIGN_COVERAGE_MIN = 0.7;

/**
 * Returns "" for a value that isn't a real campaign name.
 *
 * Each rule comes from an observed failure: raw numeric Meta campaign
 * IDs leaking through (`120249068974210774`, 4,882 sessions), an
 * un-expanded ValueTrack macro (`{campaigned}`, 4,339 of 5,873 sessions
 * on one property), and `+`-encoded duplicates of one campaign
 * (`FB - Website` vs `FB+-+Website`).
 */
function cleanCampaign(raw: string): string {
  const v = (raw || "").trim();
  if (CAMPAIGN_NOISE.has(v.toLowerCase())) return "";
  if (/^\d{6,}$/.test(v)) return "";
  if (/^\{.*\}$/.test(v) || v.includes("{{")) return "";
  return decodeURIComponent(v.replace(/\+/g, " ")).trim();
}

/* ── The fetch ────────────────────────────────────────────────────── */

async function fetchGa4ReportUncached(
  subjectEmail: string,
  propertyId: string,
  paths: string[],
  win: { start: string; end: string; prevStart: string; prevEnd: string },
): Promise<Ga4ReportData | null> {
  const mode = await detectAttributionMode(subjectEmail, propertyId);

  // A project sitting at the domain root owns the whole property, so
  // filtering to landingPage == "/" would throw away every session that
  // entered on a sub-page. Drop the filter entirely for those.
  const normed = paths.map(normPath).filter(Boolean);
  const wholeSite = normed.length === 1 && normed[0] === "/";

  let filter: Record<string, unknown> | undefined;
  if (!wholeSite) {
    const rawValues = await resolveRawPageValues(subjectEmail, propertyId, mode, paths);
    if (rawValues.length === 0) return null;
    filter = {
      filter: { fieldName: mode, inListFilter: { values: rawValues } },
    };
  }

  const cur = { startDate: win.start, endDate: win.end };
  const prev = { startDate: win.prevStart, endDate: win.prevEnd };
  const withFilter = (req: Record<string, unknown>) =>
    filter ? { ...req, dimensionFilter: filter } : req;

  const reports = await batchRun(subjectEmail, propertyId, [
    // 1 — daily trend, current window only (the previous period is
    //     compared as a total, not plotted; two series on 28 RTL points
    //     is unreadable at panel width).
    withFilter({
      dateRanges: [cur],
      dimensions: [{ name: "date" }],
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "keyEvents" },
      ],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 400,
    }),
    // 2 — totals, both windows. Separate from the trend because summing
    //     totalUsers across days double-counts anyone who returns.
    withFilter({
      dateRanges: [cur, prev],
      metrics: [{ name: "sessions" }, { name: "totalUsers" }],
    }),
    // 3 — behaviour quality + conversion rate, both windows.
    //     sessionKeyEventRate is GA4's own figure rather than
    //     keyEvents/sessions computed here: GA counts a session as
    //     converting once even if it fires several key events, so the
    //     naive ratio can exceed 100%.
    withFilter({
      dateRanges: [cur, prev],
      metrics: [
        { name: "engagementRate" },
        { name: "averageSessionDuration" },
        { name: "engagedSessions" },
        { name: "keyEvents" },
        { name: "sessionKeyEventRate" },
      ],
    }),
    // 4 — where the traffic came from, with its conversion performance.
    //     sessionKeyEventRate IS requested per row and recombined via
    //     mergeRate — deriving it from keyEvents/sessions would overstate
    //     by up to 3.2x. See mergeRate's doc block.
    withFilter({
      dateRanges: [cur],
      dimensions: [{ name: "sessionSourceMedium" }],
      metrics: [
        { name: "sessions" },
        { name: "engagedSessions" },
        { name: "keyEvents" },
        { name: "sessionKeyEventRate" },
      ],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 200,
    }),
    // 5 — per campaign. Same treatment: rows merge after sanitising
    //     (case, separators, +-encoding), so the rate is session-weighted.
    withFilter({
      dateRanges: [cur],
      dimensions: [{ name: "sessionCampaignName" }],
      metrics: [
        { name: "sessions" },
        { name: "engagedSessions" },
        { name: "averageSessionDuration" },
        { name: "keyEvents" },
        { name: "sessionKeyEventRate" },
      ],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 200,
    }),
  ]);

  const [rTrend, rTotals, rQuality, rSources, rCampaigns] = reports;

  const trend: Ga4Point[] = (rTrend?.rows ?? []).map((r) => ({
    date: dim(r, 0),
    sessions: met(r, 0),
    users: met(r, 1),
    keyEvents: met(r, 2),
  }));

  // With two dateRanges GA4 appends a `dateRange` dimension LAST and
  // names the ranges date_range_0 / date_range_1. Never pair rows by
  // array position — the order is not guaranteed.
  const pickRange = (rep: Report | undefined, want: string, count: number): number[] => {
    for (const r of rep?.rows ?? []) {
      const tag = r.dimensionValues?.[r.dimensionValues.length - 1]?.value ?? "";
      if (tag === want) return Array.from({ length: count }, (_, i) => met(r, i));
    }
    return Array.from({ length: count }, () => 0);
  };

  const [curSessions, curUsers] = pickRange(rTotals, "date_range_0", 2);
  const [prevSessions, prevUsers] = pickRange(rTotals, "date_range_1", 2);
  const [curEr, curDur, curEng, curKe, curKeRate] = pickRange(rQuality, "date_range_0", 5);
  const [prevEr, prevDur, prevEng, prevKe, prevKeRate] = pickRange(rQuality, "date_range_1", 5);

  const bucket = new Map<string, Ga4SourceBucket>();
  // convRate accumulates rate x sessions here and is divided out below.
  for (const r of rSources?.rows ?? []) {
    const key = classifySource(dim(r, 0));
    const b = bucket.get(key) ?? {
      key,
      label: SOURCE_LABELS[key] ?? SOURCE_LABELS.other,
      sessions: 0,
      engaged: 0,
      keyEvents: 0,
      convRate: 0,
    };
    const sessions = met(r, 0);
    b.sessions += sessions;
    b.engaged += met(r, 1);
    b.keyEvents += met(r, 2);
    b.convRate += met(r, 3) * sessions;
    bucket.set(key, b);
  }
  const sources = [...bucket.values()]
    .map((b) => ({ ...b, convRate: mergeRate(b.convRate, b.sessions) }))
    .sort((a, b) => b.sessions - a.sessions);

  // Campaign coverage is measured against PAID sessions only — organic,
  // direct and referral legitimately have no campaign name and must not
  // count against the tagging quality.
  const nonPaid = sources
    .filter((s) => s.key === "organic" || s.key === "direct" || s.key === "referral")
    .reduce((n, s) => n + s.sessions, 0);
  const totalSessions = sources.reduce((n, s) => n + s.sessions, 0);
  const paidSessions = Math.max(0, totalSessions - nonPaid);

  const campMap = new Map<string, Ga4CampaignRow>();
  let usable = 0;
  let unattributed = 0;
  for (const r of rCampaigns?.rows ?? []) {
    const sessions = met(r, 0);
    const name = cleanCampaign(dim(r, 0));
    if (!name) {
      unattributed += sessions;
      continue;
    }
    usable += sessions;
    const k = name.toLowerCase().replace(/[_-]+/g, "-");
    const row = campMap.get(k) ?? {
      campaign: name,
      sessions: 0,
      engaged: 0,
      avgSeconds: 0,
      keyEvents: 0,
      convRate: 0,
    };
    // Duration is a per-session average, so combine it weighted by
    // sessions rather than averaging the averages. convRate accumulates
    // rate x sessions and is divided out below, same reasoning.
    const totalSecs = row.avgSeconds * row.sessions + met(r, 2) * sessions;
    row.sessions += sessions;
    row.engaged += met(r, 1);
    row.avgSeconds = row.sessions > 0 ? totalSecs / row.sessions : 0;
    row.keyEvents += met(r, 3);
    row.convRate += met(r, 4) * sessions;
    campMap.set(k, row);
  }
  const coverage = paidSessions > 0 ? usable / paidSessions : 0;
  const campaigns =
    coverage >= CAMPAIGN_COVERAGE_MIN
      ? [...campMap.values()]
          .map((c) => ({ ...c, convRate: mergeRate(c.convRate, c.sessions) }))
          .sort((a, b) => b.sessions - a.sessions)
          .slice(0, 8)
      : null;

  // Second batch — geography, device and the per-event conversion split.
  // Separate call because batchRunReports caps at 5 reports and the
  // first batch already uses all five.
  const DEVICE_LABELS: Record<string, string> = {
    mobile: "מובייל",
    desktop: "דסקטופ",
    tablet: "טאבלט",
  };
  const cities: Ga4CityRow[] = [];
  const devices: Ga4DeviceRow[] = [];
  const byEvent: { event: string; count: number }[] = [];
  const placementLeaks: Ga4PlacementLeak[] = [];
  const tree: Ga4TreeNode[] = [];
  // `convRate` accumulates rate x sessions and is divided out below.
  const byCountry = new Map<
    string,
    { sessions: number; keyEvents: number; convRate: number }
  >();
  const israel = { sessions: 0, keyEvents: 0, convRate: 0 };

  try {
    const [rCity, rDevice, rEvent, rPlacement, rTree] = await batchRun(subjectEmail, propertyId, [
      withFilter({
        dateRanges: [cur],
        dimensions: [{ name: "city" }, { name: "country" }],
        metrics: [
          { name: "sessions" },
          { name: "keyEvents" },
          // Session rate per row, session-weighted on aggregation — see
          // mergeRate. Dividing keyEvents by sessions here would report
          // Israel at 11% against a 4.6% headline on the same project.
          { name: "sessionKeyEventRate" },
        ],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 300,
      }),
      withFilter({
        dateRanges: [cur],
        dimensions: [{ name: "deviceCategory" }],
        metrics: [
          { name: "sessions" },
          { name: "keyEvents" },
          { name: "sessionKeyEventRate" },
        ],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 10,
      }),
      withFilter({
        dateRanges: [cur],
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "keyEvents" }],
        orderBys: [{ metric: { metricName: "keyEvents" }, desc: true }],
        limit: 25,
      }),
      // Placement x country. Meta puts the placement in utm_medium, so
      // this is the only view in the hub that can see one placement
      // inside a campaign misbehaving.
      withFilter({
        dateRanges: [cur],
        dimensions: [{ name: "sessionMedium" }, { name: "country" }],
        metrics: [{ name: "sessions" }, { name: "keyEvents" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 400,
      }),
      // The channel → campaign → ad-group tree. One query with all four
      // dimensions rather than three drill-down round trips: the whole
      // tree is ~60-150 rows on a real property, which is cheaper than
      // an endpoint per level and lets the UI expand instantly.
      withFilter({
        dateRanges: [cur],
        dimensions: [
          { name: "sessionSourceMedium" },
          { name: "sessionCampaignName" },
          { name: "sessionGoogleAdsAdGroupName" },
          { name: "sessionManualAdContent" },
        ],
        metrics: [
          { name: "sessions" },
          { name: "keyEvents" },
          { name: "sessionKeyEventRate" },
        ],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 500,
      }),
    ]);

    for (const r of rCity?.rows ?? []) {
      const name = dim(r, 0).trim();
      const country = dim(r, 1).trim();
      const sessions = met(r, 0);
      const ke = met(r, 1);
      // Foreign traffic is counted and reported, never mapped — the map
      // is of Israel. Aggregated by country so the waste block can name
      // which countries the budget went to.
      const rate = met(r, 2);
      if (country && country !== "Israel") {
        const c = byCountry.get(country) ?? { sessions: 0, keyEvents: 0, convRate: 0 };
        c.sessions += sessions;
        c.keyEvents += ke;
        c.convRate += rate * sessions;
        byCountry.set(country, c);
        continue;
      }
      israel.sessions += sessions;
      israel.keyEvents += ke;
      israel.convRate += rate * sessions;
      if (!name || name === "(not set)") continue;
      cities.push({ city: name, sessions, keyEvents: ke });
    }

    for (const r of rDevice?.rows ?? []) {
      const raw = dim(r, 0).trim().toLowerCase();
      const key = (["mobile", "desktop", "tablet"].includes(raw)
        ? raw
        : "other") as Ga4DeviceRow["device"];
      devices.push({
        device: key,
        label: DEVICE_LABELS[raw] ?? "אחר",
        sessions: met(r, 0),
        keyEvents: met(r, 1),
        keyEventRate: met(r, 2),
      });
    }

    for (const r of rEvent?.rows ?? []) {
      const count = met(r, 0);
      if (count > 0) byEvent.push({ event: dim(r, 0), count });
    }

    type LeakAcc = {
      sessions: number;
      keyEvents: number;
      foreign: number;
      countries: Map<string, number>;
    };
    const byPlacement = new Map<string, LeakAcc>();
    for (const r of rPlacement?.rows ?? []) {
      const placement = dim(r, 0).trim();
      const country = dim(r, 1).trim();
      if (!placement || NON_PAID_MEDIUMS.has(placement.toLowerCase())) continue;
      const sessions = met(r, 0);
      const acc =
        byPlacement.get(placement) ??
        { sessions: 0, keyEvents: 0, foreign: 0, countries: new Map() };
      acc.sessions += sessions;
      acc.keyEvents += met(r, 1);
      if (country && country !== "Israel") {
        acc.foreign += sessions;
        acc.countries.set(country, (acc.countries.get(country) ?? 0) + sessions);
      }
      byPlacement.set(placement, acc);
    }
    for (const [placement, acc] of byPlacement) {
      if (acc.sessions < LEAK_MIN_SESSIONS) continue;
      if (acc.keyEvents > 0) continue;
      const foreignShare = acc.sessions > 0 ? acc.foreign / acc.sessions : 0;
      if (foreignShare < LEAK_MIN_FOREIGN_SHARE) continue;
      placementLeaks.push({
        placement,
        sessions: acc.sessions,
        keyEvents: acc.keyEvents,
        foreignSessions: acc.foreign,
        foreignShare,
        topCountries: [...acc.countries.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([c]) => c),
      });
    }
    placementLeaks.sort((a, b) => b.sessions - a.sessions);

    // ── channel → campaign → ad group / ad ──────────────────────────
    // Accumulators carry convRate as rate x sessions and are divided out
    // at the end, the same session-weighting used everywhere else.
    type Acc = {
      label: string;
      platform: string;
      sessions: number;
      keyEvents: number;
      rateW: number;
      childLabel?: string;
      /** Raw rows, held only between the two passes below. */
      raw?: { adGroup: string; adContent: string; sessions: number; ke: number; rate: number }[];
      kids: Map<string, Acc>;
    };
    const mkAcc = (label: string, platform: string): Acc => ({
      label,
      platform,
      sessions: 0,
      keyEvents: 0,
      rateW: 0,
      kids: new Map(),
    });
    const roots = new Map<string, Acc>();

    for (const r of rTree?.rows ?? []) {
      const bucket = classifySource(dim(r, 0));
      const campaign = cleanCampaign(dim(r, 1));
      // Rows with no real campaign are organic/direct/referral traffic;
      // the tree is about bought media, and they already have their own
      // row in the source table above.
      if (!campaign) continue;
      const adGroup = dim(r, 2).trim();
      const adContent = dim(r, 3).trim();
      const sessions = met(r, 0);
      const ke = met(r, 1);
      const rate = met(r, 2);

      const platform =
        bucket === "googleads" ? "google" : bucket === "meta" ? "facebook" : bucket;

      const root =
        roots.get(bucket) ??
        mkAcc(SOURCE_LABELS[bucket] ?? SOURCE_LABELS.other, platform);
      root.childLabel = "קמפיינים";
      const campKey = campaign.toLowerCase().replace(/[_-]+/g, "-");
      const camp = root.kids.get(campKey) ?? mkAcc(campaign, platform);

      const bump = (a: Acc) => {
        a.sessions += sessions;
        a.keyEvents += ke;
        a.rateW += rate * sessions;
      };
      bump(root);
      bump(camp);
      // Leaves are decided per CAMPAIGN in a second pass, not here: a
      // Google campaign has some rows carrying an ad-group name and
      // others carrying only an asset id, and choosing per row put
      // `Rm`, `חיפשו`, `55+` and `797432864778` side by side as if they
      // were the same kind of thing.
      camp.raw = camp.raw ?? [];
      camp.raw.push({ adGroup, adContent, sessions, ke, rate });
      root.kids.set(campKey, camp);
      roots.set(bucket, root);
    }

    // Second pass: one leaf dimension per campaign. Google wins with ad
    // groups wherever it has any — the asset ids underneath are opaque
    // numbers — and rows with no group are collected rather than dropped
    // so the children still sum to the campaign. Meta campaigns have no
    // groups at all and fall through to their ad codes.
    for (const root of roots.values()) {
      for (const camp of root.kids.values()) {
        const raw = camp.raw ?? [];
        const useGroups = raw.some(
          (x) => x.adGroup && x.adGroup !== "(not set)",
        );
        camp.childLabel = useGroups ? "קבוצות מודעות" : "מודעות";
        for (const x of raw) {
          const name = useGroups
            ? x.adGroup && x.adGroup !== "(not set)"
              ? x.adGroup
              : "ללא קבוצת מודעות"
            : x.adContent && x.adContent !== "(not set)"
              ? x.adContent
              : "";
          if (!name) continue;
          const leaf = camp.kids.get(name) ?? mkAcc(name, camp.platform);
          leaf.sessions += x.sessions;
          leaf.keyEvents += x.ke;
          leaf.rateW += x.rate * x.sessions;
          camp.kids.set(name, leaf);
        }
        delete camp.raw;
      }
    }

    const toNode = (a: Acc, key: string): Ga4TreeNode => ({
      key,
      label: a.label,
      platform: a.platform,
      sessions: a.sessions,
      keyEvents: a.keyEvents,
      convRate: mergeRate(a.rateW, a.sessions),
      childLabel: a.kids.size > 0 ? a.childLabel : undefined,
      children: [...a.kids.entries()]
        .map(([k, v]) => toNode(v, `${key}/${k}`))
        .sort((x, y) => y.sessions - x.sessions),
    });
    tree.push(
      ...[...roots.entries()]
        .map(([k, v]) => toNode(v, k))
        .sort((a, b) => b.sessions - a.sessions),
    );
  } catch {
    // Non-fatal — the section renders without these blocks.
  }

  // Third batch — demographics (Google Signals) and new vs returning.
  let demographics: Ga4Demographics | null = null;
  let returning: Ga4Returning | null = null;
  const intro: Ga4IntroRow[] = [];
  try {
    const [rDemo, rReturn, rIntro] = await batchRun(subjectEmail, propertyId, [
      // Age and gender CROSSED, not two marginals — a grouped bar chart
      // needs the cells. Verified to survive GA4's demographic
      // thresholding: 12 populated cells on a landing page with 798
      // identified users.
      withFilter({
        dateRanges: [cur],
        dimensions: [{ name: "userAgeBracket" }, { name: "userGender" }],
        metrics: [{ name: "totalUsers" }, { name: "keyEvents" }],
        limit: 60,
      }),
      withFilter({
        dateRanges: [cur],
        dimensions: [{ name: "newVsReturning" }],
        metrics: [
          { name: "sessions" },
          { name: "keyEvents" },
          { name: "sessionKeyEventRate" },
        ],
        limit: 10,
      }),
      // First-touch campaign credit, compared below against the
      // last-touch table already fetched in batch 1.
      withFilter({
        dateRanges: [cur],
        dimensions: [{ name: "firstUserCampaignName" }],
        metrics: [{ name: "keyEvents" }],
        orderBys: [{ metric: { metricName: "keyEvents" }, desc: true }],
        limit: 100,
      }),
    ]);

    // "unknown" appears independently in EITHER dimension — GA emits
    // real `unknown | male` rows for users whose gender it knows but
    // whose age it doesn't. A cell is only plottable when both are
    // known; everything else feeds the unclassified remainder, so the
    // caption's denominator stays honest.
    const byAge = new Map<string, Ga4DemoRow>();
    let totalUsers = 0;
    let knownUsers = 0;
    let maleUsers = 0;
    let femaleUsers = 0;
    let maleKeyEvents = 0;
    let femaleKeyEvents = 0;
    for (const r of rDemo?.rows ?? []) {
      const age = dim(r, 0).trim();
      const gender = dim(r, 1).trim().toLowerCase();
      const users = met(r, 0);
      const ke = met(r, 1);
      if (!age) continue;
      totalUsers += users;
      if (age.toLowerCase() === "unknown") continue;
      if (gender !== "male" && gender !== "female") continue;
      knownUsers += users;
      const row =
        byAge.get(age) ??
        { bucket: age, male: 0, female: 0, maleKeyEvents: 0, femaleKeyEvents: 0 };
      if (gender === "male") {
        row.male += users;
        row.maleKeyEvents += ke;
        maleUsers += users;
        maleKeyEvents += ke;
      } else {
        row.female += users;
        row.femaleKeyEvents += ke;
        femaleUsers += users;
        femaleKeyEvents += ke;
      }
      byAge.set(age, row);
    }
    if (byAge.size > 0) {
      demographics = {
        rows: AGE_ORDER.filter((a) => byAge.has(a)).map((a) => byAge.get(a)!),
        maleUsers,
        femaleUsers,
        maleKeyEvents,
        femaleKeyEvents,
        knownUsers,
        totalUsers,
      };
    }

    const retRows: Ga4Returning["rows"] = [];
    for (const r of rReturn?.rows ?? []) {
      const raw = dim(r, 0).trim().toLowerCase();
      // GA4 emits a "(not set)" bucket here for sessions it cannot
      // classify; it carries no meaning for the question being asked.
      if (raw !== "new" && raw !== "returning") continue;
      retRows.push({
        kind: raw,
        label: raw === "new" ? "מבקרים חדשים" : "מבקרים חוזרים",
        sessions: met(r, 0),
        keyEvents: met(r, 1),
        convRate: met(r, 2),
      });
    }
    if (retRows.length > 0) returning = { rows: retRows };

    // Compare first-touch credit against the last-touch counts already
    // gathered above. Only campaigns that introduced MORE converters
    // than they closed are kept: the reverse direction is just "this
    // campaign is running now", which the main table already shows.
    const lastTouch = new Map<string, number>();
    for (const r of rCampaigns?.rows ?? []) {
      const name = cleanCampaign(dim(r, 0));
      if (!name) continue;
      const k = name.toLowerCase().replace(/[_-]+/g, "-");
      lastTouch.set(k, (lastTouch.get(k) ?? 0) + met(r, 3));
    }
    for (const r of rIntro?.rows ?? []) {
      const name = cleanCampaign(dim(r, 0));
      if (!name) continue;
      const introKe = met(r, 0);
      if (introKe <= 0) continue;
      const k = name.toLowerCase().replace(/[_-]+/g, "-");
      const closeKe = lastTouch.get(k) ?? 0;
      // A one-event gap is noise; require a real difference so this
      // block stays a finding rather than a rounding artefact.
      if (introKe - closeKe < 2) continue;
      intro.push({ campaign: name, introKeyEvents: introKe, closeKeyEvents: closeKe });
    }
    intro.sort((a, b) => b.introKeyEvents - b.closeKeyEvents - (a.introKeyEvents - a.closeKeyEvents));
    intro.splice(5);
  } catch {
    // Non-fatal — Google Signals may simply be off for this property.
  }

  const pages: Ga4PageRow[] = [];
  if (!wholeSite && normed.length > 1) {
    const [pageReport] = await batchRun(subjectEmail, propertyId, [
      withFilter({
        dateRanges: [cur],
        dimensions: [{ name: mode }],
        metrics: [
          { name: "sessions" },
          { name: "engagementRate" },
          { name: "averageSessionDuration" },
        ],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 50,
      }),
    ]);
    const byPath = new Map<string, Ga4PageRow>();
    for (const r of pageReport?.rows ?? []) {
      const p = normPath(dim(r, 0));
      const sessions = met(r, 0);
      const row = byPath.get(p) ?? { path: p, sessions: 0, engagementRate: 0, avgSeconds: 0 };
      const totalEr = row.engagementRate * row.sessions + met(r, 1) * sessions;
      const totalSecs = row.avgSeconds * row.sessions + met(r, 2) * sessions;
      row.sessions += sessions;
      row.engagementRate = row.sessions > 0 ? totalEr / row.sessions : 0;
      row.avgSeconds = row.sessions > 0 ? totalSecs / row.sessions : 0;
      byPath.set(p, row);
    }
    pages.push(...[...byPath.values()].sort((a, b) => b.sessions - a.sessions));
  }

  if (curSessions === 0 && trend.length === 0) return null;

  return {
    window: { start: win.start, end: win.end },
    prevWindow: { start: win.prevStart, end: win.prevEnd },
    trend,
    totals: { sessions: curSessions, users: curUsers },
    prevTotals: { sessions: prevSessions, users: prevUsers },
    quality: { engagementRate: curEr, avgSeconds: curDur, engagedSessions: curEng },
    prevQuality: { engagementRate: prevEr, avgSeconds: prevDur, engagedSessions: prevEng },
    sources,
    campaigns,
    campaignCoverage: coverage,
    unattributedSessions: unattributed,
    pages,
    cities: cities.sort((a, b) => b.sessions - a.sessions),
    // Suppressed entirely when the property tags no key events: with
    // nothing to convert, every placement trivially shows zero and the
    // block would accuse the whole account.
    placementLeaks: curKe > 0 ? placementLeaks : [],
    tree,
    israel: { ...israel, convRate: mergeRate(israel.convRate, israel.sessions) },
    abroad: (() => {
      const all = [...byCountry.values()];
      const sessions = all.reduce((n, c) => n + c.sessions, 0);
      return {
        sessions,
        keyEvents: all.reduce((n, c) => n + c.keyEvents, 0),
        convRate: mergeRate(
          all.reduce((n, c) => n + c.convRate, 0),
          sessions,
        ),
        topCountries: [...byCountry.entries()]
          .map(([country, v]) => ({
            country,
            sessions: v.sessions,
            keyEvents: v.keyEvents,
            convRate: mergeRate(v.convRate, v.sessions),
          }))
          .sort((a, b) => b.sessions - a.sessions)
          .slice(0, 6),
      };
    })(),
    devices,
    // Null rather than a zeroed block when the property tags nothing:
    // "0% conversion" and "conversions were never configured" look
    // identical in a tile and mean opposite things.
    conversions:
      curKe > 0 || prevKe > 0
        ? {
            keyEvents: curKe,
            prevKeyEvents: prevKe,
            sessionRate: curKeRate,
            prevSessionRate: prevKeRate,
            byEvent: byEvent.slice(0, 6),
          }
        : null,
    demographics,
    returning,
    intro,
    mode,
    wholeSite,
  };
}

/**
 * Which campaigns brought traffic to ONE city — the map drill-down.
 *
 * Kept out of the main payload on purpose: the full city x campaign
 * matrix is 100+ cities wide on a busy property, and a viewer opens at
 * most one of them. Served by /api/analytics/city.
 *
 * Combines the project's page filter with a city filter using an AND
 * group, so the result is "traffic to this project's pages, from this
 * city" rather than the whole property's traffic from that city.
 */
export async function fetchCityCampaigns(
  subjectEmail: string,
  propertyId: string,
  paths: string[],
  city: string,
  win: { start: string; end: string },
): Promise<Ga4CampaignRow[]> {
  const mode = await detectAttributionMode(subjectEmail, propertyId);
  const normed = paths.map(normPath).filter(Boolean);
  const wholeSite = normed.length === 1 && normed[0] === "/";

  const cityFilter = {
    filter: { fieldName: "city", stringFilter: { value: city, matchType: "EXACT" } },
  };
  let dimensionFilter: Record<string, unknown> = cityFilter;
  if (!wholeSite) {
    const rawValues = await resolveRawPageValues(subjectEmail, propertyId, mode, paths);
    if (rawValues.length === 0) return [];
    dimensionFilter = {
      andGroup: {
        expressions: [
          { filter: { fieldName: mode, inListFilter: { values: rawValues } } },
          cityFilter,
        ],
      },
    };
  }

  const [report] = await batchRun(subjectEmail, propertyId, [
    {
      dateRanges: [{ startDate: win.start, endDate: win.end }],
      dimensions: [{ name: "sessionCampaignName" }],
      metrics: [
        { name: "sessions" },
        { name: "engagedSessions" },
        { name: "averageSessionDuration" },
        { name: "keyEvents" },
        { name: "sessionKeyEventRate" },
      ],
      dimensionFilter,
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 50,
    },
  ]);

  const byName = new Map<string, Ga4CampaignRow>();
  let unattributed = 0;
  for (const r of report?.rows ?? []) {
    const sessions = met(r, 0);
    const name = cleanCampaign(dim(r, 0));
    if (!name) {
      unattributed += sessions;
      continue;
    }
    const k = name.toLowerCase().replace(/[_-]+/g, "-");
    const row = byName.get(k) ?? {
      campaign: name,
      sessions: 0,
      engaged: 0,
      avgSeconds: 0,
      keyEvents: 0,
      convRate: 0,
    };
    const totalSecs = row.avgSeconds * row.sessions + met(r, 2) * sessions;
    row.sessions += sessions;
    row.engaged += met(r, 1);
    row.avgSeconds = row.sessions > 0 ? totalSecs / row.sessions : 0;
    row.keyEvents += met(r, 3);
    row.convRate += met(r, 4) * sessions;
    byName.set(k, row);
  }

  const out = [...byName.values()]
    .map((c) => ({ ...c, convRate: mergeRate(c.convRate, c.sessions) }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 10);
  // Surfaced as a row rather than hidden, matching the main table — the
  // percentages a viewer computes in their head must have a denominator
  // they can see.
  if (unattributed > 0) {
    out.push({
      campaign: "לא שויך לקמפיין",
      sessions: unattributed,
      engaged: 0,
      avgSeconds: 0,
      keyEvents: 0,
      convRate: 0,
    });
  }
  return out;
}

/**
 * Cached entry point.
 *
 * 30 min while the window is still open — the newest point is yesterday
 * and GA4 finalizes within 24-48h, so nothing meaningful moves faster.
 * 24h once the window has closed, because that data is final and
 * re-fetching a past month hourly is pure waste.
 */
export async function fetchGa4Report(
  subjectEmail: string,
  propertyId: string,
  paths: string[],
  win: { start: string; end: string; prevStart: string; prevEnd: string },
): Promise<Ga4ReportData | null> {
  const closed = daysBetween(win.end, iso(ilToday())) > 2;
  // SCHEMA_V must be bumped whenever Ga4ReportData gains or renames a
  // field. Without it a cached payload from the previous shape is served
  // to the new component — which crashed the page on `data.devices.length`
  // when devices/cities/conversions were added, and would have stayed
  // broken for up to the 24h closed-window TTL.
  // v14: tree leaves chosen per campaign, not per row.
  const key = `ga4Report:v14:${propertyId}:${win.start}:${win.end}:${paths.join("|")}`;
  return unstable_cache(
    () => fetchGa4ReportUncached(subjectEmail, propertyId, paths, win),
    [key],
    { revalidate: closed ? 86_400 : 1_800, tags: ["ga4Report"] },
  )();
}
