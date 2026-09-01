/**
 * Resolve an F&F project to the GA4 property + page paths that represent
 * it, so `lib/ga4.ts` knows what to query.
 *
 * The input is the landing URL Keys already stores (col I) — no new
 * column. Measured 2026-08-13 across the Keys sheet: 43 of 46 project
 * rows carry a landing URL, and host+path is unique per project, so the
 * cell alone identifies the project's pages.
 *
 * ── Two quirks of that column, both real ──
 *
 * 1. It can hold SEVERAL comma-separated URLs. לוריא is
 *    `…/luria/, …/luria-total-package` and both are live pages with real
 *    traffic (228 and 315 users over 7 days), so the project's number is
 *    the sum. Split like the campaign-ID column does.
 * 2. Five projects sit at the domain root (`/`) — מילנייה, רובע איילון,
 *    רימון, חבר, מטרו. Each has its OWN domain, so they are distinct;
 *    but a bare `/` cannot be told apart by path alone.
 *
 * ── Why property lookup has two strategies ──
 *
 * GA4 property display names are NOT hostnames. Keys says
 * `landing.shbn.co.il` while the property is called `2026.shbn.co.il`;
 * `lp.afridar.co.il` is the property named `AFRIDAR`. So host→property
 * cannot be done by name matching.
 *
 * The authoritative mapping is the Admin API's stream `defaultUri`, but
 * that API is a separate enablement. So:
 *   - FIRST the Supermetrics `GA4` tab, which already lists
 *     (property id, property name, landing path) — one cheap sheet read
 *     that unambiguously resolves every project whose path is not `/`.
 *   - ONLY when that is ambiguous or missing, the Admin API, which costs
 *     one stream-list call per visible property and is therefore cached
 *     hard and consulted rarely.
 *   - LAST, the Data API's hostName dimension — which property actually
 *     RECEIVES this host. Added 2026-09-01 after the two above left seven
 *     projects blank: quirk 2 above (a bare `/`) makes the path useless,
 *     and `defaultUri` turned out to be maintained on almost nothing —
 *     it covered 63 hosts, none of them a landing host in use. Traffic
 *     resolved all seven to exactly one property each. See
 *     `loadTrafficHostMap` for why host is a safe discriminator where
 *     path is not.
 *
 * When neither resolves, we return null and the section hides. A wrong
 * property would show a client another developer's traffic, so silence
 * is the only acceptable failure mode here.
 */

import { cache } from "react";
import { sheetsClient, analyticsAccessToken } from "@/lib/sa";
import { getProjectLandingUrl } from "@/lib/projectsDirect";
import { normPath } from "@/lib/ga4";

export type Ga4Target = {
  propertyId: string;
  propertyName: string;
  host: string;
  /** Normalized paths on that property belonging to this project. */
  paths: string[];
  /** How the property was identified — shown in the UI's source line. */
  via: "sheet" | "stream" | "traffic";
};

/** Split the Keys landing cell into a host + its normalized paths. */
export function parseLandingCell(raw: string): { host: string; paths: string[] } {
  const paths: string[] = [];
  let host = "";
  for (const piece of (raw || "").split(",")) {
    const s = piece.trim();
    if (!s) continue;
    try {
      const u = new URL(s);
      const h = u.host.toLowerCase().replace(/^www\./, "");
      if (!host) host = h;
      // A cell mixing hosts would make the property ambiguous; keep only
      // the paths that belong to the first host we saw.
      if (h !== host) continue;
      paths.push(normPath(u.pathname));
    } catch {
      // Not a URL — ignore rather than guess.
    }
  }
  return { host, paths: [...new Set(paths)] };
}

// ── Strategy 1: the Supermetrics GA4 tab ────────────────────────────────

type PropRef = { id: string; name: string };

let sheetMapCache: { expiresAt: number; byPath: Map<string, PropRef[]> } | null =
  null;
let sheetMapInFlight: Promise<Map<string, PropRef[]>> | null = null;
const SHEET_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * path → properties that serve it, from the `GA4` tab of the creatives
 * workbook (columns: Account name, Account ID, GA4 property, GA4
 * property ID, Landing page, 7-day active users).
 */
async function loadSheetMap(
  subjectEmail: string,
): Promise<Map<string, PropRef[]>> {
  const now = Date.now();
  if (sheetMapCache && sheetMapCache.expiresAt > now) return sheetMapCache.byPath;
  if (sheetMapInFlight) return sheetMapInFlight;

  sheetMapInFlight = (async () => {
    const byPath = new Map<string, PropRef[]>();
    try {
      const ssId = process.env.SHEET_ID_CREATIVES;
      if (!ssId) return byPath;
      const sheets = sheetsClient(subjectEmail);
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: ssId,
        range: "'GA4'!A2:F10001",
      });
      for (const row of (res.data.values ?? []) as unknown[][]) {
        const path = normPath(String(row[4] ?? ""));
        if (!path || path === "(not set)") continue;
        const id = String(row[3] ?? "").trim();
        const name = String(row[2] ?? "").trim();
        if (!id) continue;
        const list = byPath.get(path) ?? [];
        if (!list.some((p) => p.id === id)) list.push({ id, name });
        byPath.set(path, list);
      }
      sheetMapCache = { expiresAt: Date.now() + SHEET_TTL_MS, byPath };
    } catch {
      // Leave the map empty — caller falls through to the Admin API.
    }
    return byPath;
  })();

  try {
    return await sheetMapInFlight;
  } finally {
    sheetMapInFlight = null;
  }
}

// ── Strategy 2: the Analytics Admin API ─────────────────────────────────

let hostMapCache: { expiresAt: number; byHost: Map<string, PropRef> } | null =
  null;
let hostMapInFlight: Promise<Map<string, PropRef>> | null = null;
const HOST_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";

/**
 * host → property, built from every visible property's web stream
 * `defaultUri`. Costs one call per property, so it is only ever built
 * for projects the sheet could not resolve, and cached for 12h.
 *
 * "Visible" means visible to the hub's fixed analytics identity (see
 * `analyticsSubject` in lib/sa.ts), which is what makes one process-wide
 * cache correct. While GA4 was read as the signed-in user this map was
 * still cached globally — so it silently described whichever viewer
 * happened to warm it first.
 *
 * Returns an empty map when the Admin API is disabled (403) — callers
 * treat that the same as "not found".
 */
async function loadHostMap(): Promise<Map<string, PropRef>> {
  const now = Date.now();
  if (hostMapCache && hostMapCache.expiresAt > now) return hostMapCache.byHost;
  if (hostMapInFlight) return hostMapInFlight;

  hostMapInFlight = (async () => {
    const byHost = new Map<string, PropRef>();
    try {
      const token = await analyticsAccessToken();
      const hdr = { authorization: `Bearer ${token}` };
      const sres = await fetch(`${ADMIN_API}/accountSummaries?pageSize=200`, {
        headers: hdr,
        cache: "no-store",
      });
      if (!sres.ok) return byHost;
      const sjson = (await sres.json()) as {
        accountSummaries?: {
          propertySummaries?: { property?: string; displayName?: string }[];
        }[];
      };
      const props: PropRef[] = [];
      for (const a of sjson.accountSummaries ?? []) {
        for (const p of a.propertySummaries ?? []) {
          const id = (p.property ?? "").split("/").pop() ?? "";
          if (id) props.push({ id, name: p.displayName ?? id });
        }
      }
      const results = await Promise.all(
        props.map(async (p) => {
          try {
            const r = await fetch(
              `${ADMIN_API}/properties/${p.id}/dataStreams?pageSize=50`,
              { headers: hdr, cache: "no-store" },
            );
            if (!r.ok) return null;
            const j = (await r.json()) as {
              dataStreams?: { webStreamData?: { defaultUri?: string } }[];
            };
            const hosts: string[] = [];
            for (const s of j.dataStreams ?? []) {
              const uri = s.webStreamData?.defaultUri;
              if (!uri) continue;
              try {
                hosts.push(new URL(uri).host.toLowerCase().replace(/^www\./, ""));
              } catch {
                /* skip malformed stream URIs */
              }
            }
            return { prop: p, hosts };
          } catch {
            return null;
          }
        }),
      );
      for (const r of results) {
        if (!r) continue;
        for (const h of r.hosts) if (!byHost.has(h)) byHost.set(h, r.prop);
      }
      if (byHost.size > 0) {
        hostMapCache = { expiresAt: Date.now() + HOST_TTL_MS, byHost };
      }
    } catch {
      // Admin API disabled or unreachable — empty map, caller gives up.
    }
    return byHost;
  })();

  try {
    return await hostMapInFlight;
  } finally {
    hostMapInFlight = null;
  }
}

// ── Strategy 3: hostName traffic, via the Analytics DATA API ────────────

let trafficMapCache: { expiresAt: number; byHost: Map<string, PropRef> } | null =
  null;
let trafficMapInFlight: Promise<Map<string, PropRef>> | null = null;
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";

/**
 * host → property, built from the hostName dimension of each property's
 * ACTUAL traffic.
 *
 * This is the discriminator the other two strategies were missing. The
 * GA4 tab records "Landing page", which is a PATH — so a project whose
 * landing URL is a bare origin (rimon.matzlawi.co.il/) maps to "/", the
 * one path every site on earth shares, and a project on a shared landing
 * host maps to a path several properties may report. Strategy 2 knew
 * about hosts but read them from each stream's `defaultUri`, a config
 * field nobody maintains: it covered 63 hosts and not one of the landing
 * hosts actually in use.
 *
 * Measured 2026-09-01 over all 68 visible properties: every unresolved
 * host maps to EXACTLY ONE property, including the two that defeated
 * every heuristic tried on the path data —
 *
 *   lp.g-dlevy.co.il  → 380361496 g-dlevy          44,221 sessions
 *   landing.shbn.co.il→ 533952214 2026.shbn.co.il  38,805 sessions
 *
 * A host is client-identifying in a way a path is not, which is what
 * makes this safe where a traffic tiebreak on `/projects` was not. The
 * dominance guard below is defensive only — no host measured has more
 * than one receiver — and covers a site dual-tagged mid-migration, where
 * both properties belong to the same client anyway.
 *
 * One runReport per property, so it is built only when strategies 1 and
 * 2 have both failed, and cached for 12h like the others.
 */
const TRAFFIC_DOMINANCE = 0.8;

async function loadTrafficHostMap(): Promise<Map<string, PropRef>> {
  const now = Date.now();
  if (trafficMapCache && trafficMapCache.expiresAt > now)
    return trafficMapCache.byHost;
  if (trafficMapInFlight) return trafficMapInFlight;

  trafficMapInFlight = (async () => {
    const byHost = new Map<string, PropRef>();
    try {
      const token = await analyticsAccessToken();
      const hdr = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };
      const sres = await fetch(`${ADMIN_API}/accountSummaries?pageSize=200`, {
        headers: hdr,
        cache: "no-store",
      });
      if (!sres.ok) return byHost;
      const sjson = (await sres.json()) as {
        accountSummaries?: {
          propertySummaries?: { property?: string; displayName?: string }[];
        }[];
      };
      const props: PropRef[] = [];
      for (const a of sjson.accountSummaries ?? []) {
        for (const p of a.propertySummaries ?? []) {
          const id = (p.property ?? "").split("/").pop() ?? "";
          if (id) props.push({ id, name: p.displayName ?? id });
        }
      }
      // host → every property reporting it, with session volume.
      const claims = new Map<string, { prop: PropRef; sessions: number }[]>();
      await Promise.all(
        props.map(async (p) => {
          try {
            const r = await fetch(`${DATA_API}/properties/${p.id}:runReport`, {
              method: "POST",
              headers: hdr,
              cache: "no-store",
              body: JSON.stringify({
                dateRanges: [{ startDate: "90daysAgo", endDate: "yesterday" }],
                dimensions: [{ name: "hostName" }],
                metrics: [{ name: "sessions" }],
                limit: 200,
              }),
            });
            if (!r.ok) return;
            const j = (await r.json()) as {
              rows?: {
                dimensionValues?: { value?: string }[];
                metricValues?: { value?: string }[];
              }[];
            };
            for (const row of j.rows ?? []) {
              const h = String(row.dimensionValues?.[0]?.value ?? "")
                .toLowerCase()
                .replace(/^www\./, "");
              if (!h) continue;
              const sessions = Number(row.metricValues?.[0]?.value ?? 0);
              const list = claims.get(h) ?? [];
              list.push({ prop: p, sessions });
              claims.set(h, list);
            }
          } catch {
            /* one property failing must not sink the map */
          }
        }),
      );
      for (const [host, list] of claims) {
        list.sort((a, b) => b.sessions - a.sessions);
        const total = list.reduce((a, x) => a + x.sessions, 0);
        if (total <= 0) continue;
        // Sole receiver, or one that dominates a dual-tagged site.
        if (list.length === 1 || list[0].sessions / total >= TRAFFIC_DOMINANCE) {
          byHost.set(host, list[0].prop);
        }
      }
      if (byHost.size > 0) {
        trafficMapCache = { expiresAt: Date.now() + HOST_TTL_MS, byHost };
      }
    } catch {
      // Data API unreachable — empty map, caller gives up as before.
    }
    return byHost;
  })();

  try {
    return await trafficMapInFlight;
  } finally {
    trafficMapInFlight = null;
  }
}

/**
 * Project → GA4 target, or null when it cannot be resolved with
 * certainty. Wrapped in React `cache()` for per-request dedup, matching
 * `getProjectLandingUrl` in lib/projectsDirect.ts.
 */
export const resolveGa4Target = cache(
  async (subjectEmail: string, project: string): Promise<Ga4Target | null> => {
    const raw = await getProjectLandingUrl(subjectEmail, project).catch(() => "");
    if (!raw) return null;
    const { host, paths } = parseLandingCell(raw);
    if (!host || paths.length === 0) return null;

    // Strategy 1 — unambiguous path match in the Supermetrics GA4 tab.
    const byPath = await loadSheetMap(subjectEmail);
    const candidates = new Map<string, PropRef>();
    let sawAmbiguous = false;
    for (const p of paths) {
      const hits = byPath.get(p) ?? [];
      if (hits.length > 1) sawAmbiguous = true;
      if (hits.length === 1) candidates.set(hits[0].id, hits[0]);
    }
    // Exactly one property across every path this project owns.
    if (candidates.size === 1 && !sawAmbiguous) {
      const only = [...candidates.values()][0];
      return {
        propertyId: only.id,
        propertyName: only.name,
        host,
        paths,
        via: "sheet",
      };
    }

    // Strategy 2 — authoritative host→stream mapping.
    const byHost = await loadHostMap();
    const viaHost = byHost.get(host);
    if (viaHost) {
      return {
        propertyId: viaHost.id,
        propertyName: viaHost.name,
        host,
        paths,
        via: "stream",
      };
    }

    // Strategy 3 — which property actually RECEIVES this host. Last
    // because it is the most expensive (one report per property), but it
    // is also the most authoritative: a bare-origin landing URL has no
    // usable path, and a shared landing host has no usable stream URI.
    const byTraffic = await loadTrafficHostMap();
    const viaTraffic = byTraffic.get(host);
    if (viaTraffic) {
      return {
        propertyId: viaTraffic.id,
        propertyName: viaTraffic.name,
        host,
        paths,
        via: "traffic",
      };
    }
    return null;
  },
);

/**
 * Why resolveGa4Target gave up — internal diagnostic only, never on the
 * resolution path.
 *
 * The section used to say "no property matched", which is true but not
 * actionable: the fix differs completely depending on whether the path is
 * absent from the GA4 tab or contested by several properties. Naming the
 * contenders turns it into something fixable from the page.
 *
 * Deliberately does NOT pick a winner. Two automatic rules were measured
 * against the seven contested projects (2026-09-01) and each one
 * mis-assigns a different client's property:
 *
 *   - most traffic on the path → gives ארצי (landing.shbn.co.il) the
 *     g-dlevy property, because g-dlevy.co.il outweighs 2026.shbn.co.il
 *     on a path as generic as /projects.
 *   - property name contains the landing host's domain → gives מארק שאגל
 *     the g-dlevy.co.il corporate property (2 users) over the g-dlevy
 *     landing property (4,174), whose name omits the TLD.
 *
 * Guessing wrong here shows one client another client's traffic, so the
 * conservative bail stays and the ambiguity is reported instead.
 */
export async function describeGa4Miss(
  subjectEmail: string,
  project: string,
): Promise<
  | { kind: "no-landing" }
  | { kind: "unmapped"; host: string; paths: string[] }
  | { kind: "ambiguous"; path: string; candidates: PropRef[] }
> {
  const raw = await getProjectLandingUrl(subjectEmail, project).catch(() => "");
  if (!raw) return { kind: "no-landing" };
  const { host, paths } = parseLandingCell(raw);
  if (!host || paths.length === 0) return { kind: "no-landing" };

  const byPath = await loadSheetMap(subjectEmail).catch(
    () => new Map<string, PropRef[]>(),
  );
  for (const p of paths) {
    const hits = byPath.get(p) ?? [];
    if (hits.length > 1) return { kind: "ambiguous", path: p, candidates: hits };
  }
  return { kind: "unmapped", host, paths };
}
