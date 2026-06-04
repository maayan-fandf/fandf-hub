import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { canSeeCampaigns } from "@/lib/userRole";
import { sheetsClient, driveFolderOwner } from "@/lib/sa";
import { classifyChannel, E3_PLATFORMS } from "@/lib/budgetTypes";

export const dynamic = "force-dynamic";

/**
 * GET /api/campaigns/budget-summary?slug=<projectSlug>
 *
 * Returns the budget-master view for a single project — the same
 * numbers the קמפיינים → תקציבים grid displays — shaped for the
 * dashboard iframe's budget-balance strip:
 *
 *   {
 *     ok: true,
 *     slug, name, e3, allocated, delta, reconStatus,
 *     channels: [{ row, channel, platform, budget, spend, pacingRatio, ended }]
 *   }
 *
 * The iframe POSTs `fandf-get-budget-summary` to the hub; MetricsIframe
 * calls this endpoint and replies via postMessage. We keep the data
 * shaping minimal so any future drift-reallocation logic on the iframe
 * side can compute scores from what's here + the channel performance
 * data it already has from the Apps Script render.
 *
 * Auth: same gate as the budgets surface — admins / managers / media.
 * Clients never see the iframe button that triggers the request, but
 * the gate is enforced server-side too.
 */
export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  const allowed = await canSeeCampaigns(email).catch(() => false);
  if (!allowed) {
    return NextResponse.json(
      { ok: false, error: "Not authorized" },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const slug = String(url.searchParams.get("slug") || "").trim();
  if (!slug) {
    return NextResponse.json(
      { ok: false, error: "slug is required" },
      { status: 400 },
    );
  }

  try {
    const summary = await readSingleProjectBudget(slug);
    if (!summary) {
      return NextResponse.json(
        { ok: false, error: `Project tab "${slug}" not found or unreadable` },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/* ── single-tab fast path ─────────────────────────────────────────────
   The full master loader (`loadBudgetMaster`) fans out 4-5 parallel
   queries (Keys, campaigns, media plan, 7-day spend, Google account
   IDs) + a batchGet across every project tab. Good for the budgets
   page where the whole portfolio is rendered, terrible for the
   dashboard strip where we want one project's E3 + activity table.
   This reader does just that — one Sheets values.get for A1:J60 of
   the one tab. Same parsing rules as the full loader so the response
   shape stays compatible. */

type SingleSummary = {
  slug: string;
  name: string;
  e3: number;
  allocated: number;
  delta: number;
  reconStatus: "ok" | "over" | "under" | "no-target";
  totalDays: number;
  remainingDays: number;
  channels: Array<{
    row: number;
    channel: string;
    platform: string;
    budget: number;
    spend: number;
    pacingRatio: number;
    ended: boolean;
  }>;
};

const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/[₪,\s%]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const cleanStr = (v: unknown) =>
  String(v ?? "")
    .replace(/[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function parseSheetDate(v: unknown): string {
  if (v == null || v === "") return "";
  const s = String(v).trim();
  // ISO-ish first
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  // DD/MM/YYYY (most common in the sheet)
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) {
    const dd = dmy[1].padStart(2, "0");
    const mm = dmy[2].padStart(2, "0");
    return `${dmy[3]}-${mm}-${dd}`;
  }
  return "";
}

function todayInIsrael(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const d = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${d}`;
}

function dayDiff(fromIso: string, toIso: string): number {
  if (!fromIso || !toIso) return 0;
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

async function readSingleProjectBudget(
  slug: string,
): Promise<SingleSummary | null> {
  const sheets = sheetsClient(driveFolderOwner());
  const ssId = process.env.SHEET_ID_MAIN;
  if (!ssId) throw new Error("SHEET_ID_MAIN is not set");
  const ref = `'${slug.replace(/'/g, "''")}'`;
  let resp;
  try {
    resp = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: `${ref}!A1:J60`,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
  } catch {
    return null;
  }
  const grid = (resp.data.values ?? []) as unknown[][];
  if (!grid.length) return null;

  const cell = (r: number, c: number) => grid[r]?.[c];

  const e3 = num(cell(2, 4)); // E3
  const startIso = parseSheetDate(cell(3, 4)); // E4
  const endIso = parseSheetDate(cell(4, 4)); // E5
  const totalDays = Math.max(1, dayDiff(startIso, endIso) || 30);
  const today = todayInIsrael();
  const remainingDays = Math.max(0, dayDiff(today, endIso));

  // Locate the activity-table header (col B "התחלה" + col D "מזהה BMBY").
  let headerRow = -1;
  for (let r = 1; r < grid.length; r++) {
    if (cleanStr(cell(r, 1)) === "התחלה" && cleanStr(cell(r, 3)) === "מזהה BMBY") {
      headerRow = r;
      break;
    }
  }

  const channels: SingleSummary["channels"] = [];
  let allocated = 0;
  if (headerRow >= 0) {
    let lastChannel = "";
    for (let r = headerRow + 1; r < grid.length; r++) {
      const b = cleanStr(cell(r, 1));
      if (b === "total") break;
      let channel = cleanStr(cell(r, 3));
      const budget = num(cell(r, 6)); // G
      const spend = num(cell(r, 7)); // H
      // Forward-fill the channel across merged BMBY label rows.
      if (!channel) {
        const hasData =
          budget !== 0 || spend !== 0 || !!b || !!cleanStr(cell(r, 2));
        if (lastChannel && hasData) channel = lastChannel;
        else continue;
      }
      lastChannel = channel;
      const platform = classifyChannel(channel);
      const rowStart = parseSheetDate(cell(r, 1)) || startIso;
      const rowEnd = parseSheetDate(cell(r, 2)) || endIso;
      const rowTotal = Math.max(1, dayDiff(rowStart, rowEnd) || totalDays);
      const rowRemaining = Math.max(0, dayDiff(today, rowEnd));
      const rowElapsedFrac = Math.min(
        1,
        Math.max(0, rowTotal - rowRemaining) / rowTotal,
      );
      const ended = !!rowEnd && rowEnd < today;
      const expected = budget * rowElapsedFrac;
      const pacingRatio = expected > 0 ? spend / expected : 0;
      channels.push({
        row: r + 1, // 1-based
        channel,
        platform,
        budget,
        spend,
        pacingRatio,
        ended,
      });
      // Mirror the master's reconciliation: sum the E3_PLATFORMS toward
      // `allocated`. E3_PLATFORMS lives in budgetTypes.ts (currently
      // google / facebook / tiktok / taboola / outbrain). The earlier
      // hardcoded list left tiktok out, undercounting by ~one tiktok row.
      // "other" channels (פניה טלפונית / שילוט etc.) are tracked in the
      // rows but don't count toward the E3 balance.
      if ((E3_PLATFORMS as string[]).includes(platform)) {
        allocated += budget;
      }
    }
  }

  const delta = allocated - e3;
  const reconStatus: SingleSummary["reconStatus"] =
    e3 <= 0
      ? "no-target"
      : Math.abs(delta) < 1
        ? "ok"
        : delta > 0
          ? "over"
          : "under";

  return {
    slug,
    name: slug,
    e3,
    allocated,
    delta,
    reconStatus,
    totalDays,
    remainingDays,
    channels,
  };
}
