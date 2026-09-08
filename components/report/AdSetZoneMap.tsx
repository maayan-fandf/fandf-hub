import { MAP_W, MAP_H, OUTLINE_PATH, project } from "@/lib/israelMap";

/**
 * Where an ad set was actually aimed, drawn.
 *
 * WHY IT EXISTS. Meta stores a radius target as a bare coordinate —
 * "31.778,35.192 (10mi)" — and the export names the city it sits in, which
 * answers "which town" but not "how much of it". A 1-mile pin on one
 * neighbourhood and a 10-mile pin covering half a metropolitan area both read
 * as "ירושלים" on the line; only the circle shows the difference, and that
 * difference is usually the reason one ad set costs three times the other.
 *
 * No tiles, no map provider, no API key: this reuses the country outline and
 * the equirectangular projection that lib/israelMap already carries for the
 * GA4 city map. It is a locator, not a street map — enough to see WHERE and
 * HOW WIDE at a glance, which is the whole question.
 *
 * Stateless and pure: it is imported by the (client) creatives tab and so
 * ships in that bundle, but it adds no hooks, no effects and no listeners —
 * the hover is CSS. The only weight is the outline path, which the GA4 map
 * already pulls into the same app.
 */

/** Degrees of latitude per kilometre — the constant that turns Meta's radius
 *  into SVG units. Longitude degrees shrink with latitude, but the projection
 *  already applies that correction on the x axis, so scaling the circle by
 *  the LATITUDE ratio keeps it round and correctly sized at Israel's span. */
const KM_PER_DEG_LAT = 111.32;

export type Zone = { label: string; point: [number, number, number] | null };

export default function AdSetZoneMap({ zones }: { zones: Zone[] }) {
  const pins = zones
    .map((z) => (z.point ? { label: z.label, p: z.point } : null))
    .filter((v): v is { label: string; p: [number, number, number] } => !!v);
  if (!pins.length) return null;

  // One SVG unit on the y axis = this many degrees of latitude.
  const degPerUnitY = (33.35 - 29.45) / MAP_H;

  /**
   * CROPPED to the targeted area, not the whole country.
   *
   * Israel at full extent projects to 100 × 261 units — a sliver four times
   * taller than it is wide. At any size that fits beside a card it reads as a
   * vertical bar, and a 6km radius on it is one pixel. Zooming to the pins
   * (the outline still draws, so the coastline and border give the context)
   * turns the same data into a map you can actually place.
   *
   * MIN_SPAN stops a 1-mile pin from zooming to a blank patch of nothing with
   * no coastline in frame; the aspect fix keeps the box from being a sliver of
   * its own when every pin sits on one line.
   */
  const MIN_SPAN = 55; // units ≈ 82km, enough to keep a landmark in frame
  const ASPECT = 0.78; // w/h — portrait, matching the country and the card
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const { p } of pins) {
    const [lat, lon, km] = p;
    const { x, y } = project(lat, lon);
    const r = km > 0 ? km / KM_PER_DEG_LAT / degPerUnitY : 0;
    x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r);
    y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let h = Math.max((y1 - y0) * 2.2, (x1 - x0) * 2.2 / ASPECT, MIN_SPAN);
  h = Math.min(h, MAP_H);
  const w = h * ASPECT;
  const vb = [cx - w / 2, cy - h / 2, w, h];

  return (
    <svg
      className="rpt-cr-zonemap-svg"
      viewBox={vb.map((n) => n.toFixed(2)).join(" ")}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`אזורי טירגוט: ${pins.map((p) => p.label).join(", ")}`}
    >
      <path className="ga4w-map-land" d={OUTLINE_PATH} />
      {pins.map(({ label, p }, i) => {
        const [lat, lon, km] = p;
        const { x, y } = project(lat, lon);
        const r = km > 0 ? km / KM_PER_DEG_LAT / degPerUnitY : 0;
        return (
          <g key={`${label}-${i}`}>
            {r > 0 && <circle className="rpt-cr-zonemap-ring" cx={x} cy={y} r={r} />}
            {/* The centre dot stays a fixed size regardless of the radius —
                a 1-mile circle is nearly invisible at country scale, and the
                dot is what says "here" when the ring is too small to read. */}
            <circle className="rpt-cr-zonemap-dot" cx={x} cy={y} r={h / 90} />
          </g>
        );
      })}
    </svg>
  );
}
