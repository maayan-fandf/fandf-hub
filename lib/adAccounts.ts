import { cache } from "react";
import { unstable_cache } from "next/cache";
import { sheetsClient } from "@/lib/sa";

/**
 * Google Ads account-name → Customer ID map, read from the creatives
 * spreadsheet's "Accounts lookup" tab (the SAME sheet/columns the Apps
 * Script report uses to build its Google Ads deep-links):
 *   col F (idx 5) = Google account name, col G (idx 6) = Account ID.
 *
 * Used to fill the `Account` column in the budget CSV export — Google Ads
 * Editor's multi-account import matches accounts by Customer ID (not name).
 */

const CACHE_TAG = "adAccounts";
const TTL_SECONDS = 1800; // 30 min

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/** Mirror of the report's _normalizeAdAccountName_ so the two sides match. */
export function normalizeAdAccountName(s: unknown): string {
  return String(s ?? "")
    .replace(/[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/** normalized Google account name → Customer ID (digits only). */
export type GoogleAccountIds = Record<string, string>;

async function fetchGoogleAccountIds(
  subjectEmail: string,
): Promise<GoogleAccountIds> {
  const out: GoogleAccountIds = {};
  try {
    const sheets = sheetsClient(subjectEmail);
    const ssId = envOrThrow("SHEET_ID_CREATIVES");
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: "'Accounts lookup'!A1:H",
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const rows = (res.data.values ?? []) as unknown[][];
    for (let i = 1; i < rows.length; i++) {
      const name = normalizeAdAccountName(rows[i][5]); // col F
      const id = String(rows[i][6] ?? "").replace(/[^\d]/g, ""); // col G
      if (name && id) out[name] = id;
    }
  } catch {
    /* best-effort — export just leaves the Account column blank if this fails */
  }
  return out;
}

const fetchGoogleAccountIdsCrossRequest = unstable_cache(
  fetchGoogleAccountIds,
  ["adAccounts"],
  { revalidate: TTL_SECONDS, tags: [CACHE_TAG] },
);

export const getGoogleAccountIds = cache((subjectEmail: string) =>
  fetchGoogleAccountIdsCrossRequest(subjectEmail),
);
