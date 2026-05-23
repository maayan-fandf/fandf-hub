import { cache } from "react";
import { unstable_cache } from "next/cache";
import { sheetsClient } from "@/lib/sa";
import { readKeysCached } from "@/lib/keys";

/**
 * Actual daily budget data, read from the SAME creatives spreadsheet the
 * Apps Script dashboard uses (SHEET_ID_CREATIVES):
 *   - `fb-campaigns`     → Campaign daily budget (col C) + status
 *   - `קמפיין ID גוגל`   → Daily budget (col F)
 *
 * Two views are returned from one read:
 *   - byProject:  Σ daily budget per platform per project (campaigns
 *     matched to a project exactly like the dashboard's
 *     matchProjectForCampaign_ — campaign name CONTAINS a Keys
 *     `campaign ID` pattern, longest-first). ACTIVE FB only; Google
 *     campaigns past their real end date skipped.
 *   - byCampaign: campaign-name (lowercased) → daily budget, so the
 *     budget desk can show the actual set budget on the specific
 *     campaign row (matched by its סוג / campaign-name cell).
 */

const CACHE_TAG = "platformDailyBudget";
const TTL_SECONDS = 300;

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

type MatchEntry = { slug: string; patterns: string[]; maxLen: number };

async function buildMatchMap(subjectEmail: string): Promise<MatchEntry[]> {
  const { headers, rows } = await readKeysCached(subjectEmail);
  const iSlug = headers.findIndex((h) => /campaign\s*id/i.test(h));
  const out: MatchEntry[] = [];
  for (const row of rows) {
    const raw = clean(iSlug >= 0 ? row[iSlug] : row[5]);
    if (!raw) continue;
    const patterns = raw
      .split(",")
      .map((s) => s.toLowerCase().trim())
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i);
    if (!patterns.length) continue;
    out.push({
      slug: patterns[0],
      patterns,
      maxLen: Math.max(...patterns.map((p) => p.length)),
    });
  }
  out.sort((a, b) => b.maxLen - a.maxLen);
  return out;
}

function matchSlug(campaignName: string, matchMap: MatchEntry[]): string | null {
  const cn = campaignName.toLowerCase();
  if (!cn) return null;
  for (const m of matchMap) {
    for (const p of m.patterns) {
      if (cn.indexOf(p) >= 0) return m.slug;
    }
  }
  return null;
}

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export type CampaignBudgets = {
  byProject: Record<string, { google: number; facebook: number }>;
  byCampaign: Record<string, number>;
};

async function fetchCampaignBudgets(
  subjectEmail: string,
): Promise<CampaignBudgets> {
  const byProject: Record<string, { google: number; facebook: number }> = {};
  const byCampaign: Record<string, number> = {};
  const addProj = (slug: string, platform: "google" | "facebook", v: number) => {
    if (!byProject[slug]) byProject[slug] = { google: 0, facebook: 0 };
    byProject[slug][platform] += v;
  };

  try {
    const matchMap = await buildMatchMap(subjectEmail);
    const sheets = sheetsClient(subjectEmail);
    const ssId = envOrThrow("SHEET_ID_CREATIVES");
    const today = todayIso();

    const bg = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: ssId,
      ranges: ["'fb-campaigns'!A1:F", "'קמפיין ID גוגל'!A1:F"],
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const [fb, g] = bg.data.valueRanges ?? [];

    // Facebook — ACTIVE campaigns only.
    const fbRows = (fb?.values ?? []) as unknown[][];
    if (fbRows.length > 1) {
      const hdr = fbRows[0].map(clean);
      const iName = findCol(hdr, ["Campaign name"]);
      const iBud = findCol(hdr, ["Campaign daily budget", "Daily budget"]);
      const iStatus = findCol(hdr, ["Campaign status", "Status"]);
      if (iName >= 0 && iBud >= 0) {
        for (let r = 1; r < fbRows.length; r++) {
          const name = clean(fbRows[r][iName]);
          if (!name) continue;
          const status = iStatus >= 0 ? clean(fbRows[r][iStatus]).toUpperCase() : "";
          if (status && status !== "ACTIVE") continue;
          const bud = num(fbRows[r][iBud]);
          byCampaign[name.toLowerCase()] = bud;
          const slug = matchSlug(name, matchMap);
          if (slug) addProj(slug, "facebook", bud);
        }
      }
    }

    // Google — skip campaigns whose real end date has passed (2037 = none).
    const gRows = (g?.values ?? []) as unknown[][];
    if (gRows.length > 1) {
      const hdr = gRows[0].map(clean);
      const iName = findCol(hdr, ["Campaign name"]);
      const iBud = findCol(hdr, ["Daily budget", "Campaign daily budget"]);
      const iEnd = findCol(hdr, ["End date", "End time"]);
      if (iName >= 0 && iBud >= 0) {
        for (let r = 1; r < gRows.length; r++) {
          const name = clean(gRows[r][iName]);
          if (!name) continue;
          let end = iEnd >= 0 ? clean(gRows[r][iEnd]) : "";
          if (end && end >= "2037-01-01") end = "";
          if (end && end < today) continue;
          const bud = num(gRows[r][iBud]);
          byCampaign[name.toLowerCase()] = bud;
          const slug = matchSlug(name, matchMap);
          if (slug) addProj(slug, "google", bud);
        }
      }
    }
  } catch {
    /* Best-effort enrichment — desk still works without actual daily. */
  }
  return { byProject, byCampaign };
}

const fetchCampaignBudgetsCrossRequest = unstable_cache(
  fetchCampaignBudgets,
  ["platformDailyBudget"],
  { revalidate: TTL_SECONDS, tags: [CACHE_TAG] },
);

export const getCampaignBudgets = cache((subjectEmail: string) =>
  fetchCampaignBudgetsCrossRequest(subjectEmail),
);
