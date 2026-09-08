import { sheetsClient, driveFolderOwner } from "@/lib/sa";
import {
  listAdAccounts,
  listAdSetTargeting,
  lookupCityNames,
  metaConfigured,
  MetaGraphError,
} from "@/lib/metaGraph";

/**
 * Who each ad set was aimed at — age range and geographic zone — pulled from
 * Meta into a tab the קהלים (Ad Sets) block joins onto.
 *
 * WHY. That block already ranks a project's ad sets by cost per lead, which
 * is the "what"; the targeting is the "why". An ad set at ₪180 a lead
 * against one at ₪60 is a mystery until you can see that the first is a
 * 1-mile pin on one neighbourhood and the second is a 10-mile radius.
 * Nothing else in the hub carries it: Supermetrics' adsets tab has cost and
 * leads only, and the Supabase warehouse has no targeting table at all.
 *
 * ITS OWN TAB, for the same reason the previews export has one — writing
 * into a Supermetrics-owned range means being wiped by the next refresh.
 *
 * INCREMENTAL, on `adset.updated_time`. A full portfolio walk is 5,055 ad
 * sets over 23 accounts and 79 seconds (measured 2026-09-08, zero failures).
 * That WOULD fit the cron's 300s beside the previews export's ~70s, but it
 * would spend most of a nightly run re-reading targeting that changes maybe
 * monthly. So the nightly run asks only for what moved, and merges.
 *
 * ── `synced_at` IS THE CURSOR, NOT A HEARTBEAT ──
 * Same trap as the previews tab: the stamp lands only on rows this run
 * re-pulled, so a night where no ad set changed is a complete success that
 * leaves it untouched. Do not use it to decide whether the cron ran.
 */

const SHEET_ID_CREATIVES =
  process.env.SHEET_ID_CREATIVES || "1q-WFtFLDnltznwYKax2yZ1O-q_VToULWN8-sn-8xXuA";
const TAB = "fb-adset-targeting";

const HEADER = [
  "campaign",
  "adset_name",
  "age_min",
  "age_max",
  "genders",
  "zones",
  /** Geometry for the hover minimap, one entry per zone in `zones` and in the
   *  same order: "lat,lon,radiusKm" joined by the zone separator, with an
   *  empty slot for a zone that has no point (a whole region or country). */
  "zone_points",
  "location_types",
  "adset_id",
  "account_id",
  "effective_status",
  "synced_at",
] as const;

/** Same hour of slack the previews export takes, and for the same reason:
 *  Meta's clock and ours are not the same clock. */
const OVERLAP_SECONDS = 60 * 60;

/** Zones join with " · " because a sheet cell is one string and the report
 *  splits on it. Chosen over a comma: place names contain commas. */
export const ZONE_SEP = " · ";

export type FbAdsetTargetingResult = {
  accounts: number;
  accountsFailed: { accountId: string; error: string }[];
  adSetsSeen: number;
  withZone: number;
  /** Coordinate pins resolved to a Hebrew city name this run. */
  citiesNamed: number;
  rowsWritten: number;
  mode: "full" | "incremental";
  since: string;
};

const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

export async function exportFbAdsetTargeting(
  opts: { full?: boolean } = {},
): Promise<FbAdsetTargetingResult> {
  if (!metaConfigured()) throw new Error("META_ACCESS_TOKEN is not set");
  const sheets = sheetsClient(driveFolderOwner());

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID_CREATIVES,
    fields: "sheets.properties(title)",
  });
  const exists = (meta.data.sheets ?? []).some((s) => s.properties?.title === TAB);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID_CREATIVES,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
    });
  }

  const byAdSetId = new Map<string, (string | number)[]>();
  let newestSync = "";
  if (exists) {
    const cur = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID_CREATIVES,
      range: `'${TAB}'!A:Z`,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    const vals = (cur.data.values ?? []) as (string | number)[][];
    if (vals.length > 1) {
      const hdr = (vals[0] as unknown[]).map((h) => clean(h));
      const idx = HEADER.map((c) => hdr.indexOf(c));
      const iId = hdr.indexOf("adset_id");
      const iSync = hdr.indexOf("synced_at");
      for (let r = 1; r < vals.length; r++) {
        const row = vals[r];
        const id = iId >= 0 ? clean(row[iId]) : "";
        if (!id) continue;
        // Reshaped onto OUR header order, so a hand-moved column cannot
        // misalign every preserved row.
        byAdSetId.set(
          id,
          idx.map((i) => (i >= 0 ? ((row[i] ?? "") as string | number) : "")),
        );
        const s = iSync >= 0 ? clean(row[iSync]) : "";
        if (s > newestSync) newestSync = s;
      }
    }
  }

  const full = !!opts.full || !byAdSetId.size || !newestSync;
  const sinceMs = full ? 0 : Date.parse(newestSync) - OVERLAP_SECONDS * 1000;
  const updatedSince = full || !Number.isFinite(sinceMs) ? undefined : Math.floor(sinceMs / 1000);

  const accounts = await listAdAccounts();
  const failed: { accountId: string; error: string }[] = [];
  const now = new Date().toISOString();
  let adSetsSeen = 0;
  let withZone = 0;
  /** Coordinate pins that the gazetteer turned into a city name. */
  let citiesNamed = 0;

  /** Everything pulled this run, held until the city gazetteer is resolved —
   *  a coordinate pin only becomes "ירושלים" after that lookup, and doing it
   *  once for the whole run beats one call per account. */
  const pulled: { accountId: string; sets: Awaited<ReturnType<typeof listAdSetTargeting>> }[] = [];

  for (const acct of accounts) {
    const id = clean(acct.account_id);
    if (!id) continue;
    try {
      const rows = await listAdSetTargeting(id, updatedSince);
      adSetsSeen += rows.length;
      pulled.push({ accountId: id, sets: rows });
    } catch (e) {
      // Per-account isolation: a revoked asset assignment on one account
      // must not cost the other twenty-two their targeting.
      failed.push({
        accountId: id,
        error:
          e instanceof MetaGraphError
            ? `${e.status}${e.code ? `/${e.code}` : ""} ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  }

  if (accounts.length && failed.length === accounts.length) {
    throw new Error(
      `all ${accounts.length} accounts failed — refusing to rewrite the tab: ${failed[0]?.error ?? ""}`,
    );
  }

  // ── name the coordinate pins ────────────────────────────────────────
  // One batched gazetteer call for the whole run. A pin that Meta cannot
  // name keeps its coordinate, which is worse to read but never wrong.
  const cityIds: string[] = [];
  for (const p of pulled) {
    for (const s of p.sets) for (const z of s.zones) if (z.cityId) cityIds.push(z.cityId);
  }
  const cityNames = await lookupCityNames(cityIds).catch(
    () => ({}) as Record<string, string>,
  );
  const COORD = /^-?\d+\.\d+,-?\d+\.\d+/;
  let named = 0;

  for (const { accountId, sets } of pulled) {
    for (const s of sets) {
      if (s.zones.length) withZone++;
      const labels: string[] = [];
      const points: string[] = [];
      for (const z of s.zones) {
        let label = z.label;
        // Only a pin that arrived WITHOUT a name of its own gets one here.
        // A `places` entry already carries Meta's own label ("קטמונים
        // ירושלים"), which is more specific than the city it sits in and
        // must not be overwritten by it.
        if (z.cityId && COORD.test(label)) {
          const city = cityNames[z.cityId];
          if (city) {
            label = label.replace(COORD, city);
            named++;
          }
        }
        labels.push(label);
        points.push(
          z.lat != null && z.lon != null
            ? `${z.lat.toFixed(5)},${z.lon.toFixed(5)},${(z.radiusKm ?? 0).toFixed(1)}`
            : "",
        );
      }
      byAdSetId.set(s.id, [
        s.campaign,
        s.name,
        s.ageMin,
        s.ageMax,
        s.genders,
        labels.join(ZONE_SEP),
        points.join(ZONE_SEP),
        s.locationTypes.join(","),
        s.id,
        accountId,
        s.effectiveStatus,
        now,
      ]);
    }
  }
  citiesNamed = named;

  const rows = [...byAdSetId.values()];
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID_CREATIVES,
    range: `'${TAB}'!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID_CREATIVES,
    range: `'${TAB}'!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [[...HEADER], ...rows] },
  });

  return {
    accounts: accounts.length,
    accountsFailed: failed,
    adSetsSeen,
    withZone,
    citiesNamed,
    rowsWritten: rows.length,
    mode: full ? "full" : "incremental",
    since: updatedSince ? new Date(updatedSince * 1000).toISOString() : "",
  };
}
