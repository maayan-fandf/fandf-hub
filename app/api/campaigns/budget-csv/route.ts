import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { canSeeCampaigns } from "@/lib/userRole";
import { driveFolderOwner } from "@/lib/sa";
import { getBudgetMaster } from "@/lib/budgetMaster";
import { getCampaignBudgets } from "@/lib/platformDailyBudget";
import { UNASSIGNED_MANAGER } from "@/lib/budgetTypes";

export const dynamic = "force-dynamic";

/**
 * GET /api/campaigns/budget-csv?manager=<name>&platform=google
 *
 * Per-campaign-manager budget update CSV for **Google Ads Editor** import
 * (Phase 1). Columns: Campaign, Budget, Budget type, Project — Editor
 * matches by Campaign name within the open account and updates its daily
 * budget. For each Google channel row, the row's נדרש ליום (dailyRequired)
 * is split across its matched campaigns proportionally to their CURRENT
 * daily budget — the same סוג-token attribution the desk uses for
 * "יומי מוגדר", so the export matches what the manager sees.
 *
 * Campaigns can live in different Google Ads accounts and Editor imports
 * one account at a time, so each row carries a `Project` label (NOT the
 * reserved "Account" column — Editor would try to route by that; Project
 * is a human reference for filtering per account). Phase 2 will swap the
 * proportional split for pixel-CPL performance weighting with caps/floors.
 */
function csvField(v: string): string {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export async function GET(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  const allowed = await canSeeCampaigns(email).catch(() => false);
  if (!allowed) {
    return NextResponse.json({ ok: false, error: "Not authorized" }, { status: 403 });
  }

  const url = new URL(req.url);
  const manager = String(url.searchParams.get("manager") || "").trim();
  const company = String(url.searchParams.get("company") || "").trim();
  const platform = String(url.searchParams.get("platform") || "google").toLowerCase();
  // csv = downloadable file (incl. Project column for per-account filtering);
  // tsv = plain text for one-click "copy → paste into Make multiple changes".
  const format = String(url.searchParams.get("format") || "csv").toLowerCase();
  if (platform !== "google" && platform !== "facebook") {
    return NextResponse.json(
      { ok: false, error: "platform must be google or facebook" },
      { status: 400 },
    );
  }
  const isFb = platform === "facebook";

  const owner = driveFolderOwner();
  const [master, budgets] = await Promise.all([
    getBudgetMaster(owner),
    getCampaignBudgets(owner),
  ]);

  const projects = master.projects.filter((p) => {
    // Company filter (the per-חברה button) takes precedence when present.
    if (company) {
      return company === "ללא חברה" ? !p.company : p.company === company;
    }
    if (!manager) return true;
    if (manager === UNASSIGNED_MANAGER) return p.managers.length === 0;
    return p.managers.includes(manager);
  });

  type OutRow = {
    project: string;
    company: string;
    accountId: string;
    accountName: string;
    campaign: string;
    budget: number;
    campaignId: string;
  };
  const out: OutRow[] = [];

  for (const p of projects) {
    const camps = budgets.campaignsBySlug[p.tab.toLowerCase()] || [];
    const seen = new Set<string>(); // dedup a campaign across overlapping rows
    for (const r of p.rows) {
      if (r.platform !== platform || r.ended) continue;
      const target = Math.max(0, r.dailyRequired);
      if (target <= 0) continue;
      const tokens = r.campaignType
        .toLowerCase()
        .split(/[^a-z0-9֐-׿]+/)
        .filter((t) => t.length >= 2);
      if (!tokens.length) continue;
      const matched = camps.filter(
        (c) =>
          c.platform === platform &&
          !seen.has(c.nameLower) &&
          tokens.every((t) => c.nameLower.includes(t)) &&
          // FB matches by Campaign ID — skip campaigns we can't address.
          (!isFb || !!c.campaignId),
      );
      if (!matched.length) continue;
      const currentTotal = matched.reduce((s, c) => s + c.dailyBudget, 0);
      for (const c of matched) {
        seen.add(c.nameLower);
        const rec =
          currentTotal > 0
            ? (c.dailyBudget * target) / currentTotal
            : target / matched.length;
        out.push({
          project: p.name,
          company: p.company || "",
          accountId: p.gAdsAccountId || "",
          accountName: (isFb ? p.fbAcctName : p.gAdsAcctName) || "",
          campaign: c.name,
          budget: Math.max(1, rec),
          campaignId: c.campaignId,
        });
      }
    }
  }

  out.sort(
    (a, b) =>
      a.project.localeCompare(b.project, "he") ||
      a.campaign.localeCompare(b.campaign),
  );

  // Per-platform budget formatting: Google Ads Editor takes whole numbers;
  // FB bulk shows the daily budget in account currency with 2 decimals.
  const fmtBudget = (n: number) =>
    isFb ? (Math.round(n * 100) / 100).toFixed(2) : String(Math.round(n));

  // Column layout. The importer columns come first (Google Ads Editor / FB
  // bulk read these), then helper columns: Account name + חברה + פרוייקט for
  // sorting. For Google the `Account` = Customer ID so Editor's multi-account
  // import ("My data includes account information") routes each row to its
  // account; FB bulk is single-account, so it gets no Account/CID column.
  const header = isFb
    ? ["Campaign name", "Campaign Daily Budget", "Campaign ID", "Account name", "חברה", "פרוייקט"]
    : ["Account", "Campaign", "Budget", "Budget type", "Account name", "חברה", "פרוייקט"];
  const rowVals = (o: OutRow): string[] =>
    isFb
      ? [o.campaign, fmtBudget(o.budget), o.campaignId, o.accountName, o.company, o.project]
      : [o.accountId, o.campaign, fmtBudget(o.budget), "Daily", o.accountName, o.company, o.project];

  // TSV (copy-to-clipboard) → paste into Editor "Make multiple changes"
  // (Google, with the Account/CID column) / FB bulk import.
  if (format === "tsv") {
    const tlines = [header.join("\t")];
    for (const o of out) tlines.push(rowVals(o).join("\t"));
    return new NextResponse(tlines.join("\n") + "\n", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  // CSV (download) — same columns; lead with a UTF-8 BOM so Excel renders
  // the Hebrew Project/חברה columns correctly instead of mojibake.
  const lines = [header.map(csvField).join(",")];
  for (const o of out) {
    lines.push(rowVals(o).map(csvField).join(","));
  }
  const csv = "﻿" + lines.join("\r\n") + "\r\n";

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
  }).format(new Date());
  const scope = company || manager || "all";
  const safeScope = scope.replace(/[^a-z0-9_-]+/gi, "-") || "all";
  const filename = `${platform}-budgets-${safeScope}-${today}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
