import { cache } from "react";
import { sheetsClient } from "@/lib/sa";

/**
 * Per-request memoized read of the `Keys` tab from the main spreadsheet.
 *
 * Why this exists: a single page render can call into 3-4 distinct code
 * paths that each need Keys (project membership, role inference, write-
 * gate access checks, Chat webhook lookup). Each one was issuing its own
 * Sheets API GET, so a normal page load burned 3-5 reads and an
 * authenticated comment write could burn 4-6. The Sheets API per-user
 * read quota (300/min by default) was getting hit during ordinary use.
 *
 * `cache()` from React dedupes calls with the same arguments within a
 * single request lifetime — Server Components, Route Handlers, and
 * Server Actions all share one cache, so all the readKeys callers across
 * `commentsWriteDirect`, `tasksWriteDirect`, `tasksDirect`, `userRole`
 * etc. collapse to a single Sheets GET per user per request.
 *
 * Subject-email is part of the cache key because each user's
 * impersonated read could in theory return a different row visibility.
 * In practice all callers pass the same email, so it's still one fetch.
 */
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

export const readKeysCached = cache(
  async (
    subjectEmail: string,
  ): Promise<{ headers: string[]; rows: unknown[][] }> => {
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
  },
);
