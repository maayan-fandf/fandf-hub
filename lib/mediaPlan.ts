import { cache } from "react";
import { unstable_cache } from "next/cache";
import { sheetsClient } from "@/lib/sa";
import type { MediaPlanRow } from "@/lib/budgetTypes";

/**
 * Per-project current media plan, read from the media file's
 * "פריסה נוכחית" tab — one row per project with the total budget,
 * utilization, lead funnel and flight dates. Powers the הראה פריסה
 * panel on the budget desk. Keyed by project slug (the column right
 * after פרוייקט, which holds the slug used as the report-link key).
 */

const CACHE_TAG = "mediaPlan";
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

function parseDate(v: unknown): string {
  const s = clean(v);
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m2) return `${m2[3]}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}`;
  return "";
}

async function fetchMediaPlan(
  subjectEmail: string,
): Promise<Record<string, MediaPlanRow>> {
  const out: Record<string, MediaPlanRow> = {};
  try {
    const sheets = sheetsClient(subjectEmail);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: envOrThrow("SHEET_ID_MAIN"),
      range: "'פריסה נוכחית'!A1:Z200",
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    const grid = (res.data.values ?? []) as unknown[][];

    // Find the header row (has פרוייקט + תקציב somewhere).
    let hr = -1;
    for (let r = 0; r < Math.min(grid.length, 10); r++) {
      const cells = (grid[r] ?? []).map(clean);
      if (cells.some((c) => /פרוייקט|פרויקט/.test(c)) && cells.some((c) => /תקציב/.test(c))) {
        hr = r;
        break;
      }
    }
    if (hr < 0) return out;
    const hdr = (grid[hr] ?? []).map(clean);
    const reCol = (re: RegExp) => hdr.findIndex((h) => re.test(h));
    const exact = (s: string) => hdr.findIndex((h) => h === s);

    const iName = reCol(/פרוייקט|פרויקט/);
    const iSlug = iName + 1; // קישור לדוח column holds the slug
    const iBudget = reCol(/תקציב/);
    const iSpend = reCol(/ניצול/);
    const iSpendPct = exact("%₪");
    const iLeads = reCol(/לידים/);
    const iCpl = reCol(/לליד/);
    const iMeetings = exact("תיאום");
    const iMeetingPct = reCol(/אחוז תיאום/);
    const iStart = reCol(/^עלי/);
    const iEnd = reCol(/ירידה/);
    const iTimePct = reCol(/⌛/);

    for (let r = hr + 1; r < grid.length; r++) {
      const row = grid[r] ?? [];
      const slug = clean(row[iSlug]).toLowerCase();
      if (!slug) continue;
      out[slug] = {
        budget: num(row[iBudget]),
        spend: num(row[iSpend]),
        spendPct: iSpendPct >= 0 ? num(row[iSpendPct]) : 0,
        leads: num(row[iLeads]),
        cpl: iCpl >= 0 ? num(row[iCpl]) : 0,
        meetings: iMeetings >= 0 ? num(row[iMeetings]) : 0,
        meetingPct: iMeetingPct >= 0 ? num(row[iMeetingPct]) : 0,
        startIso: iStart >= 0 ? parseDate(row[iStart]) : "",
        endIso: iEnd >= 0 ? parseDate(row[iEnd]) : "",
        timePct: iTimePct >= 0 ? num(row[iTimePct]) : 0,
      };
    }
  } catch {
    /* Best-effort — the panel just won't show if this fails. */
  }
  return out;
}

const fetchMediaPlanCrossRequest = unstable_cache(fetchMediaPlan, ["mediaPlan"], {
  revalidate: TTL_SECONDS,
  tags: [CACHE_TAG],
});

export const getMediaPlan = cache((subjectEmail: string) =>
  fetchMediaPlanCrossRequest(subjectEmail),
);
