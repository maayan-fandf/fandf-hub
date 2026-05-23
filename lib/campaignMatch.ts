import { cache } from "react";
import { readKeysCached } from "@/lib/keys";

/**
 * Campaign → project matching, mirroring the Apps Script dashboard's
 * `matchProjectForCampaign_` / `buildMatchPatterns_`: a campaign belongs
 * to a project when the campaign name CONTAINS one of the project's
 * patterns from the Keys `campaign ID` column (comma-split), evaluated
 * longest-pattern-first so "peleg-yehud_business" wins over "peleg".
 * Shared by the daily-budget reader and the 7-day-spend reader.
 */

const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export type MatchEntry = { slug: string; patterns: string[]; maxLen: number };

async function build(subjectEmail: string): Promise<MatchEntry[]> {
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

export const buildMatchMap = cache(build);

export function matchSlug(
  campaignName: string,
  matchMap: MatchEntry[],
): string | null {
  const cn = campaignName.toLowerCase();
  if (!cn) return null;
  for (const m of matchMap) {
    for (const p of m.patterns) {
      if (cn.indexOf(p) >= 0) return m.slug;
    }
  }
  return null;
}
