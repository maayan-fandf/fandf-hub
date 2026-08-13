"use client";

import { useState } from "react";
import { lookupCity, project, MAP_W, MAP_H, OUTLINE_PATH } from "@/lib/israelMap";
import ChannelIcon from "@/components/ChannelIcon";

export type CityRow = { city: string; sessions: number; keyEvents: number };
type CampaignRow = {
  campaign: string;
  sessions: number;
  engaged: number;
  avgSeconds: number;
  keyEvents: number;
  convRate: number;
};

/**
 * Visitors by Israeli city, with a per-city campaign drill-down.
 *
 * GA4 exposes no coordinates, only a city string, so positions come
 * from our own gazetteer (lib/israelMap.ts). Cities missing from it are
 * counted into a residual rather than dropped, so the numbers under the
 * map always reconcile with what GA reported.
 *
 * Dot AREA scales with sessions — using radius would make a city with
 * ten times the traffic look a hundred times bigger.
 *
 * The drill-down is fetched on click, not preloaded: the full
 * city x campaign matrix is large and a viewer opens at most one city.
 */
export default function Ga4CityMap({
  project: projectName,
  cities,
  abroad,
  unmapped,
  windowStart,
  windowEnd,
  showConv,
}: {
  project: string;
  cities: CityRow[];
  abroad: number;
  unmapped: number;
  windowStart: string;
  windowEnd: string;
  showConv: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [rows, setRows] = useState<CampaignRow[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  const plotted = cities
    .map((c) => {
      const pt = lookupCity(c.city);
      if (!pt) return null;
      const { x, y } = project(pt.lat, pt.lon);
      return { ...c, x, y };
    })
    .filter((p): p is CityRow & { x: number; y: number } => p !== null);

  const max = Math.max(...plotted.map((p) => p.sessions), 1);
  const radius = (n: number) => 1.4 + Math.sqrt(n / max) * 6.5;
  const totalIl = cities.reduce((n, c) => n + c.sessions, 0);

  const pick = async (city: string) => {
    if (open === city) {
      setOpen(null);
      return;
    }
    setOpen(city);
    setRows(null);
    setState("loading");
    try {
      const qs = new URLSearchParams({
        project: projectName,
        city,
        start: windowStart,
        end: windowEnd,
      });
      const res = await fetch(`/api/analytics/city?${qs}`, { cache: "no-store" });
      const json = (await res.json()) as
        | { ok: true; city: string; rows: CampaignRow[] }
        | { ok: false };
      if (!json.ok) {
        setState("error");
        return;
      }
      setRows(json.rows);
      setState("idle");
    } catch {
      setState("error");
    }
  };

  return (
    <div className="ga4w-block">
      <h3 className="ga4w-h3">מאיפה הגולשים</h3>
      <div className="ga4w-map">
        <svg
          viewBox={`0 0 ${MAP_W} ${MAP_H}`}
          role="img"
          aria-label="מפת מבקרים לפי עיר"
          className="ga4w-map-svg"
        >
          <path className="ga4w-map-land" d={OUTLINE_PATH} />
          {/* Largest last so small cities are never hidden underneath. */}
          {[...plotted]
            .sort((a, b) => a.sessions - b.sessions)
            .map((p) => (
              <circle
                key={p.city}
                cx={p.x}
                cy={p.y}
                r={radius(p.sessions)}
                className={
                  "ga4w-map-dot is-clickable" + (open === p.city ? " is-open" : "")
                }
                onClick={() => pick(p.city)}
              >
                <title>{`${p.city}: ${fmtInt(p.sessions)} — לחץ לפילוח לפי קמפיין`}</title>
              </circle>
            ))}
        </svg>

        <div className="ga4w-map-side">
          <table className="ga4w-table ga4w-map-list">
            <thead>
              <tr>
                <th>עיר</th>
                <th>כניסות</th>
                <th>חלק</th>
                {showConv && <th>המרות</th>}
              </tr>
            </thead>
            <tbody>
              {cities.slice(0, 8).map((c) => (
                <tr
                  key={c.city}
                  onClick={() => pick(c.city)}
                  className={
                    "ga4w-row-click" + (open === c.city ? " is-open" : "")
                  }
                >
                  <td>{c.city}</td>
                  <td>{fmtInt(c.sessions)}</td>
                  <td>{fmtPct(c.sessions / Math.max(1, totalIl))}</td>
                  {showConv && <td>{fmtInt(c.keyEvents)}</td>}
                </tr>
              ))}
            </tbody>
          </table>

          {open && (
            <div className="ga4w-drill">
              <div className="ga4w-drill-head">
                <strong>{open}</strong> — פילוח לפי קמפיין
                <button
                  type="button"
                  className="ga4w-drill-close"
                  onClick={() => setOpen(null)}
                  aria-label="סגור"
                >
                  ✕
                </button>
              </div>
              {state === "loading" && <div className="ga4w-note">טוען…</div>}
              {state === "error" && (
                <div className="ga4w-note">לא ניתן לטעון את הפילוח כרגע.</div>
              )}
              {state === "idle" && rows && rows.length === 0 && (
                <div className="ga4w-note">אין נתוני קמפיין לעיר הזו בתקופה.</div>
              )}
              {state === "idle" && rows && rows.length > 0 && (
                <div className="ga4w-table-wrap">
                  <table className="ga4w-table">
                    <thead>
                      <tr>
                        <th>קמפיין</th>
                        <th>כניסות</th>
                        {showConv && <th>אירועי מפתח</th>}
                        {showConv && <th>שיעור המרה</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.campaign}>
                          <td className="ga4w-camp">
                            <ChannelIcon name={r.campaign} /> {r.campaign}
                          </td>
                          <td>{fmtInt(r.sessions)}</td>
                          {showConv && <td>{fmtInt(r.keyEvents)}</td>}
                          {showConv && <td>{fmtPct(r.convRate)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="ga4w-note">
        {fmtInt(totalIl)} כניסות מישראל
        {unmapped > 0 && ` · ${fmtInt(unmapped)} מיישובים שאינם על המפה`}
        {abroad > 0 && ` · ${fmtInt(abroad)} מחוץ לישראל (לרוב תנועת בוטים)`}
        {" · "}מיקום מבוסס על כתובת ה-IP ולכן מקורב · לחיצה על עיר פותחת פילוח
        לפי קמפיין
      </div>
    </div>
  );
}

function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}
function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
}
