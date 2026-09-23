import { cache } from "react";
import { unstable_cache } from "next/cache";
import { sheetsClient } from "@/lib/sa";

/**
 * How many of a ערוצים row's `לידים CRM` are NEW leads, for the live
 * table's "26 (11 חדשים)".
 *
 * `לידים CRM` is not one definition across the estate. Each project tab
 * sums its own CRM report with its own formula, and almost all of them
 * count returning leads too: BMBY tabs sum `סה"כ לידים` (new + returning
 * + duplicates), Sehel tabs sum `פניות חדשות` + `*פניות חוזרות` (some
 * also `*פניות כפולות`). אחוזת אפרידר, September: פייסבוק read 26, of
 * which 11 were new — while the CRM section, which counts registrations,
 * said 11. Same channel, two numbers, and ₪347 vs ₪820 per lead.
 *
 * So the new count is read from the SAME report the row's formula reads,
 * matched the SAME way: each SUMIFS/SUMIF term of the formula names a CRM
 * tab (through a `$C$n` cell on the project tab — C7 almost everywhere,
 * C6 on Kaima, C7 and C8 on Reisdor_hamsa) and a match key (`$D<row>`, on
 * some tabs also `$A<row>` — Carmei-Gat files google-search under both
 * "google-search" and "גוגל" — exact, or wrapped in `"*"&…&"*"`). For each
 * distinct (tab, key) pair the new-leads column of that tab is summed
 * under that key. Both report layouts carry one: BMBY's `חדשים`, Sehel's
 * `פניות חדשות`, in column C.
 *
 * Distinct pairs, not terms: Reisdor_hamsa's formula repeats one Sehel
 * term three times, so its total over-counts; the new count here does not
 * copy that.
 *
 * Anything else yields no number rather than a guess — a formula with no
 * `$C$n` tab reference (the Salesforce tabs sum SHBNCRM!T directly, Gindi
 * reads a transposed layout), or a report with no new-leads column. A
 * channel with one unreadable row is dropped whole, so a partial sum never
 * shows. Live period only: the CRM reports hold the current window alone.
 */

const TTL_SECONDS = 300;

const CLEAN = /[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g;
const clean = (s: unknown) =>
  String(s ?? "").replace(CLEAN, "").replace(/\s+/g, " ").trim();
const lc = (s: unknown) => clean(s).toLowerCase();
/** The key getCrmNewLeads' map uses for a channel label. */
export const newLeadsKey = (channel: string) => lc(channel);
const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

/** Column C's header on the two report layouts that count new leads. */
const NEW_HEADERS = new Set(["חדשים", "פניות חדשות"]);

type Match = { key: string; how: "exact" | "contains" | "prefix" | "suffix" };

const wildcard = (lead: boolean, trail: boolean): Match["how"] =>
  lead && trail ? "contains" : lead ? "suffix" : trail ? "prefix" : "exact";

/**
 * The (tab cell, key) pairs one row's formula matches on, or null when a
 * term does not read a CRM report through a `$C$n` cell.
 *
 * A key is whatever the term's criterion is: a cell (`$D12`, `TRIM($D11)`,
 * `"*"&$A11&"*"` — any row, since Reisdor_hamsa's row 23 reaches for $A24
 * and the sheet counts what the formula says) or a literal (hagada folds
 * Instagram and Audience Network into פייסבוק with `"ig"` and `"an"`). A
 * term whose criterion is `#REF!` (havradim) counts nothing.
 */
function formulaPairs(
  formula: string,
  cellValue: (col: "A" | "D", row: number) => string,
): { tabRow: number; match: Match }[] | null {
  const terms = formula.split(/SUMIFS?\s*\(/i).slice(1);
  if (!terms.length) return null;
  const pairs: { tabRow: number; match: Match }[] = [];
  for (const t of terms) {
    const tabRef = t.match(/\$C\$(\d+)/i);
    if (!tabRef) return null;
    const tabRow = Number(tabRef[1]);
    let found = 0;
    // (?<!…) so "$AA11" or "SHEETA11" never reads as an A-column key.
    for (const m of t.matchAll(
      /("\*"\s*&\s*)?(?<![A-Za-z$])\$?([AD])\$?(\d+)(?!\d)(\s*&\s*"\*")?/gi,
    )) {
      found++;
      const key = lc(cellValue(m[2].toUpperCase() as "A" | "D", Number(m[3])));
      if (key) pairs.push({ tabRow, match: { key, how: wildcard(!!m[1], !!m[4]) } });
    }
    // A literal criterion right after the B:B range, closing the call —
    // `"*"&$D11&"*"` is not one (a `&` follows its first quote pair).
    const lit = t.match(/B:B"\)\s*,\s*"([^"]*)"\s*\)/i);
    if (lit) {
      found++;
      const raw = lit[1];
      const key = lc(raw.replace(/^\*|\*$/g, ""));
      if (key)
        pairs.push({
          tabRow,
          match: { key, how: wildcard(raw.startsWith("*"), raw.length > 1 && raw.endsWith("*")) },
        });
    }
    if (!found) {
      if (/#REF!/i.test(t)) continue;
      return null;
    }
  }
  return pairs;
}

const matches = (b: string, m: Match) =>
  m.how === "exact"
    ? b === m.key
    : m.how === "contains"
      ? b.includes(m.key)
      : m.how === "prefix"
        ? b.startsWith(m.key)
        : b.endsWith(m.key);

async function fetchCrmNewLeads(
  subjectEmail: string,
  projectTab: string,
): Promise<Record<string, number>> {
  const ssId = process.env.SHEET_ID_MAIN;
  if (!ssId || !projectTab) return {};
  const sheets = sheetsClient(subjectEmail);
  // Deeper than the budget desk's A1:J60 as margin: tidhar-hever's block
  // already runs to row 45, and a row past the range would drop out of the
  // new count silently while ALL CLIENTS still counts it. The loop below
  // stops at the block's "total" row anyway.
  const range = `${quote(projectTab)}!A1:AA200`;
  const [vals, fx] = await Promise.all(
    (["UNFORMATTED_VALUE", "FORMULA"] as const).map((o) =>
      sheets.spreadsheets.values
        .get({ spreadsheetId: ssId, range, valueRenderOption: o })
        .then((r) => (r.data.values ?? []) as unknown[][]),
    ),
  );

  // The current block's header — the same rule as lib/budgetMaster: the
  // first row below the top with B="התחלה" and D="מזהה BMBY".
  let hr = -1;
  for (let r = 1; r < vals.length; r++) {
    if (clean(vals[r]?.[1]) === "התחלה" && clean(vals[r]?.[3]) === "מזהה BMBY") {
      hr = r;
      break;
    }
  }
  if (hr < 0) return {};
  const iLeads = (vals[hr] ?? []).findIndex((c) => clean(c) === "לידים CRM");
  if (iLeads < 0) return {};

  type RowPairs = { channel: string; pairs: ReturnType<typeof formulaPairs> };
  const rows: RowPairs[] = [];
  let lastChannel = "";
  for (let r = hr + 1; r < vals.length; r++) {
    if (clean(vals[r]?.[1]) === "total") break;
    const d = clean(vals[r]?.[3]);
    if (d) lastChannel = d;
    const f = String(fx[r]?.[iLeads] ?? "");
    if (!lastChannel) continue;
    if (!f.startsWith("=")) {
      // A continuation row with no count of its own (פייסבוק 45-60 / 60+
      // share one) adds nothing. A number typed in by hand (tidhar-hever's
      // המלצה: 1) is in the total with no report behind it, so the channel
      // cannot be split into new and returning.
      const typed = Number(vals[r]?.[iLeads]);
      if (Number.isFinite(typed) && typed !== 0)
        rows.push({ channel: lc(lastChannel), pairs: null });
      continue;
    }
    rows.push({
      channel: lc(lastChannel),
      pairs: formulaPairs(f, (col, row) => clean(vals[row - 1]?.[col === "A" ? 0 : 3])),
    });
  }

  // The CRM reports those formulas point at.
  const tabCells = new Set<number>();
  for (const r of rows) for (const p of r.pairs ?? []) tabCells.add(p.tabRow);
  const tabOf = new Map<number, string>();
  for (const n of tabCells) {
    const name = clean(vals[n - 1]?.[2]);
    if (name) tabOf.set(n, name);
  }
  const tabs = [...new Set(tabOf.values())];
  if (!tabs.length) return {};
  const bg = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: ssId,
    ranges: tabs.map((t) => `${quote(t)}!A1:C1500`),
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  /** tab → [source (col B, lowercased), new leads (col C)] below the header. */
  const report = new Map<string, [string, number][]>();
  (bg.data.valueRanges ?? []).forEach((vr, i) => {
    const grid = (vr.values ?? []) as unknown[][];
    const h = grid.findIndex((r) => NEW_HEADERS.has(clean(r?.[2])));
    if (h < 0) return;
    const out: [string, number][] = [];
    for (const r of grid.slice(h + 1)) {
      const b = lc(r?.[1]);
      const n = typeof r?.[2] === "number" ? r[2] : Number(clean(r?.[2]));
      if (b && Number.isFinite(n)) out.push([b, n]);
    }
    report.set(tabs[i], out);
  });

  const result: Record<string, number> = {};
  const unreadable = new Set<string>();
  for (const { channel, pairs } of rows) {
    if (!pairs) {
      unreadable.add(channel);
      continue;
    }
    const seen = new Set<string>();
    let n = 0;
    for (const p of pairs) {
      const tab = tabOf.get(p.tabRow);
      const lines = tab ? report.get(tab) : undefined;
      if (!tab || !lines) {
        unreadable.add(channel);
        break;
      }
      const id = `${tab}|${p.match.how}|${p.match.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const [b, v] of lines) if (matches(b, p.match)) n += v;
    }
    result[channel] = (result[channel] ?? 0) + n;
  }
  for (const ch of unreadable) delete result[ch];
  return result;
}

const fetchCrmNewLeadsCrossRequest = unstable_cache(
  fetchCrmNewLeads,
  ["crmNewLeads"],
  { revalidate: TTL_SECONDS, tags: ["crmNewLeads", "allClients"] },
);

/**
 * New leads per channel for one project tab, keyed by the channel label
 * lowercased (ALL CLIENTS' `מזהה BMBY`). Channels it cannot read are
 * absent. Never throws.
 */
export const getCrmNewLeads = cache(
  (subjectEmail: string, projectTab: string): Promise<Record<string, number>> =>
    fetchCrmNewLeadsCrossRequest(subjectEmail, projectTab).catch(() => ({})),
);
