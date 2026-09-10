import { getCrmFeedNewestDays, getCrmFunnelForProject } from "@/lib/crmData";
import { readKeysCached } from "@/lib/keys";
import { driveFolderOwner } from "@/lib/sa";
import {
  horizonKey,
  type CrmDaily,
  type CrmDailyBundle,
} from "@/lib/crmDailyShared";

/**
 * Daily CRM leads for every project on the budget desk — the feed behind
 * the "לידים יומיים מה-CRM" toggle on /morning/budgets.
 *
 * SAME NUMBERS AS THE PROJECT PAGE, ON PURPOSE. The ask was the chart that
 * already exists ("מגמה לאורך זמן — לידים לפי ערוץ"), so each project goes
 * through getCrmFunnelForProject with the flight window the project page's
 * CRM card defaults to. A bespoke daily-count query would be lighter, and
 * would sooner or later disagree with the project page.
 *
 * PAGE-RENDER WORK, NOT AN API ROUTE. The expensive shared read — the whole
 * CRM sheet tab — is React cache()d per request (lib/crmData.ts header).
 * Inside one server render that is paid once for every project on the desk;
 * inside a route handler, where that cache does not dedupe, it would be paid
 * once per project. So the toggle is a URL param the page reads, and the
 * page hands the grid a promise.
 *
 * NEVER REJECTS. The grid unwraps the promise with use(), and app/ has no
 * error boundary — a rejection would take the whole budget desk down for a
 * chart. Every failure is caught and carried as data.
 *
 * Only what the chart draws crosses to the client; the full funnel also
 * carries status × source and objection × source matrices per project.
 */

const SUPPORTED = new Set(["bmby", "sehel", "salesforce"]);
/** Each warehouse-backed BMBY project is 3–5 SEQUENTIAL PostgREST round
 *  trips — that chain, not the shared Sheet reads, is the long pole. At 8
 *  the desk's 52 projects took 22.7–29.5 s on the dev machine (2026-09-10).
 *  supabaseRowsAll backs off and retries on 429, so a wider pool degrades
 *  to slower, not to failed. */
const CONCURRENCY = 16;

export type CrmDailyInput = {
  tab: string;
  name: string;
  company: string;
  /** Flight window, ISO. */
  from: string;
  to: string;
};

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

async function computeCrmDaily(
  projects: CrmDailyInput[],
): Promise<CrmDailyBundle> {
  const t0 = Date.now();
  try {
    const { headers, rows } = await readKeysCached(driveFolderOwner());
    const iProj = headers.indexOf("פרוייקט");
    const iCo = headers.indexOf("חברה");
    const iCrm = headers.indexOf("CRM");
    const iPlatform = headers.indexOf("CRM platform");

    // The same (project, company) match getCrmFunnelForProject runs,
    // repeated for one reason: that function returns the same null for "no
    // CRM mapping" and for "mapped, but no leads in the window" — and on
    // this desk those are opposite messages. The second is the alarm.
    const mappingOf = (project: string, company: string) => {
      if (iProj < 0 || iCrm < 0 || iPlatform < 0) return null;
      for (const r of rows as unknown[][]) {
        const rp = String(r[iProj] ?? "").trim();
        const rc = iCo >= 0 ? String(r[iCo] ?? "").trim() : "";
        if (rp !== project) continue;
        if (rc && company && rc !== company) continue;
        return {
          account: String(r[iCrm] ?? "").trim(),
          platform: String(r[iPlatform] ?? "").trim().toLowerCase(),
          company: rc,
        };
      }
      return null;
    };

    // Each feed's own newest day, alongside the pool — its Sheet reads are
    // the same cache()d tabs the funnels read, so they cost nothing extra.
    const feedNewest = getCrmFeedNewestDays().catch(
      () => ({}) as Record<string, string>,
    );
    const results = await mapPool(
      projects,
      CONCURRENCY,
      async (p): Promise<[string, CrmDaily]> => {
        const key = p.tab.toLowerCase().trim();
        const project = p.name.trim();
        const m = mappingOf(project, p.company.trim());
        const company = p.company.trim() || m?.company || "";
        if (!m || !m.account || !company) return [key, { status: "no-crm" }];
        // Measured 2026-09-10: one desk project carries "bmby, sehel" — a
        // value getCrmFunnelForProject rejects, so it gets no CRM card on its
        // own page either. Named here rather than folded into "no CRM".
        if (!SUPPORTED.has(m.platform)) {
          return [key, { status: "unsupported", platform: m.platform }];
        }
        try {
          const f = await getCrmFunnelForProject({
            company,
            project,
            projectWindow: { from: p.from, to: p.to },
          });
          if (!f || f.leads === 0) {
            return [
              key,
              { status: "no-leads", platform: m.platform, from: p.from, to: p.to },
            ];
          }
          let drawn = 0;
          for (const day of f.dailyTimeSeries) {
            for (const s of day.bySource) drawn += s.leads;
          }
          return [
            key,
            {
              status: "ok",
              platform: f.platform,
              from: f.windowFrom || p.from,
              to: f.windowTo || p.to,
              dataTo: f.dateRange?.to || "",
              // Salesforce has no warehouse table; its funnel carries no
              // dataSource and is always the Sheet.
              source: f.dataSource ?? "sheet",
              allSources: f.sourceMatrices.allSources,
              days: f.dailyTimeSeries,
              leads: f.leads,
              scheduled: f.scheduledMeetings,
              held: f.meetings,
              unsourced: Math.max(0, f.leads - drawn),
              dayTotals: f.dailyLeadTotals ?? {},
            },
          ];
        } catch (e) {
          return [
            key,
            { status: "error", message: e instanceof Error ? e.message : String(e) },
          ];
        }
      },
    );

    const byTab: Record<string, CrmDaily> = {};
    // Seeded from the feeds themselves; the desk projects' own last leads
    // below only ever push a horizon later, and stand in for a feed that
    // could not be read.
    const horizon: Record<string, string> = { ...(await feedNewest) };
    for (const [key, d] of results) {
      byTab[key] = d;
      if (d.status !== "ok") continue;
      const hk = horizonKey(d.platform, d.source);
      if (d.dataTo > (horizon[hk] || "")) horizon[hk] = d.dataTo;
    }
    const ms = Date.now() - t0;
    console.log(`[crmDaily] ${projects.length} projects in ${ms}ms`);
    return { byTab, horizon, ms };
  } catch (e) {
    return {
      byTab: {},
      horizon: {},
      ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Memoised per instance for ten minutes, single-flight.
 *
 * The desk paints without waiting for this (the page does not await it),
 * but a cold computation is tens of seconds, and a campaign manager who
 * opens the toggle, drills into a project and comes back should not pay it
 * twice. The feeds behind it sync nightly (the warehouse) or a few times a
 * day (the Sheets), so ten minutes stale costs nothing.
 *
 * NOT unstable_cache: getCrmFunnelForProject already reads Keys and the
 * enrichment through unstable_cache, and one unstable_cache nested inside
 * another resolves broken in this codebase (the 2026-05-16 nav bug written
 * up in lib/projectEnded.ts). Per-instance means up to one cold computation
 * per App Hosting instance — acceptable for a toggle.
 *
 * Only a bundle-level failure (Keys unreadable → nothing at all) is dropped
 * the moment it settles. A single project's "error" is memoised like
 * everything else: one project that keeps failing must not turn the memo
 * off for the whole desk, and it is retried when the ten minutes are up.
 */
const MEMO_TTL_MS = 10 * 60_000;
const memo = new Map<string, { at: number; p: Promise<CrmDailyBundle> }>();

export function getCrmDailyForBudgets(
  projects: CrmDailyInput[],
): Promise<CrmDailyBundle> {
  const now = Date.now();
  for (const [k, v] of memo) if (now - v.at >= MEMO_TTL_MS) memo.delete(k);
  const key = JSON.stringify(
    projects.map((p) => [p.tab, p.name, p.company, p.from, p.to]),
  );
  const hit = memo.get(key);
  if (hit) return hit.p;
  const p = computeCrmDaily(projects);
  memo.set(key, { at: now, p });
  void p.then((b) => {
    if (b.error && memo.get(key)?.p === p) memo.delete(key);
  });
  return p;
}
