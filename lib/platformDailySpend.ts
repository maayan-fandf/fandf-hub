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

/** slug → { google, facebook, taboola, outbrain } 7-day avg daily spend. */
export type DailySpend7d = Record<string, Record<Plat, number>>;

async function fetchDailySpend7d(subjectEmail: string): Promise<DailySpend7d> {
  const out: DailySpend7d = {};
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

    for (const slug of Object.keys(acc)) {
      out[slug] = { google: 0, facebook: 0, taboola: 0, outbrain: 0 };
      for (const plat of PLATS) {
        const m = acc[slug][plat];
        if (!m.size) continue;
        const dates = [...m.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
        const top = dates.slice(0, 7);
        const sum = top.reduce((s, d) => s + (m.get(d) || 0), 0);
        out[slug][plat] = top.length ? sum / top.length : 0;
      }
    }
  } catch {
    /* best-effort — pacing tooltip just omits the 7-day avg if this fails */
  }
  return out;
}

const fetchDailySpend7dCrossRequest = unstable_cache(
  fetchDailySpend7d,
  ["platformDailySpend"],
  { revalidate: TTL_SECONDS, tags: [CACHE_TAG] },
);

export const getDailySpend7d = cache((subjectEmail: string) =>
  fetchDailySpend7dCrossRequest(subjectEmail),
);
