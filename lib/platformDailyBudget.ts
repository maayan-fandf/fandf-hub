import { cache } from "react";
import { unstable_cache } from "next/cache";
import { sheetsClient } from "@/lib/sa";
import { readKeysCached } from "@/lib/keys";

/**
 * Actual daily budget per platform, per project — read from the SAME
 * creatives spreadsheet the Apps Script dashboard uses
 * (SHEET_ID_CREATIVES):
 *   - `fb-campaigns`     → Campaign daily budget (col C) + status
 *   - `קמפיין ID גוגל`   → Daily budget (col F)
 *
 * Campaigns are matched to a project exactly like the dashboard's
 * `matchProjectForCampaign_`: the campaign name must contain one of the
 * project's patterns from the Keys `campaign ID` column (comma-split,
 * longest-pattern-first so "peleg-yehud" wins over "peleg"). Only
 * ACTIVE Facebook campaigns count (Google has no status column → all);
 * Google campaigns with a real past end date are skipped.
 *
 * Returns Map<slugLower, { google, facebook }> of summed daily budgets.
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
  // Longest pattern first — greedy match (mirrors the dashboard).
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

async function fetchPlatformDailyBudgets(
  subjectEmail: string,
): Promise<Record<string, { google: number; facebook: number }>> {
  const out: Record<string, { google: number; facebook: number }> = {};
  const add = (slug: string, platform: "google" | "facebook", v: number) => {
    if (!out[slug]) out[slug] = { google: 0, facebook: 0 };
    out[slug][platform] += v;
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
          const slug = matchSlug(name, matchMap);
          if (slug) add(slug, "facebook", num(fbRows[r][iBud]));
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
          const slug = matchSlug(name, matchMap);
          if (slug) add(slug, "google", num(gRows[r][iBud]));
        }
      }
    }
  } catch {
    /* Best-effort enrichment — desk still works without actual daily. */
  }
  return out;
}

const fetchPlatformDailyBudgetsCrossRequest = unstable_cache(
  fetchPlatformDailyBudgets,
  ["platformDailyBudget"],
  { revalidate: TTL_SECONDS, tags: [CACHE_TAG] },
);

export const getPlatformDailyBudgets = cache((subjectEmail: string) =>
  fetchPlatformDailyBudgetsCrossRequest(subjectEmail),
);
