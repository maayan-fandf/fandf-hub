/**
 * Server reader for the "Pricingsetup" tab (gid 663933425) on the
 * Comments spreadsheet. Columns A–E:
 *   חברה | פרוייקט | מחלקה | סוג | מחיר יחידה
 *
 * Tiny sheet, infrequently-hit surface (the new-task page), so a plain
 * read wrapped in React's per-request `cache()` is enough — no
 * unstable_cache (keeps it off the multi-instance / nested-cache
 * footguns; see feedback_no_nested_unstable_cache).
 *
 * The matcher + types live in the client-safe lib/pricingMatch so the
 * new-task form can resolve the price reactively without a round-trip.
 */

import { cache } from "react";
import { sheetsClient } from "@/lib/sa";
import type { PricingRow } from "@/lib/pricingMatch";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

/** Parse a price cell: tolerates "₪500", "1,200", " 500 ", numbers. */
function parsePrice(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const n = Number(String(raw ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export const readPricingSetup = cache(
  async (subjectEmail: string): Promise<PricingRow[]> => {
    try {
      const sheets = sheetsClient(subjectEmail);
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: envOrThrow("SHEET_ID_COMMENTS"),
        range: "Pricingsetup!A2:E1000",
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const values = (res.data.values ?? []) as unknown[][];
      const rows: PricingRow[] = [];
      for (const r of values) {
        const company = String(r[0] ?? "").trim();
        const department = String(r[2] ?? "").trim();
        const type = String(r[3] ?? "").trim();
        // A row is only usable if it can key on company + dept + type.
        if (!company || !department || !type) continue;
        rows.push({
          company,
          project: String(r[1] ?? "").trim(),
          department,
          type,
          unitPrice: parsePrice(r[4]),
        });
      }
      return rows;
    } catch (e) {
      // Non-fatal: the new-task form just shows "no pricing configured".
      console.log(
        "[pricing] readPricingSetup failed (non-fatal):",
        e instanceof Error ? e.message : String(e),
      );
      return [];
    }
  },
);
