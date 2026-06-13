import { cache } from "react";
import { unstable_cache } from "next/cache";
import { sheetsClient } from "@/lib/sa";
import { buildMatchMap, matchSlug } from "@/lib/campaignMatch";

/**
 * 7-day actual-spend average per project × platform, read from the SAME
 * standardized daily file the dashboard uses (SHEET_ID_PLATFORM_DAILY,
 * tabs GADS2 / FB / Taboola2 / OB2 — Date · Account · Campaign · Cost,
 * ILS-normalized). Campaigns are matched to projects with the shared
 * matcher. For each project×platform we take the most-recent 7 distinct
 * dates present in the data and average the daily cost — the same window
 * the dashboard's pacing tooltip shows as "ממוצע 7 ימים".
 */

const TABS = {
  google: "GADS2",
  facebook: "FB",
  taboola: "Taboola2",
  outbrain: "OB2",
} as const;
type Plat = keyof typeof TABS;
const PLATS = Object.keys(TABS) as Plat[];

const CACHE_TAG = "platformDailySpend";
const TTL_SECONDS = 1800; // 30 min

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}
const clean = (s: unknown) =>
  String(s ?? "").replace(/[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g, "").replace(/\s+/g, " ").trim();
const num = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
function findCol(headers: string[], names: string[]): number {
  const h = headers.map((x) => x.toLowerCase());
  for (const n of names) {
    const i = h.indexOf(n.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}
function parseDate(v: unknown): string {
  const s = clean(v);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return "";
}
/** Today (Asia/Jerusalem) as YYYY-MM-DD — the window anchor. */
function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(
    new Date(),
  );
}
/** Shift a YYYY-MM-DD date by `days` (UTC arithmetic, date-only). */
function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** slug → { google, facebook, taboola, outbrain } 7-day avg daily spend. */
export type DailySpend7d = Record<string, Record<Plat, number>>;

/** Per project×platform daily-spend detail — enough for both the 7-day
 *  average (pacing tooltip) AND the latest-day-vs-prior spike check. */
type PlatDetail = {
  /** Mean daily cost over the most-recent ≤7 distinct dates ("ממוצע 7 ימים"). */
  avg7d: number;
  /** Cost on the single most-recent date present. */
  latest: number;
  /** That most-recent date (YYYY-MM-DD). */
  latestDate: string;
  /** Mean daily cost over the ≤6 dates BEFORE the latest (the baseline a
   *  spike is measured against). 0 when there's no prior history. */
  prevAvg: number;
};
type DailyDetail = Record<string, Record<Plat, PlatDetail>>;

const EMPTY_DETAIL: PlatDetail = { avg7d: 0, latest: 0, latestDate: "", prevAvg: 0 };

async function fetchDailyDetail(subjectEmail: string): Promise<DailyDetail> {
  const out: DailyDetail = {};
  try {
    const matchMap = await buildMatchMap(subjectEmail);
    const sheets = sheetsClient(subjectEmail);
    const ssId = envOrThrow("SHEET_ID_PLATFORM_DAILY");
    const bg = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: ssId,
      ranges: PLATS.map((p) => `'${TABS[p]}'!A1:D`),
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const vrs = bg.data.valueRanges ?? [];

    // slug → platform → Map<date, summed cost>
    const acc: Record<string, Record<Plat, Map<string, number>>> = {};
    PLATS.forEach((plat, idx) => {
      const rows = (vrs[idx]?.values ?? []) as unknown[][];
      if (rows.length < 2) return;
      const hdr = rows[0].map(clean);
      const iDate = findCol(hdr, ["Date"]);
      const iCamp = findCol(hdr, ["Campaign name"]);
      const iCost = findCol(hdr, ["Cost"]);
      if (iDate < 0 || iCamp < 0 || iCost < 0) return;
      for (let r = 1; r < rows.length; r++) {
        const camp = clean(rows[r][iCamp]);
        if (!camp) continue;
        const slug = matchSlug(camp, matchMap);
        if (!slug) continue;
        const date = parseDate(rows[r][iDate]);
        if (!date) continue;
        if (!acc[slug]) {
          acc[slug] = {
            google: new Map(),
            facebook: new Map(),
            taboola: new Map(),
            outbrain: new Map(),
          };
        }
        const m = acc[slug][plat];
        m.set(date, (m.get(date) || 0) + num(rows[r][iCost]));
      }
    });

    // Anchor to the last 7 CALENDAR days ending today (Asia/Jerusalem) —
    // NOT "the 7 most-recent dates that have data". For a paused / sparse
    // channel the old approach reached back months and blended stale
    // values in (e.g. an avg mixing April with last December, or a 🔥
    // spike fired on 4-month-old data). A real trailing window means an
    // inactive channel correctly reads 0 (no recent spend) instead.
    const cutoff = shiftIso(todayIso(), -6);
    for (const slug of Object.keys(acc)) {
      out[slug] = {
        google: { ...EMPTY_DETAIL },
        facebook: { ...EMPTY_DETAIL },
        taboola: { ...EMPTY_DETAIL },
        outbrain: { ...EMPTY_DETAIL },
      };
      for (const plat of PLATS) {
        const m = acc[slug][plat];
        if (!m.size) continue;
        const dates = [...m.keys()]
          .filter((d) => d >= cutoff)
          .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
        if (!dates.length) continue; // no spend in the last 7 days → stays 0
        const sum = dates.reduce((s, d) => s + (m.get(d) || 0), 0);
        const prev = dates.slice(1);
        const prevSum = prev.reduce((s, d) => s + (m.get(d) || 0), 0);
        out[slug][plat] = {
          avg7d: sum / dates.length,
          latest: m.get(dates[0]) || 0,
          latestDate: dates[0] || "",
          prevAvg: prev.length ? prevSum / prev.length : 0,
        };
      }
    }
  } catch {
    /* best-effort — callers just omit the 7-day avg / spike if this fails */
  }
  return out;
}

const fetchDailyDetailCrossRequest = unstable_cache(
  fetchDailyDetail,
  ["platformDailyDetail"],
  { revalidate: TTL_SECONDS, tags: [CACHE_TAG] },
);

const readDailyDetail = cache((subjectEmail: string) =>
  fetchDailyDetailCrossRequest(subjectEmail),
);

export const getDailySpend7d = cache(
  async (subjectEmail: string): Promise<DailySpend7d> => {
    const detail = await readDailyDetail(subjectEmail);
    const out: DailySpend7d = {};
    for (const slug of Object.keys(detail)) {
      const d = detail[slug];
      out[slug] = {
        google: d.google.avg7d,
        facebook: d.facebook.avg7d,
        taboola: d.taboola.avg7d,
        outbrain: d.outbrain.avg7d,
      };
    }
    return out;
  },
);

/** One platform's overspend spike — the latest day ran materially above
 *  the trailing-days baseline (runaway campaign / broken cap). */
export type SpendSpike = {
  latest: number;
  prevAvg: number;
  /** latest ÷ prevAvg (≥ SPIKE_RATIO when flagged). */
  ratio: number;
  latestDate: string;
};
/** slug → platform → spike (only platforms that ARE spiking are present). */
export type DailySpendSpikes = Record<string, Partial<Record<Plat, SpendSpike>>>;

// A spike is the latest day ≥ 1.5× the prior-days average AND at least
// ₪200 in absolute terms (so a jump from ₪20→₪80 on a tiny account
// doesn't cry wolf). Shares the same cached read as getDailySpend7d.
const SPIKE_RATIO = 1.5;
const SPIKE_MIN_ILS = 200;

export const getDailySpendSpikes = cache(
  async (subjectEmail: string): Promise<DailySpendSpikes> => {
    const detail = await readDailyDetail(subjectEmail);
    // The spike day must be genuinely recent (within 2 days of today) —
    // otherwise a platform whose daily file lags (Taboola/Outbrain run a
    // couple weeks behind) would flag a "spike" on its last stale day.
    const recentCutoff = shiftIso(todayIso(), -2);
    const out: DailySpendSpikes = {};
    for (const slug of Object.keys(detail)) {
      const d = detail[slug];
      for (const plat of PLATS) {
        const p = d[plat];
        if (p.prevAvg <= 0 || p.latest < SPIKE_MIN_ILS) continue;
        if (p.latest < p.prevAvg * SPIKE_RATIO) continue;
        if (!p.latestDate || p.latestDate < recentCutoff) continue;
        if (!out[slug]) out[slug] = {};
        out[slug][plat] = {
          latest: p.latest,
          prevAvg: p.prevAvg,
          ratio: p.latest / p.prevAvg,
          latestDate: p.latestDate,
        };
      }
    }
    return out;
  },
);
