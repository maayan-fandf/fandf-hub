import { cache } from "react";
import { unstable_cache, revalidateTag } from "next/cache";
import { sheetsClient } from "@/lib/sa";

/**
 * Two-layer cached read of the `Keys` tab from the main spreadsheet.
 *
 * Layer 1 — `unstable_cache` (cross-request, 5 min TTL): the Keys tab
 * changes a few times a week (an admin manually edits the sheet to
 * onboard a project, swap a manager email, etc.). For everyone else
 * it's effectively static. Reading it on every request burns Sheets
 * API quota for no benefit.
 *
 * Layer 2 — React `cache()` (per-request dedup): a single page render
 * can call into 3-4 distinct code paths that each need Keys (project
 * membership, role inference, write-gate access checks, Chat webhook
 * lookup). Without dedup, even on a cache hit each caller would still
 * deserialize separately — `cache()` collapses concurrent in-flight
 * calls within one request to a single shared promise.
 *
 * Quota math: a normal page load was burning 3-5 Keys reads; with
 * just per-request dedup it dropped to 1; with cross-request cache it
 * drops to ~1 read per user every 5 min. Per-user read quota (300/min
 * default) is no longer load-bearing.
 *
 * Cache key includes subjectEmail because impersonated reads could in
 * theory return different row visibility per user (the SA respects the
 * caller's permissions). In practice all callers pass the same email
 * so it's effectively one entry per user.
 *
 * Staleness tradeoff: an admin who edits Keys (e.g. adds a new
 * project) has to wait up to 5 min for the change to land for users
 * with warm caches. If that becomes a problem we can either
 * 1) lower the TTL, or
 * 2) call `invalidateKeysCache()` from an admin-edit endpoint —
 *    revalidates the `keys` tag immediately. The helper is exported
 *    below for future use; not wired up yet because there's no admin
 *    edit UI for Keys today.
 */

const KEYS_CACHE_TAG = "keys";
const KEYS_CACHE_TTL_SECONDS = 300; // 5 min

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Strip zero-width / RTL-mark / surrogate noise that creeps into Hebrew
// header cells via copy-paste — same regex Apps Script uses to normalize
// Keys headers. Kept inline here so this module is the single source of
// truth for the normalization that was previously duplicated 4 times.
const KEYS_HEADER_NORMALIZE =
  /[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g;

async function fetchKeysFromSheet(
  subjectEmail: string,
): Promise<{ headers: string[]; rows: unknown[][] }> {
  const sheets = sheetsClient(subjectEmail);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: envOrThrow("SHEET_ID_MAIN"),
    range: "Keys",
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const values = (res.data.values ?? []) as unknown[][];
  if (!values.length) return { headers: [], rows: [] };
  const headers = (values[0] as unknown[]).map((h) =>
    String(h ?? "")
      .replace(KEYS_HEADER_NORMALIZE, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return { headers, rows: values.slice(1) };
}

const fetchKeysCrossRequest = unstable_cache(
  fetchKeysFromSheet,
  ["readKeys"],
  { revalidate: KEYS_CACHE_TTL_SECONDS, tags: [KEYS_CACHE_TAG] },
);

export const readKeysCached = cache(
  (subjectEmail: string) => fetchKeysCrossRequest(subjectEmail),
);

/**
 * Force the next read to bypass the cross-request cache. Call after
 * any code path that mutates the Keys tab (no such path today, but
 * worth having ready for the admin Keys editor on the backlog). Tag
 * invalidation is global across all subjectEmail entries.
 */
export function invalidateKeysCache(): void {
  revalidateTag(KEYS_CACHE_TAG);
}

/**
 * Find the index of the Chat-space column in a Keys headers array.
 *
 * The cell stores any of four shapes — webhook URL, room URL,
 * mail-embedded link, or bare space id — and `chatSpaceUrlFromWebhook`
 * normalizes them. The column was renamed `Chat Webhook` → `Chat Space`
 * on 2026-04-30; the transitional fallback that accepted the old name
 * was retired on 2026-05-01 after a soak period without regressions.
 *
 * Returns -1 when the header is missing.
 */
export function findChatSpaceColumnIndex(headers: string[]): number {
  return headers.indexOf("Chat Space");
}

/**
 * Resolve a sender email to the company name from the Keys sheet's
 * `Email Client` column (col E — comma-separated raw emails). Used by
 * the Gmail-origin task inbox: when the user converts an emailed task
 * to a hub task, we pre-select the matching company so they don't have
 * to re-pick it manually.
 *
 * Why company and not project: a single client email is usually
 * associated with multiple projects under one company (e.g. one PR
 * contact across 3 of the company's brands). Picking a project would
 * be wrong half the time; picking the company is unambiguous.
 *
 * Returns the first matching company. Case-insensitive email compare.
 * Empty string when no match (caller falls back to "user picks
 * manually").
 */
export async function findCompanyByClientEmail(
  senderEmail: string,
  subjectEmail: string,
): Promise<string> {
  const target = String(senderEmail || "").toLowerCase().trim();
  if (!target) return "";
  const { headers, rows } = await readKeysCached(subjectEmail);
  const iCompany = headers.indexOf("חברה");
  const iEmailClient = headers.findIndex((h) =>
    /email\s*client/i.test(h),
  );
  if (iCompany < 0 || iEmailClient < 0) return "";
  for (const row of rows) {
    const cell = String(row[iEmailClient] ?? "").toLowerCase();
    if (!cell) continue;
    // Comma-separated emails; some rows have whitespace or stray quotes.
    const emails = cell.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    if (emails.includes(target)) {
      return String(row[iCompany] ?? "").trim();
    }
  }
  return "";
}
