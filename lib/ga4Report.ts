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

export type Ga4Point = { date: string; sessions: number; users: number };

export type Ga4SourceBucket = {
  key: string;
  label: string;
  sessions: number;
  engaged: number;
};

export type Ga4CampaignRow = {
  campaign: string;
  sessions: number;
  engaged: number;
  avgSeconds: number;
};

export type Ga4PageRow = {
  path: string;
  sessions: number;
  engagementRate: number;
  avgSeconds: number;
};

export type Ga4CityRow = { city: string; sessions: number; keyEvents: number };

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
  /** Sessions from outside Israel, kept as a single number so the map
   *  never silently implies 100% of traffic is plotted. */
  abroadSessions: number;
  devices: Ga4DeviceRow[];
  /** Null when the property tags no key events at all — a conversion
   *  block reading 0% would be indistinguishable from real failure. */
  conversions: Ga4ConversionData | null;
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
export function reportWindow(monthFilter?: string): {
  start: string;
  end: string;
  prevStart: string;
  prevEnd: string;
} {
  const yesterday = addDays(ilToday(), -1);
  let end = yesterday;
  let start = addDays(end, -27);

  const m = (monthFilter || "").trim();
  if (/^\d{4}-\d{2}$/.test(m)) {
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
const META_SOURCES = new Set(["fb", "facebook", "ig", "instagram", "an", "meta", "msg"]);
const PAID_MEDIUMS = new Set(["cpc", "ppc", "paid", "paidsearch", "paid_search"]);

const SOURCE_LABELS: Record<string, string> = {
  meta: "מטא (פייסבוק/אינסטגרם)",
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
      metrics: [{ name: "sessions" }, { name: "totalUsers" }],
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
    // 4 — where the traffic came from.
    withFilter({
      dateRanges: [cur],
      dimensions: [{ name: "sessionSourceMedium" }],
      metrics: [{ name: "sessions" }, { name: "engagedSessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 200,
    }),
    // 5 — per campaign, and per page when the project owns several.
    withFilter({
      dateRanges: [cur],
      dimensions: [{ name: "sessionCampaignName" }],
      metrics: [
        { name: "sessions" },
        { name: "engagedSessions" },
        { name: "averageSessionDuration" },
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
  for (const r of rSources?.rows ?? []) {
    const key = classifySource(dim(r, 0));
    const b = bucket.get(key) ?? {
      key,
      label: SOURCE_LABELS[key] ?? SOURCE_LABELS.other,
      sessions: 0,
      engaged: 0,
    };
    b.sessions += met(r, 0);
    b.engaged += met(r, 1);
    bucket.set(key, b);
  }
  const sources = [...bucket.values()].sort((a, b) => b.sessions - a.sessions);

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
    };
    // Duration is a per-session average, so combine it weighted by
    // sessions rather than averaging the averages.
    const totalSecs = row.avgSeconds * row.sessions + met(r, 2) * sessions;
    row.sessions += sessions;
    row.engaged += met(r, 1);
    row.avgSeconds = row.sessions > 0 ? totalSecs / row.sessions : 0;
    campMap.set(k, row);
  }
  const coverage = paidSessions > 0 ? usable / paidSessions : 0;
  const campaigns =
    coverage >= CAMPAIGN_COVERAGE_MIN
      ? [...campMap.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 8)
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
  let abroadSessions = 0;

  try {
    const [rCity, rDevice, rEvent] = await batchRun(subjectEmail, propertyId, [
      withFilter({
        dateRanges: [cur],
        dimensions: [{ name: "city" }, { name: "country" }],
        metrics: [{ name: "sessions" }, { name: "keyEvents" }],
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
    ]);

    for (const r of rCity?.rows ?? []) {
      const name = dim(r, 0).trim();
      const country = dim(r, 1).trim();
      const sessions = met(r, 0);
      // Foreign traffic on these properties is bot/proxy noise (one
      // property logged Delhi 192 / Dhaka 185 / Addis Ababa 124 sessions
      // in 28 days). Counted, never mapped.
      if (country !== "Israel") {
        abroadSessions += sessions;
        continue;
      }
      if (!name || name === "(not set)") continue;
      cities.push({ city: name, sessions, keyEvents: met(r, 1) });
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
  } catch {
    // Non-fatal — the section renders without these blocks.
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
    abroadSessions,
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
    mode,
    wholeSite,
  };
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
  const key = `ga4Report:v2:${propertyId}:${win.start}:${win.end}:${paths.join("|")}`;
  return unstable_cache(
    () => fetchGa4ReportUncached(subjectEmail, propertyId, paths, win),
    [key],
    { revalidate: closed ? 86_400 : 1_800, tags: ["ga4Report"] },
  )();
}
