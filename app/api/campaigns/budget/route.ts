import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { sheetsClient } from "@/lib/sa";
import { canSeeCampaigns } from "@/lib/userRole";
import { revalidateBudgetMaster } from "@/lib/budgetMaster";

export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns/budget
 * Body: { tab: string, row: number, value: number, expectedChannel: string }
 *
 * Writes one תקציב חודשי מאושר cell (column G) on a project tab of
 * SHEET_ID_MAIN — the inline edit on the קמפיינים → תקציבים grid.
 *
 * Safety:
 *  - Session auth + canSeeCampaigns gate (admins / managers / media).
 *  - USE_BUDGET_WRITES must be "1" (kill-switch; default off).
 *  - The target cell's channel (col D of the same row) is re-read and
 *    must match `expectedChannel` — guards against writing to the wrong
 *    cell if the sheet's activity table shifted since the page loaded.
 */

const clean = (s: unknown) =>
  String(s ?? "")
    .replace(/[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated" },
      { status: 401 },
    );
  }
  if (String(process.env.USE_BUDGET_WRITES || "").trim() !== "1") {
    return NextResponse.json(
      { ok: false, error: "Budget writes are disabled" },
      { status: 403 },
    );
  }
  const allowed = await canSeeCampaigns(email).catch(() => false);
  if (!allowed) {
    return NextResponse.json(
      { ok: false, error: "Not authorized to edit budgets" },
      { status: 403 },
    );
  }

  let body: {
    tab?: unknown;
    row?: unknown;
    /** Lookup mode (used by the project-page dashboard iframe): when
     *  `tab`+`row` aren't known to the caller, supply `slug` (the
     *  project's slug, which is also the project's tab name on
     *  SHEET_ID_MAIN) and `channel` (the channel name as shown in
     *  the per-channel table). The handler then scans the project
     *  tab's col D for the first row whose channel matches, and
     *  proceeds with the same drift check + write the standard mode
     *  uses. */
    slug?: unknown;
    channel?: unknown;
    value?: unknown;
    expectedChannel?: unknown;
    expectedBudget?: unknown;
    /** Distribute mode (project-page dashboard, merged channels only):
     *  some channel labels (e.g. Facebook on אחוזת אפרידר) span 2+
     *  merged BMBY rows on the project tab, one per audience/sub-
     *  campaign. The dashboard collapses them into one aggregated row
     *  with `c.subCampaigns.length > 1`. A single-row write would
     *  silently leave the other sub-rows alone and break the total.
     *  When `distribute: true`, the handler:
     *    (a) finds ALL matching D rows (not just the first),
     *    (b) drift-checks expectedBudget against their SUM,
     *    (c) splits `value` across them proportionally to each row's
     *        current G, rounded to ₪100; the rounding residual lands
     *        on the largest sub-row so the sum ties to `value` exactly,
     *    (d) writes all G values in one batchUpdate.
     *  When `distribute: false` (or absent), behavior is unchanged. */
    distribute?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  let tab = String(body.tab || "").trim();
  let row = Number(body.row);
  const value = Number(body.value);
  let expectedChannel = clean(body.expectedChannel);
  const hasExpectedBudget =
    body.expectedBudget !== undefined && body.expectedBudget !== null;
  const expectedBudget = Number(body.expectedBudget);

  // Lookup mode: resolve tab+row from slug+channel before validating.
  // Keeps the project-page dashboard iframe out of the sheet-coordinate
  // business — it only knows the project slug + channel name.
  const lookupMode = !tab && body.slug && body.channel;
  const distribute = !!body.distribute;
  if (lookupMode) {
    const slug = String(body.slug).trim();
    const channelInput = clean(body.channel);
    if (!slug || !channelInput) {
      return NextResponse.json(
        { ok: false, error: "slug and channel are required for lookup mode" },
        { status: 400 },
      );
    }
    try {
      const sheets = sheetsClient(email);
      const ssId = process.env.SHEET_ID_MAIN;
      if (!ssId) throw new Error("SHEET_ID_MAIN is not set");
      // Project tab name == slug. Read D2:G200 once to find the channel
      // row + drift-check the current budget in the same RPC.
      const ref = `'${slug.replace(/'/g, "''")}'`;
      const range = await sheets.spreadsheets.values.get({
        spreadsheetId: ssId,
        range: `${ref}!D2:G200`,
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const rows = range.data.values || [];
      // Find ALL matching rows in col D (not just the first). For
      // single-channel rows there's exactly one match → existing
      // behavior. For merged channels (e.g. Facebook split into
      // 45-60 / 60+ audiences) there are multiple matches.
      const matchedRows: Array<{ row: number; budget: number }> = [];
      for (let i = 0; i < rows.length; i++) {
        const ch = clean(rows[i][0]);
        if (ch && ch === channelInput) {
          matchedRows.push({
            row: i + 2,
            budget: Number(rows[i][3]) || 0,
          });
        }
      }
      if (matchedRows.length === 0) {
        return NextResponse.json(
          {
            ok: false,
            error: `Channel "${channelInput}" not found in tab "${slug}"`,
          },
          { status: 404 },
        );
      }

      // Distribute mode — split `value` proportionally across all
      // matched sub-rows. Returns its own response and bypasses the
      // single-row write path below.
      if (distribute && matchedRows.length > 1) {
        if (!Number.isFinite(value) || value < 0 || value > 100_000_000) {
          return NextResponse.json(
            { ok: false, error: "value out of range" },
            { status: 400 },
          );
        }
        const currentTotal = matchedRows.reduce((s, r) => s + r.budget, 0);
        // Drift guard on the SUM. The expected total the client saw
        // must match what's currently on the sheet — otherwise some
        // other writer moved a sub-row between page load and apply.
        if (hasExpectedBudget) {
          const driftAmt = Math.abs(currentTotal - expectedBudget);
          if (driftAmt >= 1) {
            return NextResponse.json(
              {
                ok: false,
                error: `Distributed total changed (expected ₪${Math.round(expectedBudget)}, found ₪${Math.round(currentTotal)} across ${matchedRows.length} sub-rows). Reload and retry.`,
              },
              { status: 409 },
            );
          }
        }
        // Per-row split, rounded to ₪100. If currentTotal is 0 (all
        // sub-rows blank) we split evenly across N rows.
        const splits = matchedRows.map((mr) => {
          const share =
            currentTotal > 0 ? mr.budget / currentTotal : 1 / matchedRows.length;
          return {
            row: mr.row,
            oldBudget: mr.budget,
            newBudget: Math.round((value * share) / 100) * 100,
          };
        });
        // Rounding residual lands on the largest sub-row so Σ ties
        // exactly to `value`.
        const sumSplits = splits.reduce((s, x) => s + x.newBudget, 0);
        const residual = Math.round(value - sumSplits);
        if (Math.abs(residual) >= 1 && splits.length) {
          let largestIdx = 0;
          for (let i = 1; i < splits.length; i++) {
            if (splits[i].newBudget > splits[largestIdx].newBudget) largestIdx = i;
          }
          splits[largestIdx].newBudget += residual;
        }
        try {
          await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: ssId,
            requestBody: {
              valueInputOption: "RAW",
              data: splits.map((s) => ({
                range: `${ref}!G${s.row}`,
                values: [[s.newBudget]],
              })),
            },
          });
          revalidateBudgetMaster();
          return NextResponse.json({
            ok: true,
            tab: slug,
            value,
            channel: channelInput,
            distributed: splits.map((s) => ({
              row: s.row,
              oldBudget: s.oldBudget,
              newBudget: s.newBudget,
            })),
          });
        } catch (e) {
          return NextResponse.json(
            {
              ok: false,
              error: e instanceof Error ? e.message : String(e),
            },
            { status: 500 },
          );
        }
      }

      // Non-distribute lookup: write to the first match (existing
      // behavior). If multiple sub-rows exist and the caller didn't
      // opt into distribute, we keep the historical behavior so
      // single-channel rows continue to work as before — but the
      // dashboard's edit handler now sends distribute:true for
      // merged channels, so this fall-through only fires for true
      // single-row channels.
      tab = slug;
      row = matchedRows[0].row;
      expectedChannel = channelInput;
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error: `Lookup failed: ${e instanceof Error ? e.message : String(e)}`,
        },
        { status: 500 },
      );
    }
  }

  if (!tab) {
    return NextResponse.json(
      { ok: false, error: "tab is required (or slug+channel for lookup)" },
      { status: 400 },
    );
  }
  if (!Number.isInteger(row) || row < 2 || row > 500) {
    return NextResponse.json(
      { ok: false, error: "row out of range" },
      { status: 400 },
    );
  }
  if (!Number.isFinite(value) || value < 0 || value > 100_000_000) {
    return NextResponse.json(
      { ok: false, error: "value out of range" },
      { status: 400 },
    );
  }

  try {
    const sheets = sheetsClient(email);
    const ssId = process.env.SHEET_ID_MAIN;
    if (!ssId) throw new Error("SHEET_ID_MAIN is not set");
    const ref = `'${tab.replace(/'/g, "''")}'`;

    // Drift guard: confirm we're about to overwrite the cell the client
    // actually showed. Re-read D (channel) + G (current budget) on the
    // row. Normally the channel must match. But a merged מזהה BMBY label
    // (e.g. Facebook split into 45-60 / 60+ audiences) leaves the
    // continuation row's D empty — there we fall back to confirming the
    // current G still equals the value the client displayed.
    const check = await sheets.spreadsheets.values.get({
      spreadsheetId: ssId,
      range: `${ref}!D${row}:G${row}`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const cells = check.data.values?.[0] ?? [];
    const actualChannel = clean(cells[0]); // D
    const actualBudget = Number(cells[3]) || 0; // G (D,E,F,G)

    let driftOk = true;
    if (actualChannel) {
      driftOk = !expectedChannel || actualChannel === expectedChannel;
    } else {
      // Merged/continuation row — verify by the budget value instead.
      driftOk = hasExpectedBudget
        ? Math.round(actualBudget) === Math.round(expectedBudget)
        : true;
    }
    if (!driftOk) {
      return NextResponse.json(
        {
          ok: false,
          error: `Row changed (expected "${expectedChannel}" / ₪${Math.round(expectedBudget)}, found "${actualChannel}" / ₪${Math.round(actualBudget)}). Reload and retry.`,
          actualChannel,
        },
        { status: 409 },
      );
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId,
      range: `${ref}!G${row}`,
      valueInputOption: "RAW",
      requestBody: { values: [[value]] },
    });

    revalidateBudgetMaster();
    return NextResponse.json({ ok: true, tab, row, value, channel: actualChannel });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
