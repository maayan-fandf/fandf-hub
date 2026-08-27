import { cache } from "react";
import { unstable_cache } from "next/cache";
import { sheetsClient, driveFolderOwner } from "@/lib/sa";

/**
 * Google campaign ID → campaign NAME.
 *
 * The bridge the per-campaign meeting join needs. BMBY records a Google
 * lead's campaign as `utm_campaign`, and Google's ValueTrack fills that with
 * the numeric campaign ID ("23977823260"), never the name — while every
 * surface that reports on Google campaigns (the ערוצים rows, the Google Ads
 * cards, the daily feed) is keyed on the NAME. Without this map the two
 * cannot meet, which is why Google ads have had a keyword-level meeting join
 * for a while and no campaign-level one.
 *
 * Source is the creatives workbook's own `קמפיין ID גוגל` tab, which the
 * Supermetrics side already maintains with Account / Campaign ID / Campaign
 * name / status / impressions.
 *
 * NOT every lead can be bridged: a chunk of the portfolio tags
 * `{campaigned}` — a typo'd ValueTrack placeholder (the real one is
 * `{campaignid}`) that never expands. Measured 2026-08-27 over BMBY's Google
 * leads since June: 441 of 1,627 carried the literal placeholder, all of it
 * concentrated in five ad accounts. Those leads resolve to nothing and are
 * dropped rather than bucketed somewhere plausible.
 */

const TAB = "קמפיין ID גוגל";
const TTL_SECONDS = 3600;
const CACHE_TAG = "googleCampaignNames";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/[​-‏‪-‮⁦-⁩﻿­]/g, "")
    .replace(/\s+/g, " ")
    .trim();

async function fetchMap(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const sheets = sheetsClient(driveFolderOwner());
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: envOrThrow("SHEET_ID_CREATIVES"),
      range: `'${TAB}'!A1:G`,
    });
    const rows = (res.data.values ?? []) as unknown[][];
    if (rows.length < 2) return out;
    const hdr = rows[0].map((h) => clean(h).toLowerCase());
    const iId = hdr.indexOf("campaign id");
    const iName = hdr.indexOf("campaign name");
    if (iId < 0 || iName < 0) return out;
    for (let r = 1; r < rows.length; r++) {
      const id = clean(rows[r][iId]);
      const name = clean(rows[r][iName]);
      // First wins: the tab holds one row per campaign, but a re-created
      // campaign can repeat an id — the earlier (current) name is the one
      // every other surface is keyed on.
      if (id && name && !out[id]) out[id] = name;
    }
  } catch (e) {
    // A missing bridge costs the campaign-level meeting join and nothing
    // else, so degrade rather than fail the export around it.
    console.warn(
      `[googleCampaignNames] failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return out;
}

const fetchCrossRequest = unstable_cache(fetchMap, ["googleCampaignNames"], {
  revalidate: TTL_SECONDS,
  tags: [CACHE_TAG],
});

/** id → name. Empty object when the tab is unreadable. */
export const getGoogleCampaignNames = cache(
  (): Promise<Record<string, string>> => fetchCrossRequest(),
);
