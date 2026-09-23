import { cache } from "react";
import { unstable_cache } from "next/cache";
import { sheetsClient } from "@/lib/sa";

/**
 * Two splits of the live ערוצים table's CRM counts, read from the same CRM
 * report cells the project tab's own formulas sum:
 *
 *   newLeads   — of `לידים CRM`, how many are NEW:     "26 (11 חדשים)"
 *   cancelled  — of `תיאום וביטול` (the table's תיאומים), how many were
 *                cancelled:                            "4 (1 בוטלו)"
 *
 * NEW LEADS. `לידים CRM` is not one definition across the estate. Each
 * project tab sums its own CRM report with its own formula, and almost all
 * of them count returning leads too: BMBY tabs sum `סה"כ לידים` (new +
 * returning + duplicates), Sehel tabs sum `פניות חדשות` + `*פניות חוזרות`
 * (some also `*פניות כפולות`). אחוזת אפרידר, September: פייסבוק read 26, of
 * which 11 were new — while the CRM section, which counts registrations,
 * said 11. Same channel, two numbers, and ₪347 vs ₪820 per lead. So for
 * each distinct (report, key) pair the formula matches on, the report's
 * new-leads column is summed under that key — BMBY's `חדשים`, Sehel's
 * `פניות חדשות`, column C on both layouts.
 *
 * CANCELLED. `תיאום וביטול` is, as it says, scheduled + cancelled — but
 * assembled per layout: BMBY sums the report's `תואמו` and `בוטלו` (N+R on
 * The57, P+T on anda, by header MATCH on pisgat-zeev-nofarim), Sehel sums J
 * (arrived) + L (`פגישות בוטלו`) + M (future). The cancelled part is the
 * formula's own terms that sum a cancellation column, so it is by
 * construction a piece of the total it sits beside. The sheet has a `בוטלו`
 * column (Z) of its own, and it cannot stand in: 19 tabs lack it, and on the
 * Sehel tabs it is a copy of the BMBY formula summing column R — `הרשמות לא
 * מאושרות` in that layout, not a cancellation at all.
 *
 * READING A FORMULA. Each SUMIFS/SUMIF term names a CRM report (through a
 * `$C$n` cell on the project tab — C7 almost everywhere, C6 on Kaima, C7
 * and C8 on Reisdor_hamsa), a match key (`$D<row>`; on some tabs also
 * `$A<row>` — Carmei-Gat files google-search under both "google-search" and
 * "גוגל"; exact or wrapped in `"*"&…&"*"`; or a literal — hagada folds "ig"
 * and "an" into פייסבוק) and the column it sums (a letter, or a header named
 * by a project-tab cell). Distinct pairs, not terms: Reisdor_hamsa repeats
 * one Sehel term three times, so its total over-counts; the splits here do
 * not copy that.
 *
 * Anything else yields no number rather than a guess — a formula with no
 * `$C$n` report reference (the Salesforce tabs sum SHBNCRM!T directly, Gindi
 * reads a transposed layout), a report with no new-leads column, or a count
 * typed in by hand (tidhar-hever's המלצה: 1). A channel with one unreadable
 * row is dropped whole, so a partial sum never shows. Live period only: the
 * CRM reports hold the current window alone.
 */

const TTL_SECONDS = 300;

const CLEAN = /[​-‏‪-‮⁠­﻿\uD800-\uDFFF]/g;
const clean = (s: unknown) =>
  String(s ?? "").replace(CLEAN, "").replace(/\s+/g, " ").trim();
const lc = (s: unknown) => clean(s).toLowerCase();
/** The key getCrmSheetSplits' maps use for a channel label. */
export const splitKey = (channel: string) => lc(channel);
const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(clean(v));
  return Number.isFinite(n) ? n : 0;
};
/** "C" → 2, "AA" → 26. */
const colIndex = (letters: string) =>
  [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Column C's header on the two report layouts that count new leads — also
 *  how a report's header row is found. */
const NEW_HEADERS = new Set(["חדשים", "פניות חדשות"]);
/** A report column of cancelled MEETINGS: BMBY's `בוטלו`, Sehel's `פגישות
 *  בוטלו`. Not Sehel's `הרשמות בוטלו` / `חוזים בוטלו` — later stages. */
const CANCEL_HEADERS = new Set(["בוטלו", "פגישות בוטלו"]);

type Match = { key: string; how: "exact" | "contains" | "prefix" | "suffix" };
const wildcard = (lead: boolean, trail: boolean): Match["how"] =>
  lead && trail ? "contains" : lead ? "suffix" : trail ? "prefix" : "exact";
const matches = (b: string, m: Match) =>
  m.how === "exact"
    ? b === m.key
    : m.how === "contains"
      ? b.includes(m.key)
      : m.how === "prefix"
        ? b.startsWith(m.key)
        : b.endsWith(m.key);

/** What one term sums: a report column by letter, or by the header text a
 *  project-tab cell names (`MATCH(TRIM(N$9), …!2:2, 0)`). null = unknown. */
type SumCol = { letter: string } | { header: string } | null;
type Term = { tabRow: number; keys: Match[]; sum: SumCol };

/**
 * One formula's SUMIFS/SUMIF terms, or null when a term does not read a CRM
 * report through a `$C$n` cell. A key is whatever the term's criterion is:
 * a cell (`$D12`, `TRIM($D11)`, `"*"&$A11&"*"` — any row, since
 * Reisdor_hamsa's row 23 reaches for $A24 and the sheet counts what the
 * formula says) or a literal. A term whose criterion is `#REF!` (havradim)
 * counts nothing.
 */
function formulaTerms(
  formula: string,
  cellValue: (col: number, row: number) => string,
): Term[] | null {
  const starts = [...formula.matchAll(/\b(SUMIFS|SUMIF)\s*\(/gi)];
  if (!starts.length) return null;
  const terms = starts.map((s, i) =>
    parseTerm(
      s[1].toUpperCase(),
      formula.slice((s.index ?? 0) + s[0].length, starts[i + 1]?.index ?? formula.length),
      cellValue,
    ),
  );
  if (terms.some((t) => t.tabRow === -2)) return null;
  return terms.filter((t) => t.tabRow > 0);
}

/** tabRow -2 = unreadable term, -1 = a `#REF!` term that counts nothing. */
function parseTerm(
  fn: string,
  t: string,
  cellValue: (col: number, row: number) => string,
): Term {
  const bad: Term = { tabRow: -2, keys: [], sum: null };
  const tabRef = t.match(/\$C\$(\d+)/i);
  if (!tabRef) return bad;
  const keys: Match[] = [];
  let found = 0;
  // (?<!…) so "$AA11" or "SHEETA11" never reads as an A-column key.
  for (const m of t.matchAll(
    /("\*"\s*&\s*)?(?<![A-Za-z$])\$?([AD])\$?(\d+)(?!\d)(\s*&\s*"\*")?/gi,
  )) {
    found++;
    const key = lc(cellValue(m[2].toUpperCase() === "A" ? 0 : 3, Number(m[3])));
    if (key) keys.push({ key, how: wildcard(!!m[1], !!m[4]) });
  }
  // A literal criterion right after the B:B range, closing the call —
  // `"*"&$D11&"*"` is not one (a `&` follows its first quote pair).
  const lit = t.match(/B:B"\)\s*,\s*"([^"]*)"\s*\)/i);
  if (lit) {
    found++;
    const raw = lit[1];
    const key = lc(raw.replace(/^\*|\*$/g, ""));
    if (key)
      keys.push({ key, how: wildcard(raw.startsWith("*"), raw.length > 1 && raw.endsWith("*")) });
  }
  if (!found) return /#REF!/i.test(t) ? { tabRow: -1, keys: [], sum: null } : bad;

  // The summed column. SUMIFS(sum, criteria, key): its FIRST range. SUMIF(
  // criteria, key, sum): its LAST — or, on the INDEX/MATCH tabs, the header
  // the MATCH looks up.
  let sum: SumCol = null;
  const hdr = t.match(/MATCH\(\s*(?:TRIM\(\s*)?\$?([A-Z]{1,2})\$?(\d+)/i);
  const ranges = [...t.matchAll(/!([A-Za-z]{1,2}):([A-Za-z]{1,2})\b/g)]
    .filter((m) => m[1].toUpperCase() === m[2].toUpperCase())
    .map((m) => m[1].toUpperCase());
  if (hdr) {
    const h = clean(cellValue(colIndex(hdr[1]), Number(hdr[2])));
    if (h) sum = { header: h };
  } else if (fn === "SUMIFS" && ranges.length) {
    sum = { letter: ranges[0] };
  } else if (fn === "SUMIF") {
    const r = ranges.filter((x) => x !== "B");
    if (r.length) sum = { letter: r[r.length - 1] };
  }
  return { tabRow: Number(tabRef[1]), keys, sum };
}

export type CrmSheetSplits = {
  /** channel key → new leads within `לידים CRM`. */
  newLeads: Record<string, number>;
  /** channel key → cancelled within `תיאום וביטול`. Absent where the
   *  formula has no cancellation term, or cannot be read. */
  cancelled: Record<string, number>;
};

type Report = { header: string[]; lines: [string, unknown[]][] };
type Grid = unknown[][];
type Rows = Record<keyof CrmSheetSplits, { channel: string; terms: Term[] | null }[]>;

/**
 * A cell's value out of a FORMULA-rendered grid, without asking Sheets to
 * compute anything. Literals are themselves; a formula is resolved only
 * when it is a plain concatenation of cell references and string literals
 * (`=$C$4`, `=C4&"CRM"` — how Reisdor_hamsa names its report). Anything
 * else calls `onMiss`, and the caller redoes the read with computed values.
 *
 * WHY NOT JUST READ VALUES. On this spreadsheet a VALUES read costs ~3.8s
 * whatever its size — the project tabs are full of INDIRECT and TODAY(),
 * which are volatile, so every values read recalculates them — while a
 * FORMULA read of the same range takes ~250ms and all 45 CRM reports ~410ms
 * (measured 2026-09-23). The first version of this reader made two values
 * reads in a row and added ~8s to every live project page on a cold cache.
 */
function formulaCellReader(grid: Grid, onMiss: () => void) {
  const get = (col: number, row: number, depth: number): string => {
    const raw = grid[row - 1]?.[col];
    if (typeof raw !== "string" || !raw.startsWith("=")) return clean(raw);
    let out = "";
    for (const part of raw.slice(1).split("&")) {
      const p = part.trim();
      const lit = p.match(/^"([^"]*)"$/);
      const ref = p.match(/^\$?([A-Z]{1,2})\$?(\d+)$/i);
      if (lit) out += lit[1];
      else if (ref && depth < 5) out += get(colIndex(ref[1]), Number(ref[2]), depth + 1);
      else {
        onMiss();
        return "";
      }
    }
    return clean(out);
  };
  return (col: number, row: number) => get(col, row, 0);
}

/**
 * The project tab's current block: each row's terms per split, and which
 * `$C$n` cell names which report. `fx` is the FORMULA grid; `cellValue`
 * resolves the few cells whose VALUE matters (channel labels, keys, MATCH
 * headers, report names). The structural markers — the header row, "total",
 * a count typed in by hand — are literals, read straight off `fx`: a formula
 * never equals "התחלה", and no evaluation is spent on the rest of the tab.
 */
function parseProjectTab(
  fx: Grid,
  cellValue: (col: number, row: number) => string,
): { rows: Rows; tabOf: Map<number, string> } | null {
  // The current block's header — the same rule as lib/budgetMaster: the
  // first row below the top with B="התחלה" and D="מזהה BMBY".
  let hr = -1;
  for (let r = 1; r < fx.length; r++) {
    if (clean(fx[r]?.[1]) === "התחלה" && clean(fx[r]?.[3]) === "מזהה BMBY") {
      hr = r;
      break;
    }
  }
  if (hr < 0) return null;
  const head = (fx[hr] ?? []).map(clean);
  const cols = {
    newLeads: head.indexOf("לידים CRM"),
    cancelled: head.indexOf("תיאום וביטול"),
  };

  const rows: Rows = { newLeads: [], cancelled: [] };
  let lastChannel = "";
  for (let r = hr + 1; r < fx.length; r++) {
    if (clean(fx[r]?.[1]) === "total") break;
    const d = cellValue(3, r + 1);
    if (d) lastChannel = d;
    if (!lastChannel) continue;
    for (const split of ["newLeads", "cancelled"] as const) {
      const c = cols[split];
      if (c < 0) continue;
      const f = String(fx[r]?.[c] ?? "");
      if (!f.startsWith("=")) {
        // A continuation row with no count of its own (פייסבוק 45-60 / 60+
        // share one) adds nothing. A number typed in by hand is in the total
        // with no report behind it, so the channel cannot be split.
        if (num(fx[r]?.[c]) !== 0) rows[split].push({ channel: lc(lastChannel), terms: null });
        continue;
      }
      rows[split].push({ channel: lc(lastChannel), terms: formulaTerms(f, cellValue) });
    }
  }

  // The CRM reports those formulas point at.
  const tabOf = new Map<number, string>();
  for (const split of ["newLeads", "cancelled"] as const)
    for (const r of rows[split])
      for (const t of r.terms ?? []) {
        const name = cellValue(2, t.tabRow);
        if (name) tabOf.set(t.tabRow, name);
      }
  return { rows, tabOf };
}

/** A CRM report's header row (found by its new-leads column) and its lines
 *  keyed by column B, or null for a layout this reader does not know. */
function toReport(grid: Grid): Report | null {
  const h = grid.findIndex((r) => NEW_HEADERS.has(clean(r?.[2])));
  if (h < 0) return null;
  return {
    header: (grid[h] ?? []).map(clean),
    lines: grid
      .slice(h + 1)
      .map((r): [string, unknown[]] => [lc(r?.[1]), r ?? []])
      .filter(([b]) => !!b),
  };
}

async function fetchCrmSheetSplits(
  subjectEmail: string,
  projectTab: string,
): Promise<CrmSheetSplits> {
  const empty: CrmSheetSplits = { newLeads: {}, cancelled: {} };
  const ssId = process.env.SHEET_ID_MAIN;
  if (!ssId || !projectTab) return empty;
  const sheets = sheetsClient(subjectEmail);
  const read = (ranges: string[], o: "FORMULA" | "UNFORMATTED_VALUE") =>
    sheets.spreadsheets.values
      .batchGet({ spreadsheetId: ssId, ranges, valueRenderOption: o })
      .then((r) => (r.data.valueRanges ?? []).map((vr) => (vr.values ?? []) as Grid));

  // Deeper than the budget desk's A1:J60 as margin: tidhar-hever's block
  // already runs to row 45, and a row past the range would drop out of the
  // splits silently while ALL CLIENTS still counts it. The loop stops at the
  // block's "total" row anyway.
  const range = `${quote(projectTab)}!A1:AA200`;
  const [fx] = await read([range], "FORMULA");
  let missed = false;
  let parsed = parseProjectTab(fx ?? [], formulaCellReader(fx ?? [], () => (missed = true)));
  if (missed) {
    // A cell the formula grid alone cannot resolve — pay for the values once.
    const [vals] = await read([range], "UNFORMATTED_VALUE");
    parsed = parseProjectTab(fx ?? [], (c, r) => clean(vals?.[r - 1]?.[c]));
  }
  if (!parsed) return empty;
  const { rows, tabOf } = parsed;

  const tabs = [...new Set(tabOf.values())];
  if (!tabs.length) return empty;
  const ranges = (list: string[]) => list.map((t) => `${quote(t)}!A1:AZ1500`);
  // The reports are pasted, so their FORMULA grid IS their values — except a
  // stray formula cell here and there (one each in Reisdor_hamsa's two
  // reports). Any report holding one is re-read computed, alone.
  const reports = new Map<string, Report>();
  const slow: string[] = [];
  (await read(ranges(tabs), "FORMULA")).forEach((grid, i) => {
    if (grid.some((r) => r?.some((c) => typeof c === "string" && c.startsWith("="))))
      slow.push(tabs[i]);
    else {
      const rep = toReport(grid);
      if (rep) reports.set(tabs[i], rep);
    }
  });
  if (slow.length)
    (await read(ranges(slow), "UNFORMATTED_VALUE")).forEach((grid, i) => {
      const rep = toReport(grid);
      if (rep) reports.set(slow[i], rep);
    });

  const sumCol = (rep: Report, keys: Match[], col: number, seen: Set<string>, tab: string) => {
    let n = 0;
    for (const k of keys) {
      const id = `${tab}|${col}|${k.how}|${k.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const [b, row] of rep.lines) if (matches(b, k)) n += num(row[col]);
    }
    return n;
  };

  const out: CrmSheetSplits = { newLeads: {}, cancelled: {} };
  for (const split of ["newLeads", "cancelled"] as const) {
    const result = out[split];
    const unreadable = new Set<string>();
    /** Channels whose formula summed a cancellation column at all. */
    const hasPart = new Set<string>();
    for (const { channel, terms } of rows[split]) {
      if (!terms) {
        unreadable.add(channel);
        continue;
      }
      // Per ROW: two rows of one channel that each carry a formula are both
      // in the sheet's total, so both are in its split too.
      const seen = new Set<string>();
      let n = 0;
      for (const t of terms) {
        const tab = tabOf.get(t.tabRow);
        const rep = tab ? reports.get(tab) : undefined;
        if (!tab || !rep) {
          unreadable.add(channel);
          break;
        }
        if (split === "newLeads") {
          // Whatever column the term sums, the new part is column C under
          // the same key — BMBY's formula sums the total column H.
          n += sumCol(rep, t.keys, 2, seen, tab);
          hasPart.add(channel);
          continue;
        }
        if (!t.sum) {
          unreadable.add(channel);
          break;
        }
        const col =
          "letter" in t.sum ? colIndex(t.sum.letter) : rep.header.indexOf(t.sum.header);
        if (col < 0) {
          unreadable.add(channel);
          break;
        }
        if (!CANCEL_HEADERS.has(rep.header[col] ?? "")) continue;
        hasPart.add(channel);
        n += sumCol(rep, t.keys, col, seen, tab);
      }
      result[channel] = (result[channel] ?? 0) + n;
    }
    for (const ch of Object.keys(result))
      if (unreadable.has(ch) || !hasPart.has(ch)) delete result[ch];
  }
  return out;
}

const fetchCrmSheetSplitsCrossRequest = unstable_cache(
  fetchCrmSheetSplits,
  ["crmSheetSplits"],
  { revalidate: TTL_SECONDS, tags: ["crmSheetSplits", "allClients"] },
);

/**
 * New leads and cancelled meetings per channel for one project tab, keyed
 * by `splitKey(channel)` (ALL CLIENTS' `מזהה BMBY`). Channels it cannot
 * read are absent. Never throws.
 */
export const getCrmSheetSplits = cache(
  (subjectEmail: string, projectTab: string): Promise<CrmSheetSplits> =>
    fetchCrmSheetSplitsCrossRequest(subjectEmail, projectTab).catch(
      (): CrmSheetSplits => ({ newLeads: {}, cancelled: {} }),
    ),
);
