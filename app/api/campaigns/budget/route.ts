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

  const tab = String(body.tab || "").trim();
  const row = Number(body.row);
  const value = Number(body.value);
  const expectedChannel = clean(body.expectedChannel);
  const hasExpectedBudget =
    body.expectedBudget !== undefined && body.expectedBudget !== null;
  const expectedBudget = Number(body.expectedBudget);
  if (!tab) {
    return NextResponse.json(
      { ok: false, error: "tab is required" },
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
