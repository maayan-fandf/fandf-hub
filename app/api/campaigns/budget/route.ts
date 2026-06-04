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
      let matchedRow = -1;
      for (let i = 0; i < rows.length; i++) {
        const ch = clean(rows[i][0]);
        if (ch && ch === channelInput) {
          matchedRow = i + 2; // values start at row 2
          break;
        }
      }
      if (matchedRow < 0) {
        return NextResponse.json(
          {
            ok: false,
            error: `Channel "${channelInput}" not found in tab "${slug}"`,
          },
          { status: 404 },
        );
      }
      tab = slug;
      row = matchedRow;
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
